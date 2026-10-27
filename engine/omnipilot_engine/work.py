"""Tasks, Outcome Contracts, persisted runs, Evidence Receipts and Recovery Mode (docs/product, slices 3-4).

A task is a unit of work inside a project, with an Outcome Contract: goal, constraints, the approvals it needs,
what's out of scope, and acceptance checks. Each time it runs is an *attempt* (task_runs), made of *steps*
(run_steps) derived from what actually happened: the Router's decision, each specialist, each proposed change.

Rules kept in the backend:
  - An acceptance check is marked passed only by a person, and only with an evidence receipt from the same
    project whose result is "supports". Agents can't mark anything passed.
  - Evidence receipts say what kind of evidence they are and which version of an artifact they concern. Only a
    test that actually passed in the sandbox counts as supporting evidence automatically; everything else an
    agent offers is recorded as inconclusive.
  - Steps that change something (writes=1) carry an idempotency key (the approval id). Resuming never repeats a
    change that already ran or is still waiting: a duplicate (same payload fingerprint) is set aside.
  - When OmniPilot restarts, attempts that were running become "interrupted", and actions that were in flight
    become "uncertain" until a person checks the service and records what happened.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import uuid

from . import actions, patches, projects, store
from .projects import OWNER, ProjectError

STATUSES = ("pending", "running", "awaiting_approval", "blocked", "completed", "failed", "cancelled", "interrupted")
CHECK_STATES = ("pending", "passed", "failed", "blocked", "not_applicable")
EVIDENCE_KINDS = ("source", "file", "test", "tool_output", "observation", "human")
RESULTS = ("supports", "contradicts", "inconclusive")
STAGES = ("none", "proposed", "applied", "tested")
OK_STATUSES = ("success", "partial", "partial_success", "needs_approval")  # an agent that answered (possibly with stated limits)
RUN_STATUS = {"completed": "completed", "needs_approval": "awaiting_approval", "failed": "failed", "cancelled": "cancelled", "needs_clarification": "blocked"}
_tasks: set = set()  # background attempts (kept referenced until they finish)


def _now() -> str:
    return store.now()


def _settle(run_id: str | None) -> None:
    """A run that no longer has anything waiting shouldn't keep saying "needs approval"."""
    from . import approvals

    if run_id:
        approvals.settle_run(run_id)


def _text(value, field: str, limit: int, required: bool = False) -> str:
    return projects._clean_text(value, field, limit, required)


def _list(value, field: str) -> list[str]:
    return projects._clean_list(value, field)


# --- tasks and their contracts ---


def _task(r: dict) -> dict:
    return {**r, **{k: json.loads(r[k]) for k in ("constraints", "required_approvals", "out_of_scope")}}


def create_task(project_id: str, data: dict, actor: str = OWNER) -> dict:
    projects.require(project_id, "write", actor)
    tid, now = str(uuid.uuid4()), _now()
    title = _text(data.get("title"), "title", 200, required=True)
    goal = _text(data.get("goal"), "goal", 2000)
    request = _text(data.get("request"), "request", 4000) or goal or title
    acceptance = _list(data.get("acceptance"), "acceptance")
    store.x("INSERT INTO project_tasks (id, project_id, title, goal, constraints, required_approvals, out_of_scope, request, owner, reviewer, recipe_id, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            tid, project_id, title, goal, json.dumps(_list(data.get("constraints"), "constraints")), json.dumps(_list(data.get("requiredApprovals"), "requiredApprovals")),
            json.dumps(_list(data.get("outOfScope"), "outOfScope")), request, _text(data.get("owner"), "owner", 80) or actor,
            _text(data.get("reviewer"), "reviewer", 80) or None, data.get("recipeId") if isinstance(data.get("recipeId"), str) else None, now, now)
    for text in acceptance:
        store.x("INSERT INTO acceptance_checks (id, task_id, project_id, text, requirement, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                str(uuid.uuid4()), tid, project_id, text, None, actor, now)
    projects.record(project_id, "task_created", f"Task created: {title}", {"taskId": tid}, actor=actor)
    return get_task(project_id, tid, actor)


def _task_row(project_id: str, task_id: str) -> dict:
    row = store.q1("SELECT * FROM project_tasks WHERE id = ? AND project_id = ?", task_id, project_id)
    if not row:
        raise ProjectError(404, "not_found", "No such task in this project.")
    return row


def tasks(project_id: str, actor: str = OWNER) -> list[dict]:
    projects.require(project_id, "read", actor)
    out = []
    for r in store.q("SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at DESC", project_id):
        checks = store.q("SELECT state FROM acceptance_checks WHERE task_id = ?", r["id"])
        out.append({**_task(r), "checks": {s: sum(1 for c in checks if c["state"] == s) for s in CHECK_STATES},
                    "attempts": store.q1("SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ?", r["id"])["n"]})
    return out


def get_task(project_id: str, task_id: str, actor: str = OWNER) -> dict:
    projects.require(project_id, "read", actor)
    t = _task(_task_row(project_id, task_id))
    t["acceptance"] = store.q("SELECT * FROM acceptance_checks WHERE task_id = ? ORDER BY rowid", task_id)
    t["attempts"] = [{**a, "usage": json.loads(a["usage"]), "steps": steps(a["id"])}
                     for a in store.q("SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt DESC", task_id)]
    t["evidence"] = evidence(project_id, task_id=task_id, actor=actor)
    return t


def update_task(project_id: str, task_id: str, data: dict, actor: str = OWNER) -> dict:
    projects.require(project_id, "write", actor)
    row = _task_row(project_id, task_id)
    if row["status"] == "running":
        raise ProjectError(409, "running", "Stop the task before changing its contract.")
    sets: dict = {}
    for key, col, limit in (("title", "title", 200), ("goal", "goal", 2000), ("request", "request", 4000)):
        if key in data:
            sets[col] = _text(data[key], key, limit, required=key == "title")
    for key, col in (("constraints", "constraints"), ("requiredApprovals", "required_approvals"), ("outOfScope", "out_of_scope")):
        if key in data:
            sets[col] = json.dumps(_list(data[key], key))
    for key in ("owner", "reviewer"):
        if key in data:
            sets[key] = _text(data[key], key, 80) or (actor if key == "owner" else None)
    if sets:
        store.x(f"UPDATE project_tasks SET {', '.join(f'{c} = ?' for c in sets)}, updated_at = ? WHERE id = ?", *sets.values(), _now(), task_id)
        projects.record(project_id, "task_updated", f"Task contract changed: {row['title']}", {"taskId": task_id, "fields": list(sets)}, actor=actor)
        if any(c in sets for c in ("goal", "constraints", "out_of_scope")):
            from . import radar

            radar.on_requirement_change(project_id, "task", task_id, row["title"])
    for text in _list(data.get("addAcceptance"), "addAcceptance"):
        store.x("INSERT INTO acceptance_checks (id, task_id, project_id, text, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)", str(uuid.uuid4()), task_id, project_id, text, actor, _now())
    return get_task(project_id, task_id, actor)


def _set_status(task_id: str, status: str) -> None:
    store.x("UPDATE project_tasks SET status = ?, updated_at = ? WHERE id = ?", status, _now(), task_id)


# --- acceptance checks ---


def set_check(project_id: str, check_id: str, state: str, evidence_id: str | None = None, note: str = "", actor: str = OWNER, actor_type: str = "human") -> dict:
    projects.require(project_id, "write", actor)
    check = store.q1("SELECT * FROM acceptance_checks WHERE id = ? AND project_id = ?", check_id, project_id)
    if not check:
        raise ProjectError(404, "not_found", "No such acceptance check in this project.")
    if state not in CHECK_STATES:
        raise ProjectError(400, "invalid_request", f"state must be one of: {', '.join(CHECK_STATES)}")
    ev = None
    if evidence_id:
        ev = store.q1("SELECT * FROM evidence_receipts WHERE id = ? AND project_id = ?", evidence_id, project_id)
        if not ev:
            raise ProjectError(404, "not_found", "No such evidence receipt in this project.")
    if state == "passed":
        if actor_type != "human":
            raise ProjectError(403, "forbidden", "Only a person can mark an acceptance check passed.")
        if not ev or ev["result"] != "supports":
            raise ProjectError(409, "evidence_required", "A check can only pass with an evidence receipt from this project that supports it.")
    if state == "failed" and ev and ev["result"] == "supports":
        raise ProjectError(409, "evidence_mismatch", "That evidence supports the check; pick evidence that contradicts it, or none.")
    store.x("UPDATE acceptance_checks SET state = ?, evidence_id = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?",
            state, evidence_id, _text(note, "note", 1000), actor, _now(), check_id)
    projects.record(project_id, "check_updated", f"Acceptance check {state.replace('_', ' ')}: {check['text'][:120]}", {"checkId": check_id, "evidenceId": evidence_id}, actor=actor, actor_type=actor_type)
    if evidence_id:
        from . import radar

        radar.link(project_id, "evidence", evidence_id, "check", check_id, "evidence for an acceptance check", actor)
    return store.q1("SELECT * FROM acceptance_checks WHERE id = ?", check_id)


# --- evidence receipts ---


def add_evidence(project_id: str, data: dict, actor: str = OWNER, actor_type: str = "human", task_id: str | None = None, run_id: str | None = None) -> dict:
    """Records what supports (or contradicts) a claim. File evidence pins the file's checksum at the time."""
    # Agents and the system record evidence on the owner's behalf during a run the owner started.
    projects.require(project_id, "write", actor if actor_type == "human" else OWNER, allow_archived=actor_type != "human")
    kind = data.get("kind")
    result = data.get("result")
    stage = data.get("changeStage") or "none"
    if kind not in EVIDENCE_KINDS or result not in RESULTS or stage not in STAGES:
        raise ProjectError(400, "invalid_request", "kind, result or changeStage is not valid.")
    if actor_type == "agent" and result == "supports" and kind != "test":
        result = "inconclusive"  # an agent's say-so isn't proof; only a passing test supports automatically
    task_id = task_id or (data.get("taskId") if isinstance(data.get("taskId"), str) else None)
    if task_id:
        _task_row(project_id, task_id)
    artifact = _text(data.get("artifact"), "artifact", 300)
    sha = data.get("artifactSha256") if isinstance(data.get("artifactSha256"), str) else None
    if artifact and not sha:  # evidence about a project file is pinned to the version it was about
        f = store.q1("SELECT sha256 FROM project_files WHERE project_id = ? AND name = ?", project_id, artifact)
        sha = f["sha256"] if f else None
    eid = str(uuid.uuid4())
    store.x("INSERT INTO evidence_receipts (id, project_id, task_id, run_id, kind, claim, source, artifact, artifact_sha256, change_stage, result, limitations, detail, actor, actor_type, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            eid, project_id, task_id, run_id, kind, _text(data.get("claim"), "claim", 500, required=True), _text(data.get("source"), "source", 300), artifact, sha, stage, result,
            _text(data.get("limitations"), "limitations", 1000), _text(data.get("detail"), "detail", 4000), actor, actor_type, _now())
    projects.record(project_id, "evidence_added", f"Evidence ({result}): {str(data.get('claim'))[:120]}", {"evidenceId": eid, "taskId": task_id}, actor=actor, actor_type=actor_type)
    return store.q1("SELECT * FROM evidence_receipts WHERE id = ?", eid)


def evidence(project_id: str, task_id: str | None = None, actor: str = OWNER) -> list[dict]:
    projects.require(project_id, "read", actor)
    rows = store.q("SELECT * FROM evidence_receipts WHERE project_id = ? AND (? IS NULL OR task_id = ?) ORDER BY created_at DESC", project_id, task_id, task_id)
    out = []
    for r in rows:
        stale = None
        if r["artifact"] and r["artifact_sha256"]:
            f = store.q1("SELECT sha256 FROM project_files WHERE project_id = ? AND name = ?", project_id, r["artifact"])
            stale = (not f) or f["sha256"] != r["artifact_sha256"]
        out.append({**r, "artifact_changed": stale})
    return out


# --- runs: attempts and steps ---


def steps(task_run_id: str) -> list[dict]:
    return [{**s, "input": json.loads(s["input"]), "output": json.loads(s["output"])} for s in store.q("SELECT * FROM run_steps WHERE task_run_id = ? ORDER BY seq", task_run_id)]


def _add_step(task_run_id: str, kind: str, name: str, status: str, *, writes: bool = False, key: str | None = None, input: dict | None = None,
              output: dict | None = None, error: str = "", external_id: str | None = None) -> str:
    sid = str(uuid.uuid4())
    seq = store.q1("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM run_steps WHERE task_run_id = ?", task_run_id)["n"]
    store.x("INSERT INTO run_steps (id, task_run_id, seq, kind, name, status, writes, idempotency_key, input, output, error, external_id, started_at, finished_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            sid, task_run_id, seq, kind, name, status, int(writes), key, json.dumps(input or {}, ensure_ascii=False)[:8000],
            json.dumps(output or {}, ensure_ascii=False)[:8000], error[:1000], external_id, _now(), None if status in ("running", "awaiting_approval") else _now())
    return sid


def contract_message(t: dict, checks: list[dict]) -> str:
    """The request the specialists receive: the task and its Outcome Contract, stated plainly."""
    lines = [f"Task: {t['title']}"]
    if t["goal"]:
        lines.append(f"Goal: {t['goal']}")
    for label, items in (("Constraints", t["constraints"]), ("Out of scope (don't do these)", t["out_of_scope"]),
                         ("Needs approval before", t["required_approvals"]), ("Done when", [c["text"] for c in checks])):
        if items:
            lines.append(f"{label}:\n" + "\n".join(f"- {i}" for i in items))
    if t["request"] and t["request"] not in (t["goal"], t["title"]):
        lines.append(f"Request: {t['request']}")
    return "\n".join(lines)[:4000]


def start_task(project_id: str, task_id: str, actor: str = OWNER, retry_of: str | None = None) -> dict:
    """Starts a new attempt: a project-scoped run with the task's contract. Returns the attempt."""
    from . import llm
    from .brain import pipeline

    scope = projects.run_scope(project_id, actor)
    t = _task(_task_row(project_id, task_id))
    if t["status"] == "running":
        raise ProjectError(409, "running", "This task is already running.")
    checks = store.q("SELECT text FROM acceptance_checks WHERE task_id = ? ORDER BY rowid", task_id)
    attempt = store.q1("SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM task_runs WHERE task_id = ?", task_id)["n"]
    trid = str(uuid.uuid4())
    store.x("INSERT INTO task_runs (id, task_id, project_id, attempt, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)", trid, task_id, project_id, attempt, _now())
    _set_status(task_id, "running")
    from .tools import base as tool_base

    usage: list = []
    tools: list = []
    token = llm.usage_sink.set(usage)  # the run's background task copies these, so its calls land in the lists
    ttoken = tool_base.tool_usage_sink.set(tools)
    try:
        run_id, task = pipeline.start(contract_message(t, checks), {"task": {"id": task_id, "title": t["title"]}}, None, None, scope)
    finally:
        tool_base.tool_usage_sink.reset(ttoken)
        llm.usage_sink.reset(token)
    store.x("UPDATE task_runs SET run_id = ? WHERE id = ?", run_id, trid)
    projects.record(project_id, "task_started", f"Task started (attempt {attempt}): {t['title']}", {"taskId": task_id, "taskRunId": trid, "runId": run_id, "resumeOf": retry_of}, actor=actor)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    task.add_done_callback(lambda fut: _finish_safely(trid, fut, usage, tools))
    return store.q1("SELECT * FROM task_runs WHERE id = ?", trid)


def _finish_safely(trid: str, fut, usage: list, tools: list) -> None:
    try:
        record = fut.result() if not fut.cancelled() else {"status": "cancelled"}
    except Exception as err:  # noqa: BLE001 -- the attempt is marked failed, never left running
        record = {"status": "failed", "error": str(err)[:300]}
    finish_attempt(trid, record, usage, tools)


def summarize_usage(usage: list) -> dict:
    """Model calls, time and tokens for a run. Token counts the provider didn't report are 'unavailable'."""
    known_p = [u["promptTokens"] for u in usage if u.get("promptTokens") is not None]
    known_c = [u["completionTokens"] for u in usage if u.get("completionTokens") is not None]
    costs = [u["costUsd"] for u in usage if u.get("costUsd") is not None]
    full = bool(usage) and len(known_p) == len(usage)
    return {"modelCalls": len(usage), "local": sum(1 for u in usage if u["where"] == "local"), "groq": sum(1 for u in usage if u["where"] == "groq"),
            "modelMs": sum(u.get("ms") or 0 for u in usage), "promptTokens": sum(known_p) if full else None, "completionTokens": sum(known_c) if full else None,
            "tokensNote": "complete" if full else ("partly unavailable" if known_p else "unavailable"),
            "modelCostUsd": sum(costs) if len(costs) == len(usage) else None,
            "costNote": "local model: no charge" if len(costs) == len(usage) else "Groq calls are not priced here (free tier); cost unavailable"}


def finish_attempt(trid: str, record: dict, usage: list | None = None, tools: list | None = None) -> None:
    """Turns what the run did into recorded steps and evidence, and settles the attempt's status."""
    tr = store.q1("SELECT * FROM task_runs WHERE id = ?", trid)
    if not tr or tr["status"] not in ("running",):
        return
    project_id, task_id = tr["project_id"], tr["task_id"]
    plan = record.get("plan") or {}
    router = (plan.get("router") or {}).get("label", "")
    if plan:
        _add_step(trid, "route", "Router", "completed", input={"request": record.get("request", "")[:500]},
                  output={"agents": plan.get("selectedAgents"), "mode": plan.get("routingMode"), "router": plan.get("router")})
    tool_log = list(tools or [])
    for r in record.get("agentResults") or []:
        ok = r.get("status") in OK_STATUSES
        _add_step(trid, "agent", r.get("agent", "?"), "completed" if ok else "failed",
                  output={"findings": [str(f)[:500] for f in (r.get("findings") or [])][:5], "confidence": r.get("confidence"), "status": r.get("status")},
                  error="" if ok else "; ".join(str(x) for x in (r.get("limitations") or []))[:500] or str(r.get("status")))
        for ev in r.get("evidence") or []:
            _auto_evidence(project_id, task_id, tr["run_id"], r.get("agent", "?"), ev)
    duplicates = _earlier_actions(task_id, trid)
    awaiting = 0
    for r in record.get("agentResults") or []:
        for a in r.get("proposedActions") or []:
            if not a.get("requiresApproval"):
                continue
            pa = actions.get_action(a["id"])
            fingerprint = pa["payload_sha256"] if pa else _patch_fingerprint(a["id"])
            earlier = duplicates.get(fingerprint) if fingerprint else None
            if earlier:  # resuming: this change already ran or is already waiting; never do it twice
                actions.reject_action(a["id"])
                patches.reject_patch(a["id"])
                if store.get_approval(a["id"]):
                    store.decide_approval(a["id"], "denied")
                    _settle(tr["run_id"])
                store.audit(tr["run_id"], "System", "dedupe_action", {"approvalId": a["id"], "sameAs": earlier}, "set aside: duplicate of an earlier attempt's change")
                _add_step(trid, "action", a.get("description", "change")[:200], "completed", writes=True, key=a["id"], output={"duplicateOf": earlier}, external_id=fingerprint)
                continue
            awaiting += 1
            _add_step(trid, "action", a.get("description", "change")[:200], "awaiting_approval", writes=True, key=a["id"],
                      input={"risk": a.get("riskLevel"), "kind": pa["kind"] if pa else "code_change"}, external_id=fingerprint)
            _auto_proposed(project_id, task_id, tr["run_id"], a)
    status = RUN_STATUS.get(record.get("status"), "failed")
    if status == "awaiting_approval" and not awaiting:
        status = "completed"  # every change was a duplicate of one handled earlier
    store.x("UPDATE task_runs SET status = ?, router = ?, error = ?, usage = ?, finished_at = ? WHERE id = ?", status, router, str(record.get("error", ""))[:500],
            json.dumps({**summarize_usage(usage or []), "paidTools": tool_log, "paidToolsEstUsd": round(sum(t["est_cost_usd"] for t in tool_log), 4)}), _now(), trid)
    _set_status(task_id, status)
    t = store.q1("SELECT title FROM project_tasks WHERE id = ?", task_id)
    projects.record(project_id, "task_attempt_finished", f"Task attempt {tr['attempt']} {status.replace('_', ' ')}: {t['title'] if t else ''}",
                    {"taskId": task_id, "taskRunId": trid, "runId": tr["run_id"]}, actor="OmniPilot", actor_type="system")


def _patch_fingerprint(approval_id: str) -> str | None:
    files = patches.patch_set(approval_id)
    if not files:
        return None
    return hashlib.sha256(json.dumps(sorted((f["file"], patches.sha(f["fixed"])) for f in files)).encode()).hexdigest()


def _earlier_actions(task_id: str, current_trid: str) -> dict:
    """Fingerprints of changes from earlier attempts that ran, are waiting, or whose outcome is uncertain."""
    out = {}
    for s in store.q("SELECT s.idempotency_key, s.external_id FROM run_steps s JOIN task_runs t ON t.id = s.task_run_id "
                     "WHERE t.task_id = ? AND t.id != ? AND s.writes = 1 AND s.status IN ('completed', 'awaiting_approval', 'uncertain', 'running')", task_id, current_trid):
        if not s["external_id"]:
            continue
        a = actions.get_action(s["idempotency_key"]) if s["idempotency_key"] else None
        if a and a["status"] in ("rejected",):
            continue
        out[s["external_id"]] = s["idempotency_key"]
    return out


def _auto_evidence(project_id: str, task_id: str, run_id: str, agent: str, ev: dict) -> None:
    source = str(ev.get("source") or ev.get("ref") or "")
    detail = str(ev.get("excerpt") or ev.get("detail") or ev.get("text") or "")
    if source == "sandbox-run":  # the code's own tests passed in the OS sandbox
        kind, result, stage, lim = "test", "supports", "tested", "Tests were written by the AI model; they show the code does what those tests check, not that the tests are complete."
    elif ":" in source and source.split(":")[0] in {f["name"] for f in store.q("SELECT name FROM project_files WHERE project_id = ?", project_id)}:
        kind, result, stage, lim = "file", "inconclusive", "none", "An agent cited this file; a person hasn't checked that it supports the claim."
    elif source.startswith("ai-model:"):
        kind, result, stage, lim = "observation", "inconclusive", "none", "Model-generated; not independently verified."
    else:
        kind, result, stage, lim = "source", "inconclusive", "none", "Reported by an agent; not independently verified."
    add_evidence(project_id, {"kind": kind, "result": result, "changeStage": stage, "claim": f"{agent}: {detail[:400] or source}", "source": source,
                              "artifact": source.split(":")[0] if kind == "file" else "", "limitations": lim, "detail": detail},
                 actor=agent, actor_type="agent", task_id=task_id, run_id=run_id)


def _auto_proposed(project_id: str, task_id: str, run_id: str, a: dict) -> None:
    files = patches.patch_set(a["id"])
    for f in files[:10]:
        name = f["file"].split(f".omnipilot-projects/{project_id}/", 1)[-1]
        add_evidence(project_id, {"kind": "file", "result": "inconclusive", "changeStage": "proposed", "claim": f"Proposed change to {name}: {a.get('description', '')[:200]}",
                                  "source": f"approval:{a['id']}", "artifact": name, "artifactSha256": patches.sha(f["fixed"]),
                                  "limitations": "Not applied or tested yet."}, actor="CodePilot", actor_type="agent", task_id=task_id, run_id=run_id)


def after_approval(approval_id: str, run_id: str, decision: str, applied: dict | None, outcome: dict | None, actor: str = OWNER) -> None:
    """Called once an approval is decided: settles the matching step, records evidence, updates the task."""
    run = store.q1("SELECT project_id FROM runs WHERE id = ?", run_id)
    project_id = run and run["project_id"]
    if not project_id:
        return
    step = store.q1("SELECT s.*, t.task_id, t.id AS trid FROM run_steps s JOIN task_runs t ON t.id = s.task_run_id WHERE s.idempotency_key = ? AND s.status = 'awaiting_approval'", approval_id)
    desc = (store.get_approval(approval_id) or {}).get("description", "")
    projects.record(project_id, f"approval_{decision}", f"{'Approved' if decision == 'approved' else 'Denied'}: {desc[:150]}", {"approvalId": approval_id, "runId": run_id}, actor=actor)
    task_id = step["task_id"] if step else None
    if applied:
        root = patches.workspace_root()
        for rel in applied.get("files") or [applied.get("file")]:
            if not rel:
                continue
            path = patches.safe_workspace_path(root, rel)
            try:
                sha = patches.sha(open(path, encoding="utf-8").read()) if path else None
            except OSError:
                sha = None
            name = rel.split(f".omnipilot-projects/{project_id}/", 1)[-1]
            add_evidence(project_id, {"kind": "file", "result": "inconclusive", "changeStage": "applied", "claim": f"Change applied to {name}", "source": f"approval:{approval_id}",
                                      "artifact": name, "artifactSha256": sha, "limitations": "Applied after approval. Applying a change doesn't show it works; run its tests for that."},
                         actor=actor, actor_type="human", task_id=task_id, run_id=run_id)
        projects.sync_files(project_id)
        from . import radar

        for rel in applied.get("files") or [applied.get("file")]:
            if rel:
                radar.on_file_change(project_id, rel.split(f".omnipilot-projects/{project_id}/", 1)[-1])
    if not step:
        return
    store.x("UPDATE run_steps SET status = ?, output = ?, finished_at = ? WHERE id = ?", "completed" if decision == "approved" else "cancelled",
            json.dumps({"decision": decision, "applied": applied, "outcome": outcome}, ensure_ascii=False)[:8000], _now(), step["id"])
    if not store.q1("SELECT 1 AS x FROM run_steps WHERE task_run_id = ? AND status = 'awaiting_approval'", step["trid"]):
        store.x("UPDATE task_runs SET status = 'completed', finished_at = ? WHERE id = ? AND status = 'awaiting_approval'", _now(), step["trid"])
        store.x("UPDATE project_tasks SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'awaiting_approval'", _now(), task_id)


# --- recovery ---


def reconcile_on_start() -> dict:
    """At start-up: attempts left running were interrupted by the restart; actions left mid-flight are uncertain."""
    interrupted = 0
    for tr in store.q("SELECT * FROM task_runs WHERE status = 'running'"):
        store.x("UPDATE task_runs SET status = 'interrupted', error = 'OmniPilot stopped while this attempt was running.', finished_at = ? WHERE id = ?", _now(), tr["id"])
        store.x("UPDATE run_steps SET status = 'interrupted', finished_at = ? WHERE task_run_id = ? AND status = 'running'", _now(), tr["id"])
        store.x("UPDATE project_tasks SET status = 'interrupted', updated_at = ? WHERE id = ? AND status = 'running'", _now(), tr["task_id"])
        projects.record(tr["project_id"], "task_interrupted", "A task attempt was interrupted by a restart", {"taskId": tr["task_id"], "taskRunId": tr["id"]}, actor="OmniPilot", actor_type="system")
        interrupted += 1
    uncertain = 0
    for a in store.q("SELECT id FROM pending_actions WHERE status = 'running'"):
        uncertain += store.x("UPDATE run_steps SET status = 'uncertain', error = 'OmniPilot stopped while this action was running; check the service, then record what happened.' "
                             "WHERE idempotency_key = ? AND status IN ('awaiting_approval', 'running')", a["id"])
    return {"interrupted": interrupted, "uncertain": uncertain}


def resume_task(project_id: str, task_id: str, actor: str = OWNER) -> dict:
    """A new attempt after an interruption or failure. Changes already made or waiting are not repeated."""
    row = _task_row(project_id, task_id)
    if row["status"] not in ("interrupted", "failed", "cancelled", "blocked"):
        raise ProjectError(409, "not_resumable", "Only an interrupted, failed, stopped or blocked task can be resumed.")
    last = store.q1("SELECT id FROM task_runs WHERE task_id = ? ORDER BY attempt DESC LIMIT 1", task_id)
    return start_task(project_id, task_id, actor, retry_of=last and last["id"])


async def retry_step(project_id: str, step_id: str, actor: str = OWNER) -> dict:
    """Re-runs one failed specialist step (read-only steps only; changes go through approval, never a retry)."""
    from .brain import orchestrator

    projects.require(project_id, "write", actor)
    s = store.q1("SELECT s.*, t.project_id, t.task_id, t.run_id FROM run_steps s JOIN task_runs t ON t.id = s.task_run_id WHERE s.id = ?", step_id)
    if not s or s["project_id"] != project_id:
        raise ProjectError(404, "not_found", "No such step in this project.")
    if s["kind"] != "agent" or s["status"] != "failed" or s["writes"]:
        raise ProjectError(409, "not_retryable", "Only a failed specialist step that changes nothing can be retried.")
    t = _task(_task_row(project_id, s["task_id"]))
    checks = store.q("SELECT text FROM acceptance_checks WHERE task_id = ? ORDER BY rowid", s["task_id"])
    scope = projects.run_scope(project_id, actor)
    token = projects.current.set(scope)
    try:
        ctx = {"project": {k: scope.get(k) for k in ("id", "name", "requirements", "constraints", "acceptance", "facts", "preferences")}, "workspace_root": scope["root"], "project_id": project_id}
        res = await orchestrator.run_agent_isolated(s["name"], {"runId": s["run_id"] or str(uuid.uuid4()), "requestText": contract_message(t, checks), "context": ctx})
    finally:
        projects.current.reset(token)
    ok = res.get("status") in OK_STATUSES
    new_id = _add_step(s["task_run_id"], "agent", s["name"], "completed" if ok else "failed", input={"retryOf": step_id},
                       output={"findings": [str(f)[:500] for f in (res.get("findings") or [])][:5], "status": res.get("status")},
                       error="" if ok else "; ".join(str(x) for x in (res.get("limitations") or []))[:500])
    for ev in res.get("evidence") or []:
        _auto_evidence(project_id, s["task_id"], s["run_id"], s["name"], ev)
    projects.record(project_id, "step_retried", f"Retried {s['name']}: {'succeeded' if ok else 'failed again'}", {"stepId": new_id, "retryOf": step_id}, actor=actor)
    return {"step": store.q1("SELECT * FROM run_steps WHERE id = ?", new_id), "result": res}


def cancel_task(project_id: str, task_id: str, actor: str = OWNER) -> dict:
    """Stops a running attempt and withdraws the changes it is still waiting to have approved."""
    from .brain import control

    projects.require(project_id, "write", actor)
    row = _task_row(project_id, task_id)
    if row["status"] not in ("running", "awaiting_approval", "pending", "blocked", "interrupted"):
        raise ProjectError(409, "not_cancellable", "This task isn't running or waiting.")
    for tr in store.q("SELECT * FROM task_runs WHERE task_id = ? AND status IN ('running', 'awaiting_approval')", task_id):
        if tr["run_id"]:
            control.cancel(tr["run_id"])
        for s in store.q("SELECT * FROM run_steps WHERE task_run_id = ? AND status = 'awaiting_approval'", tr["id"]):
            actions.reject_action(s["idempotency_key"])
            patches.reject_patch(s["idempotency_key"])
            ap = store.get_approval(s["idempotency_key"])
            if ap and ap["status"] == "pending":
                store.decide_approval(ap["id"], "denied")
                store.audit(tr["run_id"], "System", "approval_decision", {"approvalId": ap["id"], "reason": "task stopped"}, "denied")
                _settle(tr["run_id"])
            store.x("UPDATE run_steps SET status = 'cancelled', finished_at = ? WHERE id = ?", _now(), s["id"])
        store.x("UPDATE task_runs SET status = 'cancelled', finished_at = ? WHERE id = ?", _now(), tr["id"])
    _set_status(task_id, "cancelled")
    projects.record(project_id, "task_cancelled", f"Task stopped: {row['title']}", {"taskId": task_id}, actor=actor)
    return get_task(project_id, task_id, actor)


def reconcile_step(project_id: str, step_id: str, outcome: str, actor: str = OWNER) -> dict:
    """A person records what happened to an action whose outcome was uncertain after a restart."""
    projects.require(project_id, "approve", actor)
    s = store.q1("SELECT s.*, t.project_id FROM run_steps s JOIN task_runs t ON t.id = s.task_run_id WHERE s.id = ?", step_id)
    if not s or s["project_id"] != project_id:
        raise ProjectError(404, "not_found", "No such step in this project.")
    if s["status"] != "uncertain":
        raise ProjectError(409, "not_uncertain", "Only a step whose outcome is uncertain can be reconciled.")
    r = actions.reconcile_action(s["idempotency_key"], outcome)
    if not r["ok"]:
        raise ProjectError(409, "not_uncertain", r["message"])
    store.x("UPDATE run_steps SET status = ?, error = ?, finished_at = ? WHERE id = ?", "completed" if outcome == "succeeded" else "failed",
            "" if outcome == "succeeded" else "Recorded by hand as not done; it can be approved again.", _now(), step_id)
    projects.record(project_id, "step_reconciled", f"Uncertain action recorded as {outcome}", {"stepId": step_id}, actor=actor)
    return store.q1("SELECT * FROM run_steps WHERE id = ?", step_id)


async def wait_for_attempts() -> None:
    """Tests: waits for background attempts to finish."""
    while _tasks:
        await asyncio.gather(*list(_tasks), return_exceptions=True)
        await asyncio.sleep(0)
