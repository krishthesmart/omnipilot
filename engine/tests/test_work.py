"""Slices 3-9 of docs/product: tasks and Outcome Contracts, persisted runs, Evidence Receipts, Recovery Mode,
approval binding and connection grants, Change Radar, trace and readiness, Comparison Bench, branches,
Challenge My Plan, Learn Mode, Return Briefings, Handoff Capsules, recipes and routines, usage and budgets.
No real model or service is called: agents and models are replaced by clearly labelled fakes."""
import asyncio
import datetime as dt
import json
import uuid

import pytest

from omnipilot_engine import (actions, bench, grants, handoff, learn, llm, patches, project_dna as dna, projects, radar, recipes, store, work)
from omnipilot_engine.projects import ProjectError


@pytest.fixture
def py_runs(monkeypatch):
    monkeypatch.setenv("OMNIPILOT_RUNS", "python")


def fake_agents(monkeypatch, propose=None, evidence=None, fail=()):
    """Stands in for the specialists (no model in tests). `propose(run_id)` returns actions for the first agent."""
    from omnipilot_engine.brain import agents

    proposed = set()

    async def fake(name, input, ctx):
        run_id = input["runId"]
        acts = []
        if propose and run_id not in proposed:
            proposed.add(run_id)
            acts = propose(run_id, ctx)
        if name in fail or "*" in fail:
            return {"status": "failed", "findings": [f"{name} failed (fake)."], "evidence": [], "confidence": 0, "limitations": ["fake failure"], "proposedActions": []}
        return {"status": "success", "findings": [f"{name} answered (fake)."], "evidence": list(evidence or []), "confidence": 0.9, "limitations": [], "proposedActions": acts}

    monkeypatch.setattr(agents, "run", fake)


async def _ok():
    return {"ok": True, "message": "posted (fake)"}


async def until(cond, tries=200):
    for _ in range(tries):
        if cond():
            return
        await asyncio.sleep(0.03)
    raise AssertionError("condition not reached")


def task_status(pid, tid):
    return store.q1("SELECT status FROM project_tasks WHERE id = ?", tid)["status"]


# --- slice 3: tasks, contracts, acceptance checks ---


def test_a_task_has_an_outcome_contract_and_checks_pass_only_with_supporting_evidence():
    p = projects.create({"name": "Soil"})
    t = work.create_task(p["id"], {"title": "Find the wettest soil", "goal": "Rank soils by moisture", "constraints": ["Use only greenhouse data"],
                                   "outOfScope": ["Buying sensors"], "requiredApprovals": ["Changing files"], "acceptance": ["Ranking cites the readings file"]})
    assert (t["constraints"], t["out_of_scope"], t["required_approvals"]) == (["Use only greenhouse data"], ["Buying sensors"], ["Changing files"])
    check = t["acceptance"][0]
    with pytest.raises(ProjectError) as e:
        work.set_check(p["id"], check["id"], "passed")
    assert e.value.code == "evidence_required"
    weak = work.add_evidence(p["id"], {"kind": "source", "result": "inconclusive", "claim": "Someone said so"})
    with pytest.raises(ProjectError):
        work.set_check(p["id"], check["id"], "passed", weak["id"])
    good = work.add_evidence(p["id"], {"kind": "human", "result": "supports", "claim": "I checked the ranking against readings.txt"})
    with pytest.raises(ProjectError) as e:
        work.set_check(p["id"], check["id"], "passed", good["id"], actor_type="agent")
    assert e.value.code == "forbidden"  # agents can't mark anything passed
    assert work.set_check(p["id"], check["id"], "passed", good["id"])["state"] == "passed"
    # an agent's "supports" is recorded as inconclusive unless it's a test
    said = work.add_evidence(p["id"], {"kind": "source", "result": "supports", "claim": "It works"}, actor="Helper", actor_type="agent")
    assert said["result"] == "inconclusive"
    other = projects.create({"name": "Other"})
    with pytest.raises(ProjectError):
        work.set_check(other["id"], check["id"], "failed")  # another project's check is not found
    with pytest.raises(ProjectError):
        work.set_check(p["id"], check["id"], "passed", work.add_evidence(other["id"], {"kind": "human", "result": "supports", "claim": "x"})["id"])


def test_the_router_is_a_labelled_baseline_and_can_be_swapped_only_with_an_honest_label():
    from omnipilot_engine.brain import decision

    d = decision.describe()
    assert d["kind"] == "baseline" and "not a trained decision model" in d["label"]

    class Unlabelled:
        name, kind, label = "x", "magic", ""

    with pytest.raises(ValueError):
        decision.use(Unlabelled())


async def test_a_task_attempt_records_its_steps_router_and_evidence_and_approval_settles_it(make_client, py_runs, monkeypatch):
    p = projects.create({"name": "Calc"})
    projects.add_file(p["id"], "calc.py", b"def add(a, b):\n    return a - b\n")
    projects.add_file(p["id"], "notes.txt", b"add must return the sum")
    rel = patches.to_workspace_rel(str(projects.files_dir(p["id"])), "calc.py")

    def propose(run_id, ctx):
        aid = str(uuid.uuid4())
        patches.save_patch_set(aid, "Fix add", [{"file": rel, "original": "def add(a, b):\n    return a - b\n", "fixed": "def add(a, b):\n    return a + b\n"}])
        return [{"id": aid, "description": "Fix add() in calc.py", "riskLevel": "low", "requiresApproval": True}]

    fake_agents(monkeypatch, propose, evidence=[{"source": "sandbox-run", "detail": "3/3 tests passed"}, {"source": "notes.txt:1", "detail": "add must return the sum"},
                                                 {"source": "ai-model:fake", "detail": ""}])
    async with make_client() as c:
        t = (await c.post(f"/api/projects/{p['id']}/tasks", json={"title": "Fix add", "acceptance": ["add(2, 3) == 5"]})).json()
        attempt = (await c.post(f"/api/projects/{p['id']}/tasks/{t['id']}/start")).json()
        assert attempt["attempt"] == 1 and attempt["status"] == "running"
        await until(lambda: task_status(p["id"], t["id"]) != "running")
        got = (await c.get(f"/api/projects/{p['id']}/tasks/{t['id']}")).json()
        assert got["status"] == "awaiting_approval"
        steps = got["attempts"][0]["steps"]
        assert steps[0]["kind"] == "route" and "not a trained decision model" in steps[0]["output"]["router"]["label"]
        assert "not a trained" in got["attempts"][0]["router"]
        action = next(s for s in steps if s["kind"] == "action")
        assert action["writes"] == 1 and action["status"] == "awaiting_approval" and action["idempotency_key"]
        ev = {(e["kind"], e["result"], e["change_stage"]) for e in got["evidence"]}
        assert ("test", "supports", "tested") in ev  # a passing sandbox test supports
        assert ("file", "inconclusive", "none") in ev and ("observation", "inconclusive", "none") in ev  # citations aren't proof
        assert ("file", "inconclusive", "proposed") in ev
        assert {e["artifact"] for e in got["evidence"] if e["change_stage"] == "proposed"} == {"calc.py"}  # the project's own name for the file
        assert all(s["status"] == "completed" for s in steps if s["kind"] == "agent")
        # Permission Preview, then approval with the preview's binding
        pv = (await c.get(f"/api/approvals/{action['idempotency_key']}/preview")).json()
        assert pv["kind"] == "code_change" and pv["target"] == [rel] and "undone" in pv["recoverability"]
        r = await c.post(f"/api/approvals/{action['idempotency_key']}/decision", json={"decision": "approved"})
        assert r.status_code == 200, r.text
        got = (await c.get(f"/api/projects/{p['id']}/tasks/{t['id']}")).json()
        assert got["status"] == "completed" and got["attempts"][0]["status"] == "completed"
        applied = [e for e in got["evidence"] if e["change_stage"] == "applied"]
        assert applied and applied[0]["artifact"] == "calc.py" and applied[0]["artifact_sha256"] == store.q1("SELECT sha256 FROM project_files WHERE project_id = ? AND name = 'calc.py'", p["id"])["sha256"]
        usage = (await c.get(f"/api/projects/{p['id']}/usage")).json()
        assert usage["runs"][0]["usage"]["tokensNote"] in ("unavailable", "complete", "partly unavailable")


async def test_resuming_never_repeats_a_change_and_restarts_make_uncertain_actions(make_client, py_runs, monkeypatch):
    p = projects.create({"name": "Notify"})
    grants.grant(p["id"], "Slack", "write")

    def propose(run_id, ctx):
        aid = str(uuid.uuid4())
        actions.save_action(aid, "slack_message", {"channel": "#lab", "text": "Readings uploaded"})
        return [{"id": aid, "description": "Post to #lab", "riskLevel": "medium", "requiresApproval": True}]

    fake_agents(monkeypatch, propose)
    async with make_client():
        t = work.create_task(p["id"], {"title": "Tell the lab"})
        work.start_task(p["id"], t["id"])
        await until(lambda: task_status(p["id"], t["id"]) == "awaiting_approval")
        first = work.get_task(p["id"], t["id"])["attempts"][0]
        key = next(s for s in first["steps"] if s["kind"] == "action")["idempotency_key"]
        # OmniPilot stopped while the action was running: its outcome is uncertain
        store.x("UPDATE pending_actions SET status = 'running' WHERE id = ?", key)
        store.x("UPDATE task_runs SET status = 'running' WHERE id = ?", first["id"])
        store.x("UPDATE project_tasks SET status = 'running' WHERE id = ?", t["id"])
        assert work.reconcile_on_start() == {"interrupted": 1, "uncertain": 1}
        assert task_status(p["id"], t["id"]) == "interrupted"
        step = next(s for s in work.steps(first["id"]) if s["kind"] == "action")
        assert step["status"] == "uncertain"
        # resume: the same message is proposed again, but it isn't queued a second time
        work.resume_task(p["id"], t["id"])
        await until(lambda: task_status(p["id"], t["id"]) not in ("running", "interrupted"))
        second = work.get_task(p["id"], t["id"])["attempts"][0]
        dup = next(s for s in second["steps"] if s["kind"] == "action")
        assert second["attempt"] == 2 and dup["output"]["duplicateOf"] == key and dup["status"] == "completed"
        assert store.get_approval(dup["idempotency_key"])["status"] == "denied"
        # a person checks Slack and records it never went out: the original can be approved again
        assert work.reconcile_step(p["id"], step["id"], "failed")["status"] == "failed"
        assert actions.get_action(key)["status"] == "pending"


async def test_project_actions_need_the_write_grant_and_run_only_the_exact_payload(make_client, py_runs, monkeypatch):
    p = projects.create({"name": "Grants"})

    def propose(run_id, ctx):
        aid = str(uuid.uuid4())
        actions.save_action(aid, "slack_message", {"channel": "#lab", "text": "hello"})
        return [{"id": aid, "description": "Post to #lab", "riskLevel": "medium", "requiresApproval": True}]

    fake_agents(monkeypatch, propose)
    sent = []

    async def fake_slack(params):  # stands in for Slack
        sent.append(params)
        return {"ok": True, "message": "posted (fake)"}

    monkeypatch.setitem(actions.EXECUTORS, "slack_message", fake_slack)
    async with make_client() as c:
        t = work.create_task(p["id"], {"title": "Say hello"})
        work.start_task(p["id"], t["id"])
        await until(lambda: task_status(p["id"], t["id"]) == "awaiting_approval")
        aid = next(s for s in work.get_task(p["id"], t["id"])["attempts"][0]["steps"] if s["kind"] == "action")["idempotency_key"]
        r = await c.post(f"/api/approvals/{aid}/decision", json={"decision": "approved"})
        assert r.status_code == 409 and r.json()["error"] == "not_granted" and not sent
        grants.grant(p["id"], "Slack", "write")
        pv = (await c.get(f"/api/approvals/{aid}/preview")).json()
        assert pv["target"] == "Slack #lab" and pv["payload"]["text"] == "hello" and pv["payload_sha256"]
        r = await c.post(f"/api/approvals/{aid}/decision", json={"decision": "approved", "payloadSha256": "0" * 64})
        assert r.status_code == 409 and r.json()["error"] == "payload_changed" and not sent
        store.x("UPDATE pending_actions SET params = ? WHERE id = ?", json.dumps({"channel": "#general", "text": "hello"}), aid)  # tampered after it was shown
        r = await c.post(f"/api/approvals/{aid}/decision", json={"decision": "approved", "payloadSha256": pv["payload_sha256"]})
        assert r.status_code == 409 and r.json()["error"] == "payload_changed" and not sent
        store.x("UPDATE pending_actions SET params = ? WHERE id = ?", json.dumps({"channel": "#lab", "text": "hello"}), aid)
        r = await c.post(f"/api/approvals/{aid}/decision", json={"decision": "approved", "payloadSha256": pv["payload_sha256"]})
        assert r.status_code == 200 and sent == [{"channel": "#lab", "text": "hello"}]
        assert task_status(p["id"], t["id"]) == "completed"


async def test_a_failed_read_only_step_can_be_retried_and_a_task_cancelled(make_client, py_runs, monkeypatch):
    p = projects.create({"name": "Retry"})
    fake_agents(monkeypatch, fail=("*",))
    async with make_client():
        t = work.create_task(p["id"], {"title": "Explain moisture", "request": "explain soil moisture simply"})
        work.start_task(p["id"], t["id"])
        await until(lambda: task_status(p["id"], t["id"]) != "running")
        failed = [s for s in work.get_task(p["id"], t["id"])["attempts"][0]["steps"] if s["status"] == "failed"]
        assert failed and all(s["kind"] == "agent" for s in failed)
        fake_agents(monkeypatch)
        out = await work.retry_step(p["id"], failed[0]["id"])
        assert out["step"]["status"] == "completed" and json.loads(out["step"]["input"])["retryOf"] == failed[0]["id"]
        ok = next(s for s in work.get_task(p["id"], t["id"])["attempts"][0]["steps"] if s["status"] == "completed")
        with pytest.raises(ProjectError):
            await work.retry_step(p["id"], ok["id"])  # only failed steps
        t2 = work.create_task(p["id"], {"title": "Second"})
        assert work.cancel_task(p["id"], t2["id"])["status"] == "cancelled"


def test_budget_per_run_stops_paid_tools_before_they_are_called():
    from omnipilot_engine.tools.base import BudgetExceeded, RunSpend

    p = projects.create({"name": "Budget"})
    assert projects.set_run_budget(p["id"], 0.01)["runBudgetUsd"] == 0.01
    assert projects.run_scope(p["id"])["runBudgetUsd"] == 0.01
    spend = RunSpend(0.01)
    spend.take(0.008)
    with pytest.raises(BudgetExceeded):
        spend.take(0.005)
    with pytest.raises(ProjectError):
        projects.set_run_budget(p["id"], -1)


async def test_model_usage_is_captured_with_tokens_only_when_reported(monkeypatch):
    async def fake_local(messages, fmt, temperature, max_tokens, timeout, on_token=None, reasoning=False, model=None):  # stands in for Ollama
        llm._note_tokens(12, 5)
        return "fake answer"

    monkeypatch.setattr(llm, "_local", fake_local)
    sink: list = []
    token = llm.usage_sink.set(sink)
    try:
        await llm.chat([{"role": "user", "content": "hi"}])
    finally:
        llm.usage_sink.reset(token)
    assert sink[0]["promptTokens"] == 12 and sink[0]["completionTokens"] == 5 and sink[0]["costUsd"] == 0.0
    s = work.summarize_usage([*sink, {"where": "groq", "model": "m", "ms": 3, "promptTokens": None, "completionTokens": None, "costUsd": None}])
    assert s["promptTokens"] is None and s["tokensNote"] == "partly unavailable" and s["modelCostUsd"] is None


# --- slice 5: Change Radar, trace, readiness ---


def test_change_radar_separates_confirmed_links_from_mentions():
    p = projects.create({"name": "Radar", "requirements": ["Readings logged every morning"]})
    f = projects.add_file(p["id"], "readings.py", b"VALUES = [1, 2]\n")
    projects.add_file(p["id"], "report.py", b"import readings\nprint(readings.VALUES)\n")
    obs = dna.add_fact(p["id"], {"kind": "known_problem", "content": "Two readings only", "basis": "observed", "source_ref": f["id"]})
    mention = dna.add_fact(p["id"], {"kind": "open_question", "content": "Should readings.py hold more data?"})
    ev = work.add_evidence(p["id"], {"kind": "file", "result": "supports", "claim": "Values checked", "artifact": "readings.py"})
    projects.add_file(p["id"], "readings.py", b"VALUES = [1, 2, 3]\n", replace=True)
    alerts = radar.alerts(p["id"])
    by = {(a["affected_kind"], a["affected_ref"]): a["relation"] for a in alerts}
    assert by[("fact", obs["id"])] == "confirmed" and by[("evidence", ev["id"])] == "confirmed" and by[("file", "report.py")] == "confirmed"
    assert by[("fact", mention["id"])] == "suspected"
    assert all(a["explanation"] and a["next_step"] for a in alerts)
    radar.set_alert(p["id"], alerts[0]["id"], "resolved")
    assert len(radar.alerts(p["id"])) == len(alerts) - 1
    # a requirement change: a check written for it is confirmed; a linked decision too
    t = work.create_task(p["id"], {"title": "Log", "acceptance": ["Readings logged each morning by 9"]})
    d = dna.add_fact(p["id"], {"kind": "decision", "content": "Use a spreadsheet", "rationale": "Students know it"})
    radar.link(p["id"], "requirement", "Readings logged every morning", "fact", d["id"], "the spreadsheet is how we log")
    projects.update(p["id"], {"requirements": ["Readings logged every evening"]})
    rel = {(a["affected_kind"], a["affected_ref"]): a["relation"] for a in radar.alerts(p["id"])}
    assert rel[("fact", d["id"])] == "confirmed"
    assert rel[("check", t["acceptance"][0]["id"])] == "suspected"


def test_superseding_a_decision_alerts_linked_work_and_trace_follows_recorded_links_only():
    p = projects.create({"name": "Trace"})
    d = dna.add_fact(p["id"], {"kind": "decision", "content": "Use clay pots", "rationale": "Cheap"})
    t = work.create_task(p["id"], {"title": "Buy pots", "acceptance": ["Ten pots bought"]})
    radar.link(p["id"], "fact", d["id"], "task", t["id"])
    dna.supersede_decision(p["id"], d["id"], {"content": "Use plastic trays", "rationale": "Lighter"})
    a = next(a for a in radar.alerts(p["id"]) if a["affected_ref"] == t["id"])
    assert a["relation"] == "confirmed" and a["trigger_kind"] == "fact"
    tr = radar.trace(p["id"], "fact", d["id"])
    kinds = {n["kind"] for n in tr["nodes"]}
    assert {"fact", "task", "check"} <= kinds
    assert next(e for e in tr["edges"] if e["to"]["kind"] == "task")["note"] == "linked by hand"  # no invented rationale
    with pytest.raises(ProjectError):
        radar.link(p["id"], "fact", d["id"], "task", str(uuid.uuid4()))  # both ends must exist in the project


def test_readiness_reports_each_dimension_honestly():
    p = projects.create({"name": "Ready", "requirements": ["Sum two numbers"]})
    r = radar.readiness(p["id"])
    states = {d["key"]: d["state"] for d in r["dimensions"]}
    assert set(states) >= {"requirements", "tests", "sourcing", "configuration", "handoff", "privacy"}
    assert states["requirements"] == "failed" and states["tests"] == "not_applicable" and states["handoff"] == "not_checked" and states["privacy"] == "passed"
    assert "isn't proof" in r["disclaimer"]
    projects.add_file(p["id"], "calc.py", b"def add(a, b): return a + b\n")
    assert {d["key"]: d["state"] for d in radar.readiness(p["id"])["dimensions"]}["tests"] == "failed"  # code without tests
    t = work.create_task(p["id"], {"title": "Sum", "acceptance": ["Sum two numbers correctly"]})
    e = work.add_evidence(p["id"], {"kind": "test", "result": "supports", "claim": "add(2,3)==5 passed", "artifact": "calc.py",
                                    "artifactSha256": store.q1("SELECT sha256 FROM project_files WHERE name = 'calc.py' AND project_id = ?", p["id"])["sha256"]})
    work.set_check(p["id"], t["acceptance"][0]["id"], "passed", e["id"])
    handoff.build(p["id"], "quick_summary")
    states = {d["key"]: d["state"] for d in radar.readiness(p["id"])["dimensions"]}
    assert states["requirements"] == "passed" and states["tests"] == "passed" and states["handoff"] == "passed"


# --- slice 6: Comparison Bench, branches, Challenge My Plan ---


async def test_comparison_bench_records_measurements_not_opinions(monkeypatch):
    p = projects.create({"name": "Bench"})

    async def fake_chat(messages, **kw):  # stands in for the model
        return {"text": f"answer to {messages[0]['content'][:10]}", "model": "fake-model", "where": "local", "ms": 5}

    monkeypatch.setattr(llm, "chat", fake_chat)
    c = await bench.compare_prompts(p["id"], {"input": "Explain evaporation", "criteria": ["accurate"], "variants": [{"label": "Short", "prompt": "Be brief"}, {"label": "Long", "prompt": "Be thorough"}]})
    assert [r["label"] for r in c["results"]] == ["Short", "Long"] and c["results"][0]["promptTokens"] is None  # not reported -> unknown
    assert any("isn't scored automatically" in x for x in c["limitations"])
    s = await bench.compare_simulations(p["id"], {"variants": [{"label": "Dry", "scenario": "soil moisture 40% evaporation 10%"}, {"label": "Wet", "scenario": "soil moisture 40% evaporation 2%"}]})
    assert all(r["kind"] == "soil_moisture" for r in s["results"]) and s["results"][0]["outputs"]["moistureSeriesPct"][-1] < s["results"][1]["outputs"]["moistureSeriesPct"][-1]
    win = bench.choose_winner(p["id"], s["id"], "Wet", "matches the greenhouse")
    assert win["evidence"]["kind"] == "human" and radar.trace(p["id"], "comparison", s["id"])["edges"]
    with pytest.raises(ProjectError):
        bench.choose_winner(p["id"], s["id"], "Nope")  # only one of the variants can win


async def test_code_comparison_refuses_unsafe_code_and_runs_the_rest_in_the_sandbox(monkeypatch):
    from omnipilot_engine.brain import sandbox

    p = projects.create({"name": "Code bench"})

    async def fake_tests(lang, code, tests):  # stands in for the sandboxed interpreter
        good = "a + b" in code
        return {"ran": True, "passed": len(tests) if good else 0, "total": len(tests), "failures": [] if good else ["add(1, 1) == 2 -> False"], "output": ""}

    monkeypatch.setattr(sandbox, "run_tests", fake_tests)
    monkeypatch.setattr(sandbox, "enabled", lambda: True)
    c = await bench.compare_code(p["id"], {"language": "python", "tests": ["add(1, 1) == 2"], "variants": [
        {"label": "A", "code": "def add(a, b): return a + b"}, {"label": "B", "code": "def add(a, b): return a - b"}, {"label": "C", "code": "import os\ndef add(a, b): return a + b"}]})
    res = {r["label"]: r for r in c["results"]}
    assert res["A"]["passed"] == 1 and res["B"]["passed"] == 0 and res["C"]["ran"] is False and "Not run" in res["C"]["error"]


def test_branches_merge_selectively_and_flag_conflicts():
    p = projects.create({"name": "Branchy"})
    f = dna.add_fact(p["id"], {"kind": "constraint", "content": "Budget 20 dollars"})
    g = dna.add_fact(p["id"], {"kind": "goal", "content": "Grow basil"})
    b = bench.create_branch(p["id"], "Cheaper plan", "try a smaller budget")
    bench.propose(p["id"], b["id"], "edit_fact", {"content": "Budget 10 dollars"}, f["id"])
    bench.propose(p["id"], b["id"], "edit_fact", {"content": "Grow mint"}, g["id"])
    bench.propose(p["id"], b["id"], "add_task", {"title": "Price seeds"})
    assert dna.get_fact(p["id"], f["id"])["content"] == "Budget 20 dollars"  # main project untouched
    dna.edit_fact(p["id"], g["id"], {"content": "Grow basil and thyme"})  # main moved on after the branch read it
    pv = bench.merge_preview(p["id"], b["id"])
    assert len(pv["will_apply"]) == 2 and [c["target_id"] for c in pv["conflicts"]] == [g["id"]]
    with pytest.raises(ProjectError):
        bench.merge(p["id"], b["id"], False)
    out = bench.merge(p["id"], b["id"], True)
    assert len(out["applied"]) == 2 and out["conflicts"]
    assert dna.get_fact(p["id"], f["id"])["content"] == "Budget 10 dollars" and dna.get_fact(p["id"], g["id"])["content"] == "Grow basil and thyme"
    assert [t["title"] for t in work.tasks(p["id"])] == ["Price seeds"]


async def test_challenge_my_plan_is_labelled_and_can_feed_the_inbox(monkeypatch):
    p = projects.create({"name": "Plan", "requirements": ["Water daily"]})

    async def fake_chat(messages, **kw):  # stands in for the model
        return {"text": json.dumps({"points": [{"assumption": "Tap water is fine", "why_it_matters": "Chlorine may harm seedlings", "missing_evidence": "No water test",
                                                "smallest_test": "Grow two trays", "would_change_plan": "Seedlings on tap water do worse", "severity": "high"}]}),
                "model": "fake-model", "where": "local", "ms": 1}

    monkeypatch.setattr(llm, "chat", fake_chat)
    c = await bench.challenge(p["id"])
    assert c["model"] == "local:fake-model" and "not checked facts" in c["label"] and c["items"][0]["smallest_test"] == "Grow two trays"
    a = bench.send_to_inbox(p["id"], c["id"], 0)
    assert a["status"] == "unverified" and a["statement"] == "Tap water is fine"
    assert dna.facts(p["id"]) == []  # nothing became a fact
    with pytest.raises(ProjectError):
        bench.send_to_inbox(p["id"], c["id"], 0)

    async def no_model(messages, **kw):
        raise llm.NoModel("none")

    monkeypatch.setattr(llm, "chat", no_model)
    with pytest.raises(ProjectError) as e:
        await bench.challenge(p["id"])
    assert e.value.status == 503


# --- slice 7: Learn Mode, Return Briefing ---


async def test_teach_back_is_opt_in_and_notes_stay_out_of_project_facts(monkeypatch):
    p = projects.create({"name": "Learn"})

    async def fake_chat(messages, **kw):  # stands in for the model
        return {"text": "You got the main idea; you missed X.", "model": "fake-model", "where": "local", "ms": 1}

    monkeypatch.setattr(llm, "chat", fake_chat)
    with pytest.raises(ProjectError) as e:
        await learn.teach(p["id"], "explain", "recursion")
    assert e.value.code == "learn_mode_off"
    learn.set_learn_mode(p["id"], True)
    with pytest.raises(ProjectError):
        await learn.teach(p["id"], "check", "recursion")  # checking needs the learner's explanation
    n = await learn.teach(p["id"], "check", "recursion", user_input="A function that calls itself")
    assert n["mode"] == "check" and n["model"] == "local:fake-model"
    assert dna.facts(p["id"]) == [] and "learning_notes" not in json.dumps(projects.export(p["id"]))


def test_return_briefing_lists_what_changed_since_the_last_visit():
    p = projects.create({"name": "Brief"})
    learn.seen(p["id"])
    assert learn.briefing(p["id"])["changes"] == 0
    dna.add_fact(p["id"], {"kind": "goal", "content": "Grow basil"})
    work.create_task(p["id"], {"title": "Plant"})
    b = learn.briefing(p["id"], mark_seen=True)
    assert b["changes"] == 2 and set(b["groups"]) == {"Project DNA and assumptions", "Work"}
    assert learn.briefing(p["id"])["changes"] == 0


# --- slice 8: Handoff Capsules, recipes, routines ---


def test_handoff_capsules_use_presets_let_items_be_removed_and_never_carry_secrets(monkeypatch):
    monkeypatch.setenv("FAKE_SERVICE_API_KEY", "sk-test-HANDOFF-MUST-NOT-LEAK-99")
    p = projects.create({"name": "Handoff", "description": "uses sk-test-HANDOFF-MUST-NOT-LEAK-99", "requirements": ["Water daily", "Log weekly"]})
    dna.add_fact(p["id"], {"kind": "decision", "content": "Basil", "rationale": "Grows fast"})
    pv = handoff.preview(p["id"], "teammate")
    brief = next(s for s in pv["sections"] if s["key"] == "brief")
    drop = next(i["id"] for i in brief["items"] if "Log weekly" in i["text"])
    out = handoff.build(p["id"], "teammate", [drop])
    assert "Log weekly" not in out["markdown"] and "Water daily" in out["markdown"]
    assert "HANDOFF-MUST-NOT-LEAK" not in out["markdown"] and "HANDOFF-MUST-NOT-LEAK" not in json.dumps(out["json"])
    assert out["json"]["ai_disclosure"] and set(handoff.PRESETS) == {"quick_summary", "teammate", "teacher", "technical"}
    with pytest.raises(ProjectError):
        handoff.preview(p["id"], "everything")


async def test_recipes_carry_no_project_data_and_routines_start_once_a_day(make_client, py_runs, monkeypatch):
    fake_agents(monkeypatch)
    p = projects.create({"name": "Recipes"})
    grants.grant(p["id"], "Slack", "write")
    t = work.create_task(p["id"], {"title": "Weekly summary", "request": "Summarise this week's readings", "acceptance": ["Mentions every soil"]})
    r = recipes.from_task(p["id"], t["id"], "Weekly summary")
    shared = recipes.portable(r["id"])
    assert set(shared) == {"format", "name", "description", "inputs", "steps", "acceptance", "outputs"} and p["id"] not in json.dumps(shared)
    with pytest.raises(ProjectError):
        recipes.create({"name": "Bad", "steps": ["Look at {{topic}}"]})  # undeclared input
    topic = recipes.create({"name": "Explain", "inputs": [{"name": "topic"}], "steps": ["Explain {{topic}} simply"], "acceptance": ["Covers {{topic}}"]})
    other = projects.create({"name": "Elsewhere"})
    async with make_client():
        run = recipes.run_in_project(topic["id"], other["id"], {"topic": "osmosis"})
        assert run["task"]["acceptance"][0]["text"] == "Covers osmosis" and run["task"]["recipe_id"] == topic["id"]
        assert grants.grants_for(other["id"]) == []  # grants don't travel with recipes
        recipes.add_routine(topic["id"], other["id"], "07:30", {"topic": "capillarity"})
        at = dt.datetime(2026, 10, 20, 8, 0)
        assert len(recipes.run_due(at)) == 1 and recipes.run_due(at) == []  # once per day
        assert recipes.run_due(dt.datetime(2026, 10, 20, 7, 0)) == []
        await work.wait_for_attempts()


def test_grants_are_per_project_and_reads_need_the_read_grant():
    p, q = projects.create({"name": "A"}), projects.create({"name": "B"})
    grants.grant(p["id"], "Gmail", "read")
    assert grants.has(p["id"], "Gmail", "read") and not grants.has(q["id"], "Gmail", "read")
    token = projects.current.set(projects.run_scope(q["id"]))
    try:
        assert "hasn't been given read access to Gmail" in grants.read_problem("Gmail")
    finally:
        projects.current.reset(token)
    with pytest.raises(ProjectError):
        grants.grant(p["id"], "Fax", "read")
    grants.revoke(p["id"], "Gmail", "read")
    assert grants.grants_for(p["id"]) == []


async def test_new_routes_keep_projects_isolated_and_need_sign_in(make_client, py_runs):
    async with make_client() as c:
        a = (await c.post("/api/projects", json={"name": "Alpha"})).json()
        b = (await c.post("/api/projects", json={"name": "Beta"})).json()
        t = (await c.post(f"/api/projects/{a['id']}/tasks", json={"title": "Secret task"})).json()
        assert (await c.get(f"/api/projects/{b['id']}/tasks/{t['id']}")).status_code == 404
        assert (await c.get(f"/api/projects/{b['id']}/tasks")).json()["tasks"] == []
        for path in ("alerts", "evidence", "links", "branches", "comparisons", "challenges", "handoffs", "briefing", "permissions", "usage", "learn", "routines"):
            assert (await c.get(f"/api/projects/{a['id']}/{path}")).status_code == 200, path
        r = await c.post(f"/api/projects/{a['id']}/readiness")
        assert r.status_code == 200 and r.json()["dimensions"]
    async with make_client(owner_password_set=True) as c:
        r = await c.get(f"/api/projects/{a['id']}/tasks", headers={"x-forwarded-for": "203.0.113.9"})
        assert r.status_code in (401, 403)


# --- regressions found in the live run ---


def test_export_privacy_check_doesnt_mistake_ordinary_words_for_secrets(monkeypatch):
    p = projects.create({"name": "Words", "description": "the task_attempt_finished_event_kind is ordinary text"})
    assert {d["key"]: d["state"] for d in radar.readiness(p["id"])["dimensions"]}["privacy"] == "passed"


def test_evidence_about_a_file_is_pinned_whatever_its_kind_and_flags_the_change():
    p = projects.create({"name": "Pin"})
    projects.add_file(p["id"], "r.txt", b"peat 63%")
    e = work.add_evidence(p["id"], {"kind": "human", "result": "supports", "claim": "Checked the readings", "artifact": "r.txt"})
    assert e["artifact_sha256"]
    projects.add_file(p["id"], "r.txt", b"peat 63%\nloam 58%", replace=True)
    assert any(a["affected_ref"] == e["id"] and a["relation"] == "confirmed" for a in radar.alerts(p["id"]))


async def test_an_agent_answering_with_stated_limits_is_a_completed_step(make_client, py_runs, monkeypatch):
    from omnipilot_engine.brain import agents

    async def partial(name, input, ctx):  # stands in for ScienceLab using default inputs
        return {"status": "partial_success" if name != "CodePilot" else "needs_approval", "findings": ["Ran a simulation with defaults (fake)."], "evidence": [], "confidence": 0.6, "limitations": ["defaults used"], "proposedActions": []}

    monkeypatch.setattr(agents, "run", partial)
    p = projects.create({"name": "Partial"})
    async with make_client():
        t = work.create_task(p["id"], {"title": "Simulate drying"})
        work.start_task(p["id"], t["id"])
        await until(lambda: task_status(p["id"], t["id"]) != "running")
        assert all(s["status"] == "completed" for s in work.get_task(p["id"], t["id"])["attempts"][0]["steps"])


def test_inside_a_project_codepilot_edits_the_projects_own_files_and_keeps_paths_inside_it():
    from omnipilot_engine.brain.agents import code_pilot

    p = projects.create({"name": "Own files"})
    projects.add_file(p["id"], "calc.py", b"def add(a, b):\n    return a - b\n")
    root = str(projects.files_dir(p["id"]))
    own = code_pilot.project_folder_edit("Fix the bug in calc.py so add(2, 3) returns 5", root)
    assert own and own.folder == "." and own.files == ["./calc.py"]
    assert patches.to_workspace_rel(root, f"{own.folder}/calc.py") == f".omnipilot-projects/{p['id']}/calc.py"
    assert code_pilot.project_folder_edit("Review calc.py for security issues", root) is None  # reviews still go to the scanner
    assert code_pilot.project_folder_edit("Fix the weather forecast", root) is None  # nothing in the project is named


async def test_a_run_stops_saying_it_needs_approval_once_everything_is_decided(make_client, py_runs, monkeypatch):
    """A run waited at "needs approval" for ever, even after every change had been decided."""
    p = projects.create({"name": "Settle"})
    grants.grant(p["id"], "Slack", "write")
    ids = []

    def propose(run_id, ctx):
        out = []
        for text in ("first", "second"):
            aid = str(uuid.uuid4())
            actions.save_action(aid, "slack_message", {"channel": "#lab", "text": text})
            ids.append(aid)
            out.append({"id": aid, "description": f"Post {text}", "riskLevel": "medium", "requiresApproval": True})
        return out

    fake_agents(monkeypatch, propose)
    monkeypatch.setitem(actions.EXECUTORS, "slack_message", lambda params: _ok())
    async with make_client() as c:
        t = work.create_task(p["id"], {"title": "Tell the lab twice"})
        work.start_task(p["id"], t["id"])
        await until(lambda: task_status(p["id"], t["id"]) == "awaiting_approval")
        run_id = work.get_task(p["id"], t["id"])["attempts"][0]["run_id"]
        assert store.get_run(run_id)["status"] == "needs_approval"
        assert (await c.post(f"/api/approvals/{ids[0]}/decision", json={"decision": "approved"})).status_code == 200
        assert store.get_run(run_id)["status"] == "needs_approval"  # the other one is still waiting
        assert (await c.post(f"/api/approvals/{ids[1]}/decision", json={"decision": "denied"})).status_code == 200
        run = store.get_run(run_id)
        assert run["status"] == "completed" and run["data"]["status"] == "completed"


async def test_stopping_a_task_also_settles_its_run(make_client, py_runs, monkeypatch):
    p = projects.create({"name": "Stop settles"})

    def propose(run_id, ctx):
        aid = str(uuid.uuid4())
        actions.save_action(aid, "slack_message", {"channel": "#lab", "text": "hi"})
        return [{"id": aid, "description": "Post hi", "riskLevel": "medium", "requiresApproval": True}]

    fake_agents(monkeypatch, propose)
    async with make_client():
        t = work.create_task(p["id"], {"title": "Say hi"})
        work.start_task(p["id"], t["id"])
        await until(lambda: task_status(p["id"], t["id"]) == "awaiting_approval")
        run_id = work.get_task(p["id"], t["id"])["attempts"][0]["run_id"]
        work.cancel_task(p["id"], t["id"])
        assert store.get_run(run_id)["status"] == "completed"  # nothing is waiting any more


async def test_conversation_runs_are_metered_too(make_client, py_runs, monkeypatch):
    """Conversation runs (not just task attempts) record model usage, and it shows in the project usage view."""
    from omnipilot_engine.brain import agents

    async def talking_agent(name, input, ctx):  # a specialist that actually calls the model (faked below)
        await llm.generate_text("be brief", input["requestText"])
        return {"status": "success", "findings": ["answered (fake)"], "evidence": [], "confidence": 0.9, "limitations": [], "proposedActions": []}

    async def fake_local(messages, fmt, temperature, max_tokens, timeout, on_token=None, reasoning=False, model=None):
        llm._note_tokens(40, 8)
        return "a brief answer"

    monkeypatch.setattr(agents, "run", talking_agent)
    monkeypatch.setattr(llm, "_local", fake_local)
    p = projects.create({"name": "Metered chat"})
    async with make_client() as c:
        conv = (await c.post(f"/api/projects/{p['id']}/conversations", json={"title": "Q"})).json()
        run_id = (await c.post(f"/api/projects/{p['id']}/conversations/{conv['id']}/messages", json={"message": "hello there"})).json()["runId"]
        await until(lambda: (store.get_run(run_id) or {}).get("status") not in ("running", None))
        usage = store.get_run(run_id)["data"].get("usage")
        assert usage and usage["modelCalls"] >= 1 and usage["promptTokens"] == 40 * usage["modelCalls"]
        u = (await c.get(f"/api/projects/{p['id']}/usage")).json()
        assert any(r["id"] == run_id for r in u["conversationRuns"]) and u["totals"]["modelCalls"] >= 1


async def test_the_model_reasoning_is_captured_separately_from_the_answer(monkeypatch):
    """When a call asks to reason and the model emits its working, it's captured apart from the answer."""
    async def fake_local(messages, fmt, temperature, max_tokens, timeout, on_token=None, reasoning=False, model=None):
        if reasoning:
            llm._note_reasoning("First I ranked the soils, then I picked the highest.")
        return "Peat holds the most."

    monkeypatch.setattr(llm, "_local", fake_local)
    sink: list = []
    token = llm.reasoning_sink.set(sink)
    try:
        plain = await llm.generate_text("sys", "no reasoning wanted")
        assert plain == "Peat holds the most." and sink == []  # nothing captured unless asked
        answer = await llm.generate_text("sys", "rank them", reasoning=True)
    finally:
        llm.reasoning_sink.reset(token)
    assert answer == "Peat holds the most."  # the reasoning never leaks into the answer
    assert len(sink) == 1 and sink[0]["where"] == "local" and "ranked the soils" in sink[0]["text"]


async def test_a_run_collects_reasoning_onto_its_record(make_client, py_runs, monkeypatch):
    from omnipilot_engine.brain import agents, synthesis

    seen = {}

    async def two_agents(name, input, ctx):  # two agents answer, so the synthesizer composes a final answer
        seen["sink_is_list"] = isinstance(llm.reasoning_sink.get(), list)
        return {"status": "success", "findings": [f"{name}: a point with code `x`"], "evidence": [], "confidence": 0.9, "limitations": [], "proposedActions": []}

    async def fake_compose(run_id, request, results, on_token=None):
        llm._note_reasoning("weighed both findings")  # a reasoning model would emit this
        llm._record_reasoning("local", "fake-model")
        return "Combined answer."

    monkeypatch.setattr(agents, "run", two_agents)
    monkeypatch.setattr(synthesis, "compose_answer", fake_compose)
    p = projects.create({"name": "Reasoned"})
    async with make_client():
        t = work.create_task(p["id"], {"title": "Explain two things", "request": "explain soil and water together"})
        monkeypatch.setattr("omnipilot_engine.brain.routing.route_request", _two_agent_plan)
        work.start_task(p["id"], t["id"])
        await until(lambda: task_status(p["id"], t["id"]) != "running")
        run_id = work.get_task(p["id"], t["id"])["attempts"][0]["run_id"]
    assert seen.get("sink_is_list") is True  # the reasoning sink was active during the run
    reasoning = (store.get_run(run_id)["data"] or {}).get("reasoning")
    assert reasoning and reasoning[0]["text"] == "weighed both findings"


async def _two_agent_plan(text):
    return {"selectedAgents": ["Helper", "ScienceLab"], "capabilities": ["Helper", "ScienceLab"], "skills": {},
            "rationale": {"Helper": "x", "ScienceLab": "y"}, "scores": {"Helper": 1, "ScienceLab": 1}, "routingMode": "heuristic"}


def test_reasoning_visibility_toggles_and_defaults_off(monkeypatch):
    monkeypatch.setenv("OMNIPILOT_UI", "off")
    from omnipilot_engine.ui import work_pages as wp

    assert wp.reasoning_shown() is False  # hidden until the logo is clicked
    assert wp.toggle_reasoning() is True and wp.reasoning_shown() is True
    assert wp.toggle_reasoning() is False and wp.reasoning_shown() is False
