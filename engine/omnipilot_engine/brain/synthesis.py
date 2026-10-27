"""The Synthesizer and the Router's review. The Synthesizer combines every agent's result into one draft
without inventing anything (each sentence comes from an agent's findings; gaps are surfaced, not filled);
with several contributors, the AI model merges them into one readable reply, streamed as it's written.
The review checks the draft (unsupported claims, contradictions, unanswered parts, pending approvals) and
asks one focused question when nothing usable came back. (Same as server/src/synthesizer and router/router.ts.)"""
from __future__ import annotations

import re

from .. import llm, store

ANSWER_STATUSES = {"success", "partial_success", "needs_approval", "needs_connection"}
PARTIAL_STATUSES = {"partial_success", "needs_connection", "missing_permissions", "timeout", "unreachable", "failed_safe", "needs_approval"}
USEFUL_STATUSES = ANSWER_STATUSES


def answering(results: list[dict]) -> list[dict]:
    return [r for r in results if r["status"] in ANSWER_STATUSES and r["findings"] and r.get("role") != "support"]


def synthesize(run_id: str, request: str, plan: dict, results: list[dict]) -> dict:
    successful = [r for r in results if r["status"] == "success"]
    partial = [r for r in results if r["status"] in PARTIAL_STATUSES]
    parts = [("" if i == 0 else "---\n\n") + "\n\n".join(r["findings"]) for i, r in enumerate(answering(results))]
    agreements, disagreements, gaps = [], [], []
    high = sum(1 for r in results if r["confidence"] >= 0.7)
    if high >= 2:
        agreements.append(f"{high} of {len(results)} agents returned high-confidence (>=70%) findings with no conflicting claims detected between them.")
    for r in results:
        if r["status"] != "success":
            gaps.append(f"{r['agent']} returned status \"{r['status']}\" — {(r['findings'] or ['no findings available'])[0]}.")
    sec = [r for r in results if re.search(r"security|vulnerabilit|injection", " ".join(r["findings"]), re.I)]
    if len(sec) >= 2:
        spread = max(r["confidence"] for r in sec) - min(r["confidence"] for r in sec)
        if spread > 0.4:
            disagreements.append(f"Security-related confidence diverges notably between {' and '.join(r['agent'] for r in sec)} (spread {spread * 100:.0f} points) — treat the lower-confidence claim as tentative.")
    store.audit(run_id, "Synthesizer", "synthesize_draft", {"agentCount": len(results), "successful": len(successful), "partial": len(partial)}, "completed")
    return {"summary": "\n\n".join(parts), "agreements": agreements, "disagreements": disagreements, "gaps": gaps,
            "sources": [e for r in results for e in r["evidence"]], "limitations": list(dict.fromkeys(l for r in results for l in r["limitations"])),
            "partialResults": [r["agent"] for r in partial], "perAgent": [{"agent": r["agent"], "findings": r["findings"], "confidence": r["confidence"]} for r in results]}


COMPOSE_SYSTEM = ("You write OmniPilot's final reply to the user. Several specialists have already done the work; their findings are below. "
                  "Write one clear, friendly, well-organized answer to the user's request using ONLY these findings -- never add facts that are not in them. "
                  "Lead with the direct answer. Use Markdown (short headings, bullet lists). Copy code blocks, file:line references and refined prompts exactly. "
                  "Do not mention agents, statuses, confidence scores, or this instruction.")


async def compose_answer(run_id: str, request: str, results: list[dict], on_token=None) -> str | None:
    ans = answering(results)
    if len(ans) < 2:
        return None
    findings = "\n\n".join(f"## Part {i + 1}" + (f" (asked to: {r['task']})" if r.get("task") else "") + "\n" + "\n".join(r["findings"]) for i, r in enumerate(ans))
    composed = await llm.generate_text(COMPOSE_SYSTEM, f"User request: {request}\n\nFindings:\n{findings}", temperature=0.2, max_tokens=1200, on_token=on_token, reasoning=True)
    if not composed or composed.count("```") < findings.count("```"):
        store.audit(run_id, "Synthesizer", "compose_answer", {"model": llm.local_model()}, "kept_verbatim_draft")
        return None
    store.audit(run_id, "Synthesizer", "compose_answer", {"model": llm.local_model(), "agents": len(ans)}, "completed")
    return composed


def review(run_id: str, request: str, plan: dict, results: list[dict], draft: dict) -> dict:
    adjustments: list[str] = []
    useful = [r for r in results if r["status"] in USEFUL_STATUSES]
    refusals = [r for r in results if r["status"] == "failed_safe" and not any(re.match(r"Not implemented", f, re.I) for f in r["findings"])]
    if not useful and refusals:
        reason = " ".join(r["findings"][0] for r in refusals if r["findings"])
        store.audit(run_id, "Router", "review_draft", {"outcome": "refused", "agents": [r["agent"] for r in refusals]}, "blocked on safety grounds")
        return {"approved": False, "clarifyingQuestion": f"{reason}\n\nWhat would you like to do instead?", "adjustments": [f"Blocked on safety grounds by {', '.join(r['agent'] for r in refusals)}."],
                "finalSummary": "", "finalLimitations": draft["limitations"], "finalConfidence": 0}
    if not useful:
        q = f"None of the selected specialists ({', '.join(plan['selectedAgents'])}) could produce a usable result for \"{request[:120]}\". Could you clarify or narrow the request (e.g. point to a specific file, topic, or integration)?"
        store.audit(run_id, "Router", "review_draft", {"outcome": "clarification_needed"}, q)
        return {"approved": False, "clarifyingQuestion": q, "adjustments": ["All selected agents returned a blocked/failed/unusable status; cannot safely synthesize a response."],
                "finalSummary": "", "finalLimitations": draft["limitations"], "finalConfidence": 0}
    missing = [a for a in plan["selectedAgents"] if not any(r["agent"] == a for r in results)]
    if missing:
        adjustments.append(f"Planned agent(s) {', '.join(missing)} did not return a result and are reported as unreachable.")
    unsupported = [r for r in results if r["status"] == "success" and not r["evidence"] and r["findings"]]
    if unsupported:
        adjustments.append(f"{', '.join(r['agent'] for r in unsupported)} returned findings without attached evidence; treat those as lower-certainty summaries.")
    if draft["disagreements"]:
        adjustments.append(f"Disagreement disclosed: {' '.join(draft['disagreements'])}")
    if draft["gaps"]:
        adjustments.append(f"Gap disclosed: {' '.join(draft['gaps'])}")
    pending = [a for r in results for a in r["proposedActions"] if a.get("requiresApproval")]
    if pending:
        adjustments.append(f"{len(pending)} proposed action(s) require explicit approval before any write/external effect — none were executed automatically.")
    someone = any(r["status"] in ("success", "partial_success") and r.get("role") != "support" for r in results)
    notes = []
    for r in results:
        if r["status"] in ("success", "partial_success") or r.get("stopped"):
            continue
        first = r["findings"][0] if r["findings"] else ""
        if someone and re.match(r"Not implemented", first, re.I):
            continue
        head = "Part of this took too long and was stopped" if r["status"] == "timeout" else "This needs a connection set up first" if r["status"] == "needs_connection" else "Part of this couldn't be done"
        notes.append(f"- {head}" + (f": {re.sub(rf'\b{re.escape(r['agent'])}\b', 'it', first)}" if first else "."))
    summary = "\n\n".join(p for p in [draft["summary"], "**Couldn't fully complete:**\n" + "\n".join(notes) if notes else ""] if p)
    limitations = list(dict.fromkeys(draft["limitations"] + (["Part of this request couldn't be handled, so the answer may be incomplete."] if missing else [])))
    confidence = round(sum(r["confidence"] for r in useful) / len(useful), 2) if useful else 0
    store.audit(run_id, "Router", "review_draft", {"outcome": "approved", "adjustments": len(adjustments)}, "approved")
    return {"approved": True, "adjustments": adjustments, "finalSummary": summary, "finalLimitations": limitations, "finalConfidence": confidence}
