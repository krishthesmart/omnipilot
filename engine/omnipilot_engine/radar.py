"""Change Radar, Research-to-Build links and Readiness Check (docs/product, slice 5).

Change Radar: when something a project relies on changes (a file, a requirement or constraint, a decision, a fact),
OmniPilot works out deterministically what may be affected and opens an alert. No model is involved.
  - "confirmed" relation: a recorded link: an observation citing the file, evidence pinned to the file's old
    checksum, a project file that imports the changed one, or a trace link to the changed item.
  - "suspected" relation: only a plain mention (the name, or several distinctive words, appear in the text).
Each alert says why it was raised and what to do next; people resolve, dismiss or postpone it.

Trace links connect research, decisions, tasks, checks, evidence and files. A link's note is whatever the
person wrote, or a plain description of how the system made it; OmniPilot never invents a rationale.

Readiness Check reports recorded state on six dimensions; it doesn't prove the work is correct.
"""
from __future__ import annotations

import json
import re
import uuid

from . import projects, store
from .projects import OWNER, ProjectError

KINDS = ("fact", "task", "check", "evidence", "file", "run", "assumption", "comparison", "requirement")
ALERT_STATUSES = ("open", "resolved", "dismissed", "postponed")
STOP = {"which", "their", "there", "these", "those", "about", "should", "would", "could", "every", "other", "after", "before", "under", "where", "while", "being", "using"}


def _now() -> str:
    return store.now()


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z][a-z0-9-]{4,}", (text or "").lower()) if w not in STOP}


def _mentions(text: str, needle_words: set[str]) -> bool:
    """A plain mention: at least two distinctive words in common (or the one word, if there is only one)."""
    common = _words(text) & needle_words
    return len(common) >= min(2, len(needle_words)) and bool(common)


def _alert(project_id: str, trigger: tuple[str, str, str], affected: tuple[str, str, str], relation: str, why: str, next_step: str) -> dict | None:
    if store.q1("SELECT 1 AS x FROM change_alerts WHERE project_id = ? AND trigger_ref = ? AND affected_kind = ? AND affected_ref = ? AND status IN ('open', 'postponed')",
                project_id, trigger[1], affected[0], affected[1]):
        return None  # already raised and not settled
    aid, now = str(uuid.uuid4()), _now()
    store.x("INSERT INTO change_alerts (id, project_id, trigger_kind, trigger_ref, trigger_summary, affected_kind, affected_ref, affected_summary, relation, explanation, next_step, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", aid, project_id, *trigger, *affected, relation, why, next_step, now, now)
    return store.q1("SELECT * FROM change_alerts WHERE id = ?", aid)


def _finish(project_id: str, made: list, what: str) -> list[dict]:
    made = [m for m in made if m]
    if made:
        projects.record(project_id, "change_radar", f"Change Radar: {len(made)} item(s) may be affected by {what[:120]}", {"alerts": [m["id"] for m in made]}, actor="OmniPilot", actor_type="system")
    return made


def _linked(project_id: str, kind: str, ref: str) -> list[dict]:
    return store.q("SELECT * FROM trace_links WHERE project_id = ? AND ((from_kind = ? AND from_id = ?) OR (to_kind = ? AND to_id = ?))", project_id, kind, ref, kind, ref)


def _summary(project_id: str, kind: str, ref: str) -> str:
    row = None
    if kind == "fact":
        row = store.q1("SELECT content AS s FROM project_facts WHERE id = ? AND project_id = ?", ref, project_id)
    elif kind == "task":
        row = store.q1("SELECT title AS s FROM project_tasks WHERE id = ? AND project_id = ?", ref, project_id)
    elif kind == "check":
        row = store.q1("SELECT text AS s FROM acceptance_checks WHERE id = ? AND project_id = ?", ref, project_id)
    elif kind == "evidence":
        row = store.q1("SELECT claim AS s FROM evidence_receipts WHERE id = ? AND project_id = ?", ref, project_id)
    elif kind == "file":
        row = store.q1("SELECT name AS s FROM project_files WHERE (id = ? OR name = ?) AND project_id = ?", ref, ref, project_id)
    elif kind == "run":
        row = store.q1("SELECT request AS s FROM runs WHERE id = ? AND project_id = ?", ref, project_id)
    elif kind == "assumption":
        row = store.q1("SELECT statement AS s FROM project_assumptions WHERE id = ? AND project_id = ?", ref, project_id)
    elif kind == "comparison":
        row = store.q1("SELECT title AS s FROM comparison_sessions WHERE id = ? AND project_id = ?", ref, project_id)
    elif kind == "requirement":
        return ref
    return (row or {}).get("s", "")[:200] if row else ""


def _imports(text: str, stem: str) -> bool:
    s = re.escape(stem)
    return bool(re.search(rf"^\s*(?:from\s+\.?{s}\s+import|import\s+{s}\b)", text, re.M) or re.search(rf"(?:require\(|from\s+)['\"]\./{s}(?:\.[a-z]+)?['\"]", text))


def on_file_change(project_id: str, name: str, file_id: str | None = None) -> list[dict]:
    """A project file changed or was deleted (pass its id when it's gone)."""
    f = store.q1("SELECT * FROM project_files WHERE project_id = ? AND name = ?", project_id, name)
    sha = f["sha256"] if f else None
    file_id = f["id"] if f else file_id
    trigger = ("file", name, f"The file {name} {'changed' if f else 'was deleted'}")
    made = []
    for fact in store.q("SELECT * FROM project_facts WHERE project_id = ? AND status = 'active' AND source_kind = 'file' AND source_ref IN (?, ?)", project_id, name, file_id or name):
        if fact["source_sha256"] != sha:
            made.append(_alert(project_id, trigger, ("fact", fact["id"], fact["content"][:200]), "confirmed",
                               f"This Project DNA entry was observed from {name}, which has changed since.", "Re-read the file and confirm, edit or retire the entry."))
    for ev in store.q("SELECT * FROM evidence_receipts WHERE project_id = ? AND artifact = ? AND artifact_sha256 IS NOT NULL", project_id, name):
        if ev["artifact_sha256"] != sha:
            checks = store.q("SELECT id, text FROM acceptance_checks WHERE evidence_id = ? AND state = 'passed'", ev["id"])
            made.append(_alert(project_id, trigger, ("evidence", ev["id"], ev["claim"][:200]), "confirmed",
                               f"This evidence was about a different version of {name}" + (f"; it backs {len(checks)} passed acceptance check(s)." if checks else "."),
                               "Collect fresh evidence (e.g. re-run the tests) before relying on it."))
    stem = name.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    root = projects.files_dir(project_id)
    for other in store.q("SELECT name FROM project_files WHERE project_id = ? AND name != ?", project_id, name):
        if not re.search(r"\.(py|js|mjs|ts|tsx|jsx)$", other["name"]):
            continue
        try:
            text = (root / other["name"]).read_text(encoding="utf-8", errors="replace")[:200_000]
        except OSError:
            continue
        if _imports(text, stem):
            made.append(_alert(project_id, trigger, ("file", other["name"], other["name"]), "confirmed",
                               f"{other['name']} imports {name}.", "Check that it still works with the change (run its tests)."))
    for link in _linked(project_id, "file", name):
        k, ref = (link["to_kind"], link["to_id"]) if link["from_id"] == name else (link["from_kind"], link["from_id"])
        made.append(_alert(project_id, trigger, (k, ref, _summary(project_id, k, ref)), "confirmed", f"This is linked to {name} in the project's trace.", "Review it against the changed file."))
    needle = {name.lower()}
    for fact in store.q("SELECT * FROM project_facts WHERE project_id = ? AND status = 'active' AND NOT (source_kind = 'file' AND source_ref IN (?, ?))", project_id, name, file_id or name):
        if name.lower() in f"{fact['content']} {fact['rationale']}".lower():
            made.append(_alert(project_id, trigger, ("fact", fact["id"], fact["content"][:200]), "suspected", f"This entry mentions {name} by name (no recorded link).", "Check whether the change affects it."))
    for t in store.q("SELECT * FROM project_tasks WHERE project_id = ? AND status NOT IN ('cancelled')", project_id):
        if any(n in f"{t['title']} {t['goal']} {t['request']}".lower() for n in needle):
            made.append(_alert(project_id, trigger, ("task", t["id"], t["title"]), "suspected", f"This task mentions {name} by name (no recorded link).", "Check whether its result still holds."))
    return _finish(project_id, made, trigger[2])


def _on_text_change(project_id: str, trigger: tuple[str, str, str], text: str, ref_kind: str, ref_id: str, skip_fact: str | None = None, skip_also: str | None = None) -> list[dict]:
    made = []
    for link in _linked(project_id, ref_kind, ref_id):
        k, ref = (link["to_kind"], link["to_id"]) if link["from_id"] == ref_id else (link["from_kind"], link["from_id"])
        made.append(_alert(project_id, trigger, (k, ref, _summary(project_id, k, ref)), "confirmed", "This is linked to the changed item in the project's trace.", "Review it against the change."))
    words = _words(text)
    if not words:
        return made
    for c in store.q("SELECT c.* FROM acceptance_checks c JOIN project_tasks t ON t.id = c.task_id WHERE c.project_id = ? AND t.status != 'cancelled'", project_id):
        if c["requirement"] and c["requirement"] == text:
            made.append(_alert(project_id, trigger, ("check", c["id"], c["text"][:200]), "confirmed", "This acceptance check was written for the changed requirement.", "Update the check or confirm it still applies."))
        elif _mentions(c["text"], words):
            made.append(_alert(project_id, trigger, ("check", c["id"], c["text"][:200]), "suspected",
                               "This acceptance check shares words with the changed item (no recorded link)." + (" It is currently passed." if c["state"] == "passed" else ""),
                               "Check whether it still matches what's required."))
    for f in store.q("SELECT * FROM project_facts WHERE project_id = ? AND status = 'active'", project_id):
        if f["id"] not in (skip_fact, skip_also) and f["kind"] in ("decision", "requirement", "constraint", "goal") and _mentions(f"{f['content']} {f['rationale']}", words):
            made.append(_alert(project_id, trigger, ("fact", f["id"], f["content"][:200]), "suspected", "This entry shares words with the changed item (no recorded link).", "Check it still holds."))
    for t in store.q("SELECT * FROM project_tasks WHERE project_id = ? AND status NOT IN ('cancelled')", project_id):
        if ref_kind == "task" and t["id"] == ref_id:
            continue
        if _mentions(f"{t['title']} {t['goal']} {t['request']}", words):
            made.append(_alert(project_id, trigger, ("task", t["id"], t["title"]), "suspected", "This task shares words with the changed item (no recorded link).", "Check whether its plan or result needs updating."))
    return made


def on_requirement_change(project_id: str, kind: str, ref: str, text: str, old: str = "") -> list[dict]:
    """A requirement or constraint (on the project, in Project DNA or in a task's contract) changed."""
    trigger = (kind, ref, f"Changed: {text[:150]}")
    return _finish(project_id, _on_text_change(project_id, trigger, f"{text} {old}", kind, ref, skip_fact=ref if kind == "fact" else None), trigger[2])


def on_fact_change(project_id: str, fact: dict, how: str) -> list[dict]:
    """A decision was superseded, or a fact was retired or edited."""
    trigger = ("fact", fact["id"], f"{how}: {fact['content'][:150]}")
    replacement = (store.q1("SELECT superseded_by FROM project_facts WHERE id = ?", fact["id"]) or {}).get("superseded_by")
    return _finish(project_id, _on_text_change(project_id, trigger, f"{fact['content']} {fact.get('rationale', '')}", "fact", fact["id"], skip_fact=fact["id"], skip_also=replacement), trigger[2])


def alerts(project_id: str, status: str | None = "open", actor: str = OWNER) -> list[dict]:
    projects.require(project_id, "read", actor)
    if status and status not in ALERT_STATUSES:
        raise ProjectError(400, "invalid_request", "Unknown status.")
    return store.q("SELECT * FROM change_alerts WHERE project_id = ? AND (? IS NULL OR status = ?) ORDER BY relation = 'suspected', created_at DESC", project_id, status, status)


def set_alert(project_id: str, alert_id: str, status: str, actor: str = OWNER) -> dict:
    projects.require(project_id, "write", actor)
    if status not in ALERT_STATUSES:
        raise ProjectError(400, "invalid_request", "Unknown status.")
    a = store.q1("SELECT * FROM change_alerts WHERE id = ? AND project_id = ?", alert_id, project_id)
    if not a:
        raise ProjectError(404, "not_found", "No such alert in this project.")
    store.x("UPDATE change_alerts SET status = ?, updated_at = ? WHERE id = ?", status, _now(), alert_id)
    projects.record(project_id, f"alert_{status}", f"Change alert {status}: {a['affected_summary'][:100]}", {"alertId": alert_id}, actor=actor)
    return store.q1("SELECT * FROM change_alerts WHERE id = ?", alert_id)


# --- trace links ---


def _exists(project_id: str, kind: str, ref: str) -> bool:
    if kind == "requirement":
        p = projects.require(project_id)
        return ref in p["requirements"] or ref in p["constraints"]
    return bool(_summary(project_id, kind, ref))


def link(project_id: str, from_kind: str, from_id: str, to_kind: str, to_id: str, note: str = "", actor: str = OWNER) -> dict:
    projects.require(project_id, "write", actor)
    if from_kind not in KINDS or to_kind not in KINDS:
        raise ProjectError(400, "invalid_request", f"kinds must be: {', '.join(KINDS)}")
    if not _exists(project_id, from_kind, from_id) or not _exists(project_id, to_kind, to_id):
        raise ProjectError(404, "not_found", "Both ends of a link must be items in this project.")
    store.x("INSERT OR IGNORE INTO trace_links (id, project_id, from_kind, from_id, to_kind, to_id, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            str(uuid.uuid4()), project_id, from_kind, from_id, to_kind, to_id, projects._clean_text(note, "note", 500), actor, _now())
    return store.q1("SELECT * FROM trace_links WHERE from_kind = ? AND from_id = ? AND to_kind = ? AND to_id = ?", from_kind, from_id, to_kind, to_id)


def unlink(project_id: str, link_id: str, actor: str = OWNER) -> bool:
    projects.require(project_id, "write", actor)
    return bool(store.x("DELETE FROM trace_links WHERE id = ? AND project_id = ?", link_id, project_id))


def trace(project_id: str, kind: str, ref: str, actor: str = OWNER, depth: int = 3) -> dict:
    """Everything connected to an item, following recorded links (and a task's own checks and evidence)."""
    projects.require(project_id, "read", actor)
    seen = {(kind, ref)}
    frontier = [(kind, ref)]
    edges = []
    for _ in range(depth):
        nxt = []
        for k, r in frontier:
            neighbours = [((l["to_kind"], l["to_id"]) if (l["from_kind"], l["from_id"]) == (k, r) else (l["from_kind"], l["from_id"]), l["note"] or "linked by hand", l["actor"])
                          for l in _linked(project_id, k, r)]
            if k == "task":
                neighbours += [(("check", c["id"]), "acceptance check of this task", "system") for c in store.q("SELECT id FROM acceptance_checks WHERE task_id = ?", r)]
                neighbours += [(("evidence", e["id"]), "evidence recorded for this task", "system") for e in store.q("SELECT id FROM evidence_receipts WHERE task_id = ?", r)]
                neighbours += [(("run", t["run_id"]), "a run of this task", "system") for t in store.q("SELECT run_id FROM task_runs WHERE task_id = ? AND run_id IS NOT NULL", r)]
            if k == "check":
                c = store.q1("SELECT evidence_id, task_id FROM acceptance_checks WHERE id = ?", r)
                if c and c["evidence_id"]:
                    neighbours.append((("evidence", c["evidence_id"]), "evidence cited for this check", "system"))
                if c:
                    neighbours.append((("task", c["task_id"]), "the task this check belongs to", "system"))
            for node, note, by in neighbours:
                edges.append({"from": {"kind": k, "id": r}, "to": {"kind": node[0], "id": node[1]}, "note": note, "by": by})
                if node not in seen:
                    seen.add(node)
                    nxt.append(node)
        frontier = nxt
    return {"root": {"kind": kind, "id": ref, "summary": _summary(project_id, kind, ref)},
            "nodes": [{"kind": k, "id": r, "summary": _summary(project_id, k, r)} for k, r in seen], "edges": edges}


def links(project_id: str, actor: str = OWNER) -> list[dict]:
    projects.require(project_id, "read", actor)
    return [{**l, "from_summary": _summary(project_id, l["from_kind"], l["from_id"]), "to_summary": _summary(project_id, l["to_kind"], l["to_id"])}
            for l in store.q("SELECT * FROM trace_links WHERE project_id = ? ORDER BY created_at DESC", project_id)]


# --- readiness ---

DISCLAIMER = "This checks what OmniPilot has recorded. It isn't proof of correctness or security; a person decides when it's ready."


TEST_FILE = re.compile(r"(^|/)(test_[^/]+\.py|[^/]+_test\.py|[^/]+\.(test|spec)\.[jt]sx?)$")
CODE_FILE = re.compile(r"\.(py|js|mjs|ts|tsx|jsx)$")


def readiness(project_id: str, actor: str = OWNER, save: bool = True) -> dict:
    """Recorded state on the plan's dimensions: requirement coverage, configured tests, research sourcing,
    configuration, handoff documentation and export privacy (plus open alerts, assumptions and waiting work)."""
    from . import grants

    p = projects.require(project_id, "read", actor)
    tasks = store.q("SELECT * FROM project_tasks WHERE project_id = ? AND status != 'cancelled'", project_id)
    checks = store.q("SELECT c.* FROM acceptance_checks c JOIN project_tasks t ON t.id = c.task_id WHERE c.project_id = ? AND t.status != 'cancelled'", project_id)
    files = store.q("SELECT name, sha256 FROM project_files WHERE project_id = ?", project_id)
    sha_of = {f["name"]: f["sha256"] for f in files}
    out = []

    def dim(key, label, state, detail, items=None):
        out.append({"key": key, "label": label, "state": state, "detail": detail, "items": items or []})

    # 1. Requirement coverage: each requirement has an acceptance check (matching or linked), and checks passed with evidence.
    reqs = p["requirements"]
    if not reqs and not checks:
        dim("requirements", "Requirement coverage", "not_applicable", "No requirements or acceptance checks are listed.")
    else:
        texts = [f"{c['text']} {c['requirement'] or ''}" for c in checks]
        linked = {l["from_id"] for l in store.q("SELECT from_id FROM trace_links WHERE project_id = ? AND from_kind = 'requirement'", project_id)} | \
                 {l["to_id"] for l in store.q("SELECT to_id FROM trace_links WHERE project_id = ? AND to_kind = 'requirement'", project_id)}
        uncovered = [f"Requirement without a check: {r}" for r in reqs if r not in linked and not any(c["requirement"] == r for c in checks) and not any(_mentions(t, _words(r)) for t in texts)]
        unpassed = [f"Check not passed: {c['text']}" for c in checks if c["state"] not in ("passed", "not_applicable")]
        stale = []
        for c in checks:
            if c["state"] == "passed" and c["evidence_id"]:
                e = store.q1("SELECT artifact, artifact_sha256 FROM evidence_receipts WHERE id = ?", c["evidence_id"])
                if e and e["artifact"] and e["artifact_sha256"] and sha_of.get(e["artifact"]) != e["artifact_sha256"]:
                    stale.append(f"Evidence for “{c['text']}” is about an older {e['artifact']}")
        problems = uncovered + unpassed + stale
        dim("requirements", "Requirement coverage", "failed" if problems else "passed",
            f"{len(reqs) - len(uncovered)} of {len(reqs)} requirement(s) covered; {sum(1 for c in checks if c['state'] == 'passed')} of {len(checks)} check(s) passed with evidence.", problems)

    # 2. Configured tests: test files present and a current, passing test result recorded.
    test_files = [f["name"] for f in files if TEST_FILE.search(f["name"])]
    code_files = [f["name"] for f in files if CODE_FILE.search(f["name"])]
    tests_ev = store.q("SELECT * FROM evidence_receipts WHERE project_id = ? AND kind = 'test' ORDER BY created_at DESC", project_id)
    if not code_files and not tests_ev:
        dim("tests", "Configured tests", "not_applicable", "The project has no code files.")
    elif not test_files and not tests_ev:
        dim("tests", "Configured tests", "failed", "There is code but no test files and no recorded test results.", code_files[:10])
    elif not tests_ev:
        dim("tests", "Configured tests", "not_checked", "Test files exist, but no test result has been recorded.", test_files[:10])
    else:
        latest = tests_ev[0]
        bad = latest["result"] != "supports" or (latest["artifact"] and latest["artifact_sha256"] and sha_of.get(latest["artifact"]) != latest["artifact_sha256"])
        dim("tests", "Configured tests", "failed" if bad else "passed",
            f"Latest test result: {latest['result']}" + (" (about an older version of the file)" if latest["artifact"] and latest["artifact_sha256"] and sha_of.get(latest["artifact"]) != latest["artifact_sha256"] else "") + ".",
            [latest["claim"][:200]])

    # 3. Research sourcing: confirmed decisions trace back to a source, evidence, run or comparison.
    decisions = store.q("SELECT id, content FROM project_facts WHERE project_id = ? AND kind = 'decision' AND status = 'active' AND basis = 'confirmed'", project_id)
    if not decisions:
        dim("sourcing", "Research sourcing", "not_applicable", "No confirmed decisions to source.")
    else:
        unsourced = [d["content"][:150] for d in decisions
                     if not any(n["kind"] in ("evidence", "run", "comparison", "file") for n in trace(project_id, "fact", d["id"], actor, depth=2)["nodes"])]
        dim("sourcing", "Research sourcing", "failed" if unsourced else "passed", f"{len(decisions) - len(unsourced)} of {len(decisions)} decision(s) link to a source or evidence.",
            [f"Decision without a linked source: {u}" for u in unsourced])

    # 4. Configuration: waiting external actions have the project's connection grant.
    missing = []
    for s_ in store.q("SELECT s.idempotency_key FROM run_steps s JOIN task_runs t ON t.id = s.task_run_id WHERE t.project_id = ? AND s.status = 'awaiting_approval'", project_id):
        a = store.q1("SELECT kind FROM pending_actions WHERE id = ?", s_["idempotency_key"])
        conn = a and grants.KIND_CONNECTOR.get(a["kind"])
        if conn and not grants.has(project_id, conn, "write"):
            missing.append(f"{conn}: write access not granted (needed by a waiting action)")
    if not tasks:
        dim("configuration", "Configuration", "not_checked", "No tasks yet, so nothing needs connections.")
    else:
        dim("configuration", "Configuration", "failed" if missing else "passed", "Connection grants were compared with the actions waiting for approval.", missing)

    # 5. Handoff documentation: a capsule made after the latest change to the project's DNA or tasks.
    last_handoff = store.q1("SELECT created_at FROM handoffs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", project_id)
    last_change = store.q1("SELECT MAX(at) AS at FROM project_events WHERE project_id = ? AND kind IN ('fact_added', 'fact_edited', 'fact_retired', 'decision_superseded', 'task_created', 'task_updated', 'check_updated', 'file_added', 'file_replaced', 'file_changed')", project_id)
    if not last_handoff:
        dim("handoff", "Handoff documentation", "not_checked", "No Handoff Capsule has been made.")
    else:
        old = bool(last_change and last_change["at"] and last_change["at"] > last_handoff["created_at"])
        dim("handoff", "Handoff documentation", "failed" if old else "passed", "The latest capsule is older than the latest change." if old else "The latest capsule is newer than the latest change.")

    # 6. Export privacy: the export, after scrubbing, contains nothing that looks like a secret.
    from .tools.base import scrub

    exported = json.dumps(projects.export(project_id, actor, record_event=False), ensure_ascii=False)
    leaks = [m.group(0)[:6] + "…" for m in re.finditer(r"\b(?:sk-|gsk_|ghp_|xox[bp]-|AKIA)[A-Za-z0-9_-]{16,}", exported)]
    dim("privacy", "Export privacy", "failed" if leaks else "passed",
        "The project export was scanned for secret-looking values after scrubbing." + (" Found some; don't share the export." if leaks else " None found."), leaks)
    _ = scrub  # the export already runs it; imported here so the check fails loudly if it's ever removed

    alerts_open = store.q("SELECT affected_summary FROM change_alerts WHERE project_id = ? AND status IN ('open', 'postponed')", project_id)
    dim("changes", "No unreviewed Change Radar alerts", "failed" if alerts_open else "passed", f"{len(alerts_open)} alert(s) open or postponed.", [a["affected_summary"] for a in alerts_open])
    unverified = store.q("SELECT statement FROM project_assumptions WHERE project_id = ? AND status = 'unverified'", project_id)
    dim("assumptions", "No unverified assumptions", "failed" if unverified else "passed", f"{len(unverified)} unverified.", [a["statement"] for a in unverified])
    waiting = store.q("SELECT s.name, s.status FROM run_steps s JOIN task_runs t ON t.id = s.task_run_id WHERE t.project_id = ? AND s.status IN ('awaiting_approval', 'uncertain')", project_id)
    stuck = [t["title"] for t in tasks if t["status"] in ("running", "interrupted", "failed", "blocked")]
    if not tasks:
        dim("work", "No waiting approvals, uncertain actions or stuck tasks", "not_checked", "No tasks yet.")
    else:
        dim("work", "No waiting approvals, uncertain actions or stuck tasks", "failed" if waiting or stuck else "passed",
            f"{len(waiting)} step(s) waiting or uncertain; {len(stuck)} task(s) not finished cleanly.", [f"{w['name']} ({w['status'].replace('_', ' ')})" for w in waiting] + stuck)
    result = {"projectId": project_id, "dimensions": out, "disclaimer": DISCLAIMER, "at": _now()}
    if save:
        store.x("INSERT INTO readiness_checks (id, project_id, results, created_at) VALUES (?, ?, ?, ?)", str(uuid.uuid4()), project_id, json.dumps(result), result["at"])
        projects.record(project_id, "readiness_check", f"Readiness check: {sum(1 for d in out if d['state'] == 'passed')} of {len(out)} passed", {}, actor=actor)
    return result
