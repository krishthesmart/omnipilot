"""The Coordinator: where the Router decides who is needed, this decides what each one does and in what
order: (1) split the request into clauses and give each agent only its part, (2) agents that build on
another's output wait for it, (3) run in waves (everything ready runs in parallel), (4) reflect once on
what came back, (5) cover any agent's gap with Helper. (Same as server/src/coordinator.ts.)"""
from __future__ import annotations

import asyncio
import re

from .. import llm, store
from . import control
from .events import bus
from .routing import keyword_scores
from .specs import AGENT_NAMES, REVIEW_INTENT, SPECS, owner, rx, skill_of

SYNTHESIS_CLAUSE = rx(r"^(and\s+)?(then\s+)?(summari[sz]e|combine|wrap up|give me (a|the) summary)\b")
NEW_INSTRUCTION = rx(r"^(and\s+)?(then\s+)?(also\s+)?(what|how|why|when|where|who|which|is|are|can|could|would|do|does|explain|tell|write|give|list|find|show me how|teach|help|make|create|check|compare|summari[sz]e|translate|solve|calculate)\b")
CANNOT_HANDLE = rx(r"^(Not implemented|Code generation needs the AI model)")
FAILED_STATUSES = {"timeout", "unreachable"}
CODE_FILE = re.compile(r"\.(js|ts|jsx|tsx|py|go)(:\d+)?$")
_KEEP = re.compile(r"```[\s\S]*?```|`[^`]*`|\"[^\"\n]*\"|“[^”\n]*”")


def split_clauses(text: str) -> list[str]:
    """A compound request's parts; code in backticks and quoted text stay whole."""
    kept: list[str] = []

    def mask(m):
        kept.append(m.group(0))
        return f"\x00{len(kept) - 1}\x00"

    masked = _KEEP.sub(mask, text)
    parts = re.split(r",|\band\b", masked, flags=re.I | re.A)
    out = [re.sub(r"\x00(\d+)\x00", lambda m: kept[int(m.group(1))], p).strip() for p in parts]
    return [p for p in out if len(p) > 2]


def plan_steps(text: str, selected: list[str]) -> list[dict]:
    workers = [a for a in selected if a != "PromptPilot"]
    clauses: list[str] = []
    for c in split_clauses(text):
        if clauses and len(c.split()) < 3:
            clauses[-1] += f" and {c}"
        else:
            clauses.append(c)
    assigned: dict[str, list[str]] = {}
    orphans: list[str] = []
    previous: list[str] = []
    for clause in ([] if workers == ["Helper"] else clauses):
        if SYNTHESIS_CLAUSE.search(clause):
            continue
        scores = keyword_scores(clause)
        owners = [a for a in workers if scores[a] > 0]
        if not owners and re.search(r"\b(it|its|them|that|this|these|those)\b", clause, re.I | re.A):
            owners = previous
        if not owners and any(SPECS[a].describes_one_thing for a in previous) and not NEW_INSTRUCTION.search(clause):
            owners = previous
        if not owners and previous and not NEW_INSTRUCTION.search(clause):
            owners = previous
        if not owners:
            orphans.append(clause)
        for a in owners:
            assigned.setdefault(a, []).append(clause)
        previous = owners
    steps = []
    for agent in workers:
        parts = assigned.get(agent)
        task = (" and " if SPECS[agent].describes_one_thing else "; ").join(parts) if parts else text.strip()
        deps = [d for d in SPECS[agent].builds_on if d.agent in workers and (d.when is None or d.when.search(task) or d.when.search(text))]
        reason = "; ".join(d.reason for d in deps) if deps else (f"handles: {'; '.join(parts)}" if parts else "handles the whole request")
        steps.append({"agent": agent, "task": task, "dependsOn": [d.agent for d in deps], "reason": reason})
    if orphans and assigned:
        helper = next((s for s in steps if s["agent"] == "Helper"), None)
        helper_first = any("Helper" in s["dependsOn"] for s in steps)
        extra = {"agent": "Helper", "task": "; ".join(orphans), "dependsOn": [], "reason": f"covers the part no other specialist claimed: {'; '.join(orphans)}", "afterAll": True}
        if helper and helper_first:
            steps.append(extra)
        elif helper:
            helper.update(task="; ".join([helper["task"], *orphans]), afterAll=True)
        else:
            steps.append(extra)
    if "PromptPilot" in selected:
        steps.insert(0, {"agent": "PromptPilot", "task": text.strip(), "dependsOn": [], "reason": "decomposes the request into per-specialist prompts"})
    return steps


def shown_step(step: dict) -> dict:
    """A step as people see it: the specialist's name, with the skill it uses."""
    skill = skill_of(step["agent"])
    return {**step, "agent": owner(step["agent"]), "dependsOn": list(dict.fromkeys(owner(d) for d in step["dependsOn"] if owner(d) != owner(step["agent"]))),
            **({"skill": skill} if skill else {})}


def shown_steps(steps: list[dict]) -> list[dict]:
    """One shown step per specialist (its own step and its skills' steps are listed together)."""
    out: dict[str, dict] = {}
    for st in map(shown_step, steps):
        a = st["agent"]
        if a not in out:
            out[a] = st
            continue
        prev = out[a]
        out[a] = {**prev, "task": "; ".join(dict.fromkeys(t for t in (prev["task"], st["task"]) if t)),
                  "dependsOn": list(dict.fromkeys(prev["dependsOn"] + st["dependsOn"])), "reason": "; ".join(dict.fromkeys((prev["reason"], st["reason"]))),
                  **({"skill": ", ".join(x for x in dict.fromkeys((prev.get("skill"), st.get("skill"))) if x)} if prev.get("skill") or st.get("skill") else {})}
    return list(out.values())


def fold_results(done: dict) -> list[dict]:
    """One result per specialist: a specialist's own result and its skills' results are merged."""
    out: dict[str, dict] = {}
    for r in done.values():
        a = r["agent"]
        if a in out:
            merged = merge_results(out[a], r)
            merged["skill"] = ", ".join(x for x in dict.fromkeys([out[a].get("skill"), r.get("skill")]) if x) or None
            out[a] = {k: v for k, v in merged.items() if not (k == "skill" and v is None)}
        else:
            out[a] = r
    return list(out.values())


def merge_results(a: dict, b: dict) -> dict:
    ok = lambda r: r["status"] in ("success", "partial_success")
    status = "success" if a["status"] == "success" and b["status"] == "success" else ("partial_success" if ok(a) or ok(b) else b["status"])
    return {**a, "status": status, "findings": a["findings"] + b["findings"], "evidence": a["evidence"] + b["evidence"],
            "confidence": min(a["confidence"], b["confidence"]), "limitations": list(dict.fromkeys(a["limitations"] + b["limitations"])),
            "proposedActions": a["proposedActions"] + b["proposedActions"], "attachments": (a.get("attachments") or []) + (b.get("attachments") or []),
            "task": "; ".join(t for t in (a.get("task"), b.get("task")) if t), "completedAt": b["completedAt"],
            "elapsedMs": a["elapsedMs"] + b["elapsedMs"], "retries": max(a["retries"], b["retries"])}


def _prior(r: dict) -> dict:
    return {"agent": r["agent"], "task": r.get("task"), "findings": r["findings"], "evidence": r["evidence"]}


def step_input(base: dict, step: dict, done: dict) -> dict:
    prior = [done[a] for a in step["dependsOn"] if a in done]
    return {**base, "requestText": step["task"], "context": {**base["context"], "originalRequest": base["requestText"], "priorResults": [_prior(r) for r in prior]}}


def _blocked(results) -> bool:
    return any(r["status"] == "failed_safe" and not any(CANNOT_HANDLE.search(f) for f in r["findings"]) for r in results)


async def coordinate(base: dict, steps: list[dict], run_agent) -> list[dict]:
    """run_agent(agent, input, annotations) -> result (the orchestrator's isolated runner)."""
    run_id = base["runId"]
    done: dict[str, dict] = {}
    pending = [s for s in steps if not s.get("afterAll")]
    while pending and not control.is_cancelled(run_id):
        in_plan = {s["agent"] for s in pending}
        ready = [s for s in pending if all(d in done or d not in in_plan for d in s["dependsOn"])]
        wave = ready or pending
        pending = [s for s in pending if s not in wave]
        store.audit(run_id, "System", "coordinator_wave", {"agents": list(dict.fromkeys(owner(s["agent"]) for s in wave))}, "started")
        results = await asyncio.gather(*[run_agent(s["agent"], step_input(base, s, done), {"task": s["task"], "usedResultsFrom": list(dict.fromkeys(owner(d) for d in s["dependsOn"] if d in done))}) for s in wave])
        for s, r in zip(wave, results, strict=True):
            done[s["agent"]] = r  # kept per ability (a specialist and one of its skills can both have a step)
    if control.is_cancelled(run_id):
        return fold_results(done)
    if _blocked(done.values()):
        store.audit(run_id, "System", "coordinator_followup", {}, "skipped: a specialist blocked the request on safety grounds")
        return fold_results(done)

    nxt = await reflect(base, done)
    if nxt:
        bus.publish({"type": "coordinator_followup", "runId": run_id, "step": shown_step(nxt)})
        store.audit(run_id, "System", "coordinator_reflect", {"agent": owner(nxt["agent"]), "task": nxt["task"], "reason": nxt["reason"]}, "added_step")
        done[nxt["agent"]] = await run_agent(nxt["agent"], step_input(base, nxt, done), {"task": nxt["task"], "usedResultsFrom": list(dict.fromkeys(owner(d) for d in nxt["dependsOn"]))})

    for step in [s for s in steps if s.get("afterAll")]:
        r = await run_agent(step["agent"], step_input(base, step, done), {"task": step["task"]})
        done[step["agent"]] = merge_results(done[step["agent"]], r) if step["agent"] in done else r

    if "Helper" not in done:
        if all(r.get("role") == "support" for r in done.values()):
            step = {"agent": "Helper", "task": base["requestText"], "dependsOn": [], "reason": "answers directly: no specialist had a task for this request"}
            bus.publish({"type": "coordinator_followup", "runId": run_id, "step": step})
            done["Helper"] = await run_agent("Helper", step_input(base, step, done), {"task": step["task"]})
            return fold_results(done)
        gap = next((r for r in done.values() if r["agent"] != "PromptPilot" and (r["status"] in FAILED_STATUSES or any(CANNOT_HANDLE.search(f) for f in r["findings"]))), None)
        if gap:
            step = {"agent": "Helper", "task": gap.get("task") or base["requestText"], "dependsOn": [], "reason": f"covers the part {gap['agent']} couldn't handle"}
            bus.publish({"type": "coordinator_followup", "runId": run_id, "step": step})
            store.audit(run_id, "System", "coordinator_followup", {"coveringFor": gap["agent"], "task": step["task"]}, "started")
            done["Helper"] = await run_agent("Helper", step_input(base, step, done), {"task": step["task"], "coveringFor": gap["agent"]})
    return fold_results(done)


REFLECT_SYSTEM = ("You are the lead of a team of specialists. Given the user's request and what each specialist returned, decide whether part of the request is still unanswered. "
                  "If it is, name the ONE specialist who should handle the missing part and give them a short task. If everything was answered, say complete. "
                  "Specialists: " + "; ".join(f"{a} ({SPECS[a].description})" for a in AGENT_NAMES))
REFLECT_SCHEMA = {"type": "object", "properties": {"complete": {"type": "boolean"}, "next_agent": {"type": "string", "enum": [*AGENT_NAMES, "none"]}, "task": {"type": "string"}}, "required": ["complete", "next_agent", "task"]}


async def reflect(base: dict, done: dict) -> dict | None:
    results = list(done.values())
    if _blocked(results):
        return None
    helper, code = done.get("Helper"), done.get("CodePilot")
    if helper and (not code or code.get("role") == "support") and REVIEW_INTENT.search(base["requestText"]) and any(CODE_FILE.search(e["source"]) for e in helper["evidence"]):
        return {"agent": "CodePilot", "task": base["requestText"], "dependsOn": ["Helper"], "reason": "reviews the code files Helper found"}
    if len(done) >= 4:
        return None
    # Rewriting a prompt: what the prompt asks for ("write an essay about dogs") isn't a task to do now.
    if set(done) == {"PromptPilot"}:
        return None
    if helper and helper["status"] == "success" and any(e["source"].startswith("web:") for e in helper["evidence"]):
        return None
    answered = "\n".join(f"[{r['agent']}{' -- ' + r['task'] if r.get('task') else ''}] {' '.join(r['findings'])[:600]}" for r in results if r.get("role") != "support" and r["findings"])
    r = await llm.generate_json(REFLECT_SYSTEM, f"User request: {base['requestText']}\n\nWhat the specialists returned:\n{answered or '(nothing)'}", schema=REFLECT_SCHEMA, temperature=0.2, max_tokens=120)
    if not isinstance(r, dict) or r.get("complete") or r.get("next_agent") in (None, "none") or r.get("next_agent") not in AGENT_NAMES:
        return None
    agent = r["next_agent"]
    on_topic = keyword_scores(base["requestText"])[agent] > 0
    if agent in done or ((SPECS[agent].narrow or agent in ("PromptPilot", "CodePilot")) and not on_topic):
        return None
    return {"agent": agent, "task": str(r.get("task") or "").strip() or base["requestText"], "dependsOn": [k for k, x in done.items() if x.get("role") != "support"],
            "reason": "added after reviewing the first results: part of the request was still unanswered"}
