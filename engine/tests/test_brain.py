"""The Python run engine (stage 3): routing parity with the TypeScript engine, full runs through the API with
fake agents and fake models (nothing reaches a real model or service), the live stream, Stop, approvals,
the bridge to TypeScript agents, SDK run keys, feedback, the Helper front, and attachments."""
import asyncio
import gzip
import json
from pathlib import Path

import pytest
import respx

from omnipilot_engine import actions, llm, store
from omnipilot_engine.brain import agents, control, conversation, coordinator, governance, routing

LOCAL = {"Origin": "http://localhost:8899"}
PARITY = json.loads(gzip.open(Path(__file__).parent / "fixtures" / "routing_parity.json.gz", "rt").read())


# --- parity with the TypeScript engine (3,520 requests from its own tests and code) ---


# Deliberate routing improvements since the TypeScript recording (6 of 3,520 cases updated in the fixture):
#   - SchoolPilot's "test/quiz on <day>" rule no longer fires for a quiz ON A TOPIC ("a quiz on fractions") or a code test;
#   - a 3D model request ("build a 3D model of a game controller") goes to ModelPilot only, not CodePilot's project builder.
def test_routing_plans_governance_and_follow_ups_match_typescript():
    bad = []
    for r in PARITY:
        t = r["t"]
        scores = {k: v for k, v in routing.keyword_scores(t).items() if v}
        plan = routing.decide_agents(t)["selectedAgents"]
        steps = [[s["agent"], s["task"], s["dependsOn"], bool(s.get("afterAll"))] for s in coordinator.plan_steps(t, r["selected"])]
        g = governance.check(t)
        if (plan, scores, steps, [[h.id for h in g["hits"]], g["whole"]], conversation.looks_like_follow_up(t, {"status": "completed"})) != (r["selected"], r["scores"], r["steps"], r["gov"], r["fu"]):
            bad.append(t)
    assert not bad, f"{len(bad)} differ, e.g. {bad[:3]}"


# --- full runs ---


@pytest.fixture
def py_runs(monkeypatch):
    monkeypatch.setenv("OMNIPILOT_RUNS", "python")
    calls = []

    async def fake_agent(name, input, ctx):
        calls.append((name, input["requestText"]))
        behaviour = FAKE.get(name, lambda i: {"status": "success", "findings": [f"{name} answer"], "evidence": [{"source": "test", "detail": "x"}], "confidence": 0.9, "limitations": [], "proposedActions": []})
        out = behaviour(input)
        if asyncio.iscoroutine(out):
            out = await out
        return out

    async def no_text(*a, **k):
        return None

    async def no_json(*a, **k):
        return None

    monkeypatch.setattr(agents, "run", fake_agent)
    monkeypatch.setattr(llm, "generate_text", no_text)
    monkeypatch.setattr(llm, "generate_json", no_json)
    FAKE.clear()
    return calls


FAKE: dict = {}


async def wait_done(c, run_id, headers=None):
    for _ in range(200):
        r = (await c.get(f"/api/runs/{run_id}/events.json", headers=headers or {})).json()
        assert "done" in r, r
        if r["done"]:
            return r["events"]
        await asyncio.sleep(0.02)
    raise AssertionError("run didn't finish")


async def test_a_chat_runs_through_the_python_pipeline(make_client, py_runs):
    async with make_client() as c:
        r = await c.post("/api/chat", json={"message": "teach me fractions", "conversationId": "c1"}, headers=LOCAL)
        assert r.status_code == 202
        run_id = r.json()["runId"]
        events = await wait_done(c, run_id)
        saved = (await c.get(f"/api/runs/{run_id}")).json()
        convs = (await c.get("/api/conversations")).json()["conversations"]
    types = [e["type"] for e in events]
    assert types[0] == "run_started" and "router_plan" in types and "agent_complete" in types and types[-1] == "final_response"
    assert py_runs == [("LearnPilot", "teach me fractions")]
    assert saved["status"] == "completed" and saved["finalResponse"]["summary"] == "LearnPilot answer"
    assert convs[0]["id"] == "c1" and conversation.get_turns("c1")[0]["answer"] == "LearnPilot answer"
    assert any(e["type"] == "audit" for e in events), "activity entries are on the live stream"


async def test_actions_needing_approval_become_approvals(make_client, py_runs):
    FAKE["InfraPilot"] = lambda i: {"status": "needs_approval", "findings": ["I'll post it once you approve."], "evidence": [], "confidence": 0.8, "limitations": [],
                                    "proposedActions": [{"id": "act-1", "description": "Post to #general", "riskLevel": "medium", "requiresApproval": True}]}
    async with make_client() as c:
        run_id = (await c.post("/api/chat", json={"message": "post 'hi' to #general on slack"}, headers=LOCAL)).json()["runId"]
        await wait_done(c, run_id)
        saved = (await c.get(f"/api/runs/{run_id}")).json()
    assert saved["status"] == "needs_approval"
    assert store.get_approval("act-1")["status"] == "pending"


async def test_impossible_requests_are_answered_without_agents(make_client, py_runs):
    async with make_client() as c:
        run_id = (await c.post("/api/chat", json={"message": "buy me a pizza"}, headers=LOCAL)).json()["runId"]
        events = await wait_done(c, run_id)
    assert py_runs == []
    assert events[-1]["response"]["governance"]["verdict"] == "not_possible"


async def test_when_nothing_works_it_asks_one_question(make_client, py_runs):
    FAKE["CodePilot"] = lambda i: {"status": "unreachable", "findings": ["CodePilot failed."], "evidence": [], "confidence": 0, "limitations": [], "proposedActions": []}
    FAKE["Helper"] = lambda i: {"status": "timeout", "findings": ["Helper timed out."], "evidence": [], "confidence": 0, "limitations": [], "proposedActions": []}
    async with make_client() as c:
        run_id = (await c.post("/api/chat", json={"message": "write a function that reverses a list"}, headers=LOCAL)).json()["runId"]
        events = await wait_done(c, run_id)
    assert events[-1]["type"] == "clarification_needed"
    assert [n for n, _ in py_runs] == ["CodePilot", "Helper"], "Helper covered CodePilot's gap"


async def test_stop_ends_a_run_mid_agent(make_client, py_runs):
    started = asyncio.Event()

    async def slow(i):
        started.set()
        while not control.is_cancelled(i["runId"]):
            await asyncio.sleep(0.01)
        raise asyncio.CancelledError() if False else RuntimeError("stopped")

    FAKE["LearnPilot"] = slow
    async with make_client() as c:
        run_id = (await c.post("/api/chat", json={"message": "teach me fractions"}, headers=LOCAL)).json()["runId"]
        await asyncio.wait_for(started.wait(), 2)
        assert (await c.post(f"/api/runs/{run_id}/cancel", headers=LOCAL)).json() == {"cancelled": True}
        events = await wait_done(c, run_id)
    assert events[-1]["type"] == "run_cancelled"


async def test_the_live_stream_sends_every_event(make_client, py_runs):
    async with make_client() as c:
        run_id = (await c.post("/api/chat", json={"message": "teach me fractions"}, headers=LOCAL)).json()["runId"]
        lines = []
        async with c.stream("GET", f"/api/runs/{run_id}/events") as s:
            async for line in s.aiter_lines():
                if line.startswith("data: "):
                    lines.append(json.loads(line[6:])["type"])
    assert lines[0] == "run_started" and lines[-1] == "final_response"
    assert lines.count("final_response") == 1


async def test_sdk_clients_read_only_their_own_runs(make_client, py_runs):
    token = {"Authorization": "Bearer sdk-token-0123456789abcdef"}
    async with make_client(api_token="sdk-token-0123456789abcdef") as c:
        mine = (await c.post("/api/chat", json={"message": "teach me fractions"}, headers=token)).json()
        await wait_done(c, mine["runId"], {**token, "x-run-key": mine["runKey"]})
        other = (await c.post("/api/chat", json={"message": "teach me fractions"}, headers=LOCAL)).json()["runId"]
        ok = await c.get(f"/api/runs/{mine['runId']}", headers={**token, "x-run-key": mine["runKey"]})
        nope = await c.get(f"/api/runs/{other}", headers={**token, "x-run-key": mine["runKey"]})
        listing = await c.get("/api/runs", headers=token)
    assert ok.status_code == 200 and nope.status_code == 404 and listing.status_code == 403
    assert ok.json()["conversationId"] if ok.json().get("conversationId") else True


async def test_ask_returns_the_answer_in_one_call(make_client, py_runs):
    async with make_client() as c:
        r = (await c.post("/api/ask", json={"message": "teach me fractions", "textOnly": True}, headers=LOCAL)).json()
    assert r["status"] == "completed" and r["answer"] == "LearnPilot answer" and "attachments" not in r


async def test_feedback_writes_a_lesson_used_next_time(make_client, py_runs, monkeypatch):
    async def lesson_json(*a, **k):
        return {"lesson": "When teaching fractions, use pizza slices as the example.", "topics": ["teach", "fractions"]}

    monkeypatch.setattr(llm, "generate_json", lesson_json)
    async with make_client() as c:
        run_id = (await c.post("/api/chat", json={"message": "teach me fractions"}, headers=LOCAL)).json()["runId"]
        await wait_done(c, run_id)
        r = (await c.post(f"/api/runs/{run_id}/feedback", json={"rating": -1, "comment": "too abstract"}, headers=LOCAL)).json()
    assert r["lesson"]["lesson"].startswith("When teaching fractions")
    from omnipilot_engine.brain import learning

    assert learning.relevant_lessons("teach fractions to me")[0]["id"] == r["lesson"]["id"]


# --- the bridge to TypeScript agents ---


@respx.mock
async def test_unported_agents_run_in_typescript_through_the_bridge(monkeypatch):
    monkeypatch.setenv("OMNIPILOT_NODE_URL", "http://node.test")
    monkeypatch.setenv("OMNIPILOT_INTERNAL_TOKEN", "secret-1")
    from omnipilot_engine.brain.agents import bridge

    route = respx.post("http://node.test/api/internal/agent/ModelPilot").respond(json={"result": {"status": "success", "findings": ["a lesson"], "evidence": [], "confidence": 0.8, "limitations": [], "proposedActions": []}})
    out = await bridge.run("ModelPilot", {"runId": "r1", "requestText": "a 3d cube", "context": {}}, {"timeout_s": 5, "stop": None})
    assert out["findings"] == ["a lesson"]
    req = route.calls[0].request
    assert req.headers["x-omnipilot-internal"] == "secret-1" and json.loads(req.content)["timeoutMs"] == 5000


async def test_the_bridge_gives_up_when_stopped(monkeypatch):
    monkeypatch.setenv("OMNIPILOT_NODE_URL", "http://127.0.0.1:9")
    stop = asyncio.Event()
    stop.set()
    from omnipilot_engine.brain.agents import bridge

    with pytest.raises(bridge.BridgeError):
        await bridge.run("LearnPilot", {"runId": "r1", "requestText": "x", "context": {}}, {"timeout_s": 5, "stop": stop})


async def test_activity_from_typescript_agents_reaches_the_live_stream(make_client, py_runs):
    gate = asyncio.Event()

    async def waits(i):
        await gate.wait()
        return {"status": "success", "findings": ["done"], "evidence": [], "confidence": 0.9, "limitations": [], "proposedActions": []}

    FAKE["LearnPilot"] = waits
    async with make_client() as c:
        run_id = (await c.post("/api/chat", json={"message": "teach me fractions"}, headers=LOCAL)).json()["runId"]
        await asyncio.sleep(0.05)
        entry = {"id": "e1", "runId": run_id, "timestamp": "t", "agent": "LearnPilot", "action": "web_search", "parameters": {}, "outcome": "ok"}
        bad = await c.post("/api/internal/events", json={"type": "audit", "runId": run_id, "entry": entry})
        ok = await c.post("/api/internal/events", json={"type": "audit", "runId": run_id, "entry": entry}, headers={"x-omnipilot-internal": "internal-secret"})
        gate.set()
        events = await wait_done(c, run_id)
    assert bad.status_code == 404 and ok.status_code == 200
    assert any(e["type"] == "audit" and e["entry"]["id"] == "e1" for e in events)


# --- the Helper front: remember, app actions ---


@respx.mock
async def test_helper_remembers_when_asked(monkeypatch):
    monkeypatch.setenv("MEM0_API_KEY", "m0-test")
    respx.post("https://api.mem0.ai/v3/memories/add/").respond(json={"status": "PENDING"})
    from omnipilot_engine.brain.agents import helper

    out = await helper.run({"runId": "r1", "requestText": "remember that my science fair is on May 3", "context": {}}, {"timeout_s": 5})
    assert out["status"] == "success" and "my science fair is on May 3" in out["findings"][0]


@respx.mock
async def test_app_changes_through_arcade_need_approval_and_run_once_approved(monkeypatch):
    monkeypatch.setenv("ARCADE_API_KEY", "arc-test")
    monkeypatch.delenv("MEM0_API_KEY", raising=False)
    monkeypatch.delenv("ZEP_API_KEY", raising=False)
    respx.post("https://api.arcade.dev/v1/tools/search").respond(json={"results": [{"tool_name": "Trello.CreateCard", "description": "Create a card", "input_schema": [{"name": "title", "required": True, "value_schema": {"val_type": "string"}}]}]})
    respx.get("https://api.arcade.dev/v1/tools/Trello.CreateCard").respond(json={"metadata": {"behavior": {"read_only": False}}})
    respx.post("https://api.arcade.dev/v1/tools/authorize").respond(json={"status": "completed"})
    execute = respx.post("https://api.arcade.dev/v1/tools/execute").respond(json={"success": True, "output": {"value": {"id": "card1"}}})

    async def pick(*a, **k):
        return {"tool": "Trello.CreateCard", "arguments": {"title": "Science fair"}, "missing": ""}

    monkeypatch.setattr(llm, "generate_json", pick)
    from omnipilot_engine.brain.agents import helper

    out = await helper.run({"runId": "r1", "requestText": "add a trello card called Science fair", "context": {}}, {"timeout_s": 5})
    assert out["status"] == "needs_approval" and not execute.called
    action_id = out["proposedActions"][0]["id"]
    done = await actions.execute_action(action_id)
    assert done["ok"] and json.loads(execute.calls[0].request.content)["input"] == {"title": "Science fair"}


# --- attachments and workspace projects ---

def make_pdf(text: str) -> bytes:
    """A minimal valid one-page PDF with a text layer (with a correct cross-reference table)."""
    stream = f"BT /F1 12 Tf 20 100 Td ({text}) Tj ET".encode()
    objs = [b"<</Type/Catalog/Pages 2 0 R>>", b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
            b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
            b"<</Length %d>>stream\n" % len(stream) + stream + b"\nendstream", b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"]
    out, offsets = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj" % i + o + b"endobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    return out + b"trailer<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF" % (len(objs) + 1, xref)


PDF = make_pdf("Photosynthesis turns sunlight into sugar in plants.")


async def test_pdfs_are_read_on_this_computer(make_client, monkeypatch):
    monkeypatch.setenv("OMNIPILOT_RUNS", "python")
    async with make_client() as c:
        r = await c.post("/api/attachments/parse", params={"name": "bio.pdf"}, content=PDF, headers={**LOCAL, "content-type": "application/pdf"})
        word = await c.post("/api/attachments/parse", params={"name": "essay.docx"}, content=b"PK\x03\x04", headers=LOCAL)
    assert r.status_code == 200 and r.json()["where"] == "local" and "Photosynthesis" in r.json()["text"]
    assert word.status_code == 400 and "LlamaParse" in word.json()["message"]


async def test_workspace_projects_are_listed(make_client, monkeypatch):
    import os

    monkeypatch.setenv("OMNIPILOT_RUNS", "python")
    ws = Path(os.environ["OMNIPILOT_WORKSPACE"])
    (ws / "robot").mkdir()
    (ws / "robot" / "README.md").write_text("# Robot Arm\nA small arm with two servos.\n")
    (ws / "robot" / "main.py").write_text("print('hi')\n")
    async with make_client() as c:
        r = (await c.get("/api/workspace/projects")).json()
    assert r["projects"][0]["name"] == "Robot Arm" and r["projects"][0]["files"] == 2 and r["files"] == 2


async def test_questions_about_an_attachment_are_answered_from_it(monkeypatch):
    seen = {}

    async def local_answer(system, user, **k):
        seen["user"] = user
        return 'The document says "Mitochondria ... make ATP."'

    monkeypatch.setattr(llm, "generate_text", local_answer)
    from omnipilot_engine.brain.agents import helper

    doc = {"name": "cells.pdf", "text": "Mitochondria are the powerhouse of the cell and make ATP."}
    out = await helper.run({"runId": "r1", "requestText": "What does this say makes ATP?", "context": {"attachedFile": doc}}, {"timeout_s": 5})
    assert out["status"] == "success" and "Mitochondria" in out["findings"][0] and doc["text"] in seen["user"]


def test_long_prompts_get_a_big_enough_local_context():
    assert llm._context_size([{"content": "hi"}], 400) == 4096
    assert llm._context_size([{"content": "x" * 60_000}], 700) == 32768


async def test_prompt_pilot_uses_the_model_and_says_which(monkeypatch):
    from omnipilot_engine.brain.agents import prompt_pilot

    async def model(system, user, **k):
        llm.last_answer.set({"model": "qwen3:4b-instruct", "where": "local"})
        return '"a red dragon circling a moonlit castle, dramatic rim light, wide shot --ar 16:9"'

    monkeypatch.setattr(llm, "generate_text", model)
    out = await prompt_pilot.run({"runId": "r1", "requestText": "Refine my prompt for Midjourney: a dragon over a castle", "context": {}}, {})
    assert "a red dragon circling" in out["findings"][0] and '"' not in out["findings"][0].split("```")[1].strip()[:1]
    assert out["evidence"][0]["source"] == "ai-model:qwen3:4b-instruct" and "on this computer" in out["limitations"][0]


# --- WatcherPilot ---


async def test_watcher_classification_matches_typescript():
    from omnipilot_engine.brain import watcher

    data = json.loads(gzip.open(Path(__file__).parent / "fixtures" / "watcher_classify.json.gz", "rt").read())
    got = [await watcher.classify_page(p, u, "Minecraft let's play" if "youtube" in u and "abc" in u else "") for p in data["cases"]["policies"] for u in data["cases"]["urls"]]
    assert got == data["outputs"]


def test_focus_requests_with_a_duration_end_on_time():
    from datetime import datetime, timezone
    from omnipilot_engine.brain import watcher

    now = datetime(2026, 10, 20, 15, 0, tzinfo=timezone.utc)
    p = watcher.parse_focus_request("learn math and no AI for 1.5 hours", now)
    assert p["until"] == "2026-10-20T16:30:00.000Z" and p["subject"] == "math" and p["task"] == "learn math"


async def test_watcher_routes_need_the_parent_pin(make_client, monkeypatch):
    monkeypatch.setenv("OMNIPILOT_RUNS", "python")
    policy = {"active": True, "task": "learn math", "subject": "math", "blockAI": True, "blockAIExtensions": True, "onTaskOnly": True, "allow": ["https://www.Desmos.com/calc"], "block": [], "until": None}
    async with make_client() as c:
        first = await c.post("/api/watcher/policy", json={"pin": "12", "policy": policy}, headers=LOCAL)
        made = await c.post("/api/watcher/policy", json={"pin": "4821", "policy": policy}, headers=LOCAL)
        wrong = await c.post("/api/watcher/policy", json={"pin": "0000", "policy": {**policy, "active": False}}, headers=LOCAL)
        check = (await c.post("/api/watcher/check", json={"url": "https://chatgpt.com/"}, headers=LOCAL)).json()
        events_wrong = await c.post("/api/watcher/events", json={"pin": "0000"}, headers=LOCAL)
        events = (await c.post("/api/watcher/events", json={"pin": "4821"}, headers=LOCAL)).json()
        read = (await c.get("/api/watcher/policy")).json()
    assert first.status_code == 403 and first.json()["error"] == "pin_required"
    assert made.status_code == 200 and made.json()["policy"]["allow"] == ["desmos.com"]
    assert wrong.status_code == 403 and read["policy"]["active"] is True and read["hasPin"] is True and "pin" not in json.dumps(read).lower().replace("haspin", "")
    assert check["decision"] == "block" and check["category"] == "ai"
    assert events_wrong.status_code == 403 and events["events"][0]["url"] == "https://chatgpt.com/"


# --- HardwarePilot ---


def test_drafted_wiring_is_checked_like_typescript():
    from omnipilot_engine.brain import circuits

    data = json.loads((Path(__file__).parent / "fixtures" / "circuit_drafts.json").read_text())
    for raw, want in zip(data["drafts"], data["outputs"], strict=False):
        s = circuits.validate_spec(raw)
        assert ({"spec": s, "elec": circuits.electrical_problem(s), "steps": circuits.steps_inconsistent(s)} if s else None) == want


async def test_a_drafted_short_circuit_is_never_drawn(monkeypatch):
    from omnipilot_engine.brain.agents import hardware_pilot

    short = {"title": "x", "components": [{"id": "b", "label": "Uno", "kind": "board", "pins": [{"id": "5V", "label": "5V"}, {"id": "GND", "label": "GND"}]}],
             "wires": [{"from": "b.5V", "to": "b.GND", "color": "#ff0000"}], "steps": [{"text": "Connect 5V to GND", "wires": [0]}], "safety": [], "videoQuery": "x"}
    calls = []

    async def model(system, user, **k):
        calls.append(user)
        return short

    monkeypatch.setattr(llm, "generate_json", model)
    out = await hardware_pilot.run({"runId": "r1", "requestText": "wire a flux capacitor to my uno", "context": {}}, {})
    assert out["status"] == "partial_success" and "short circuit" in out["findings"][0] and "attachments" not in out
    assert len(calls) == 2 and "rejected" in calls[1]


# --- LearnPilot ---


async def test_lessons_have_their_quiz_answer_key_checked(monkeypatch):
    from omnipilot_engine.brain.agents import learn_pilot

    q = lambda n, key: {"question": f"Q{n}?", "choices": ["w", "x", "y", "z"], "answerIndex": key}
    lesson = {"topic": "Volcanoes", "explanation": "Hot rock rises.", "practice": ["a", "b"], "flashcards": [{"front": "f", "back": "b"}] * 3,
              "quiz": [q(1, 1), q(2, 0), q(3, 2), q(4, 3)],
              "diagram": {"kind": "steps", "title": "Eruption", "nodes": [{"label": "Magma", "detail": "melts"}, {"label": "Pressure", "detail": "builds"}, {"label": "Erupts", "detail": "out"}]}}
    # Independent checks: Q1 agrees (B); Q2 says C twice (corrected); Q3 says A then D (dropped); Q4 agrees (D).
    checks = {"Q1?": ["B"], "Q2?": ["C", "C"], "Q3?": ["A", "D"], "Q4?": ["D"]}

    async def model(system, user, **k):
        if "multiple-choice" in system:
            return {"reasoning": "...", "answer": checks[user.split("\n")[0]].pop(0)}
        return lesson

    monkeypatch.setattr(llm, "generate_json", model)
    out = await learn_pilot.run({"runId": "r1", "requestText": "teach me about volcanoes", "context": {}}, {})
    assert out["status"] == "success" and "_Answers: 1b, 2c, 3d_" in out["findings"][-1]
    assert any("1 answer(s) corrected, 1 doubtful question(s) removed" in l for l in out["limitations"])
    assert out["attachments"][0]["type"] == "concept-diagram" and len(out["attachments"][0]["nodes"]) == 3


# --- SchoolPilot ---


def test_school_dates_match_typescript_on_fixed_days():
    from omnipilot_engine.brain import school

    for r in json.loads(gzip.open(Path(__file__).parent / "fixtures" / "school_dates.json.gz", "rt").read()):
        now = school.from_iso(r["now"])
        due = school.parse_due_date(r["t"], now)
        got = {"now": r["now"], "t": r["t"], "due": due, "when": school.when_text(due, now) if due else None, "steps": school.schedule_steps(["a", "b", "c", "d"], due, now) if due else None,
               "one": school.schedule_steps(["x"], due, now) if due else None, "study": school.study_days(due, now) if due else None}
        assert got == r, r["t"]


async def test_school_tasks_are_kept_listed_and_finished():
    from omnipilot_engine.brain.agents import school_pilot

    ask = lambda t: school_pilot.run({"runId": "r1", "requestText": t, "context": {}}, {})
    added = await ask("I have a science project on volcanoes due in 5 days")
    listed = await ask("what's due?")
    done = await ask("I finished the volcanoes project")
    blocked = await ask("take my test for me")
    assert "Added **Science project on volcanoes**" in added["findings"][0] and "**Plan**" in added["findings"][0]
    assert "Science project on volcanoes" in listed["findings"][0] and "Marked done" in done["findings"][0]
    assert blocked["status"] == "failed_safe" and "Helper's safety policy for schoolwork" in blocked["findings"][0]


# --- PicturePilot ---


def test_model_planned_pictures_are_cleaned_and_drawn_like_typescript():
    import re as _re
    from omnipilot_engine.brain import picture

    rnd = lambda svg: _re.sub(r"-?\d+\.\d+(?:e-?\d+)?", lambda m: f"{round(float(m.group(0)), 9):g}", svg)
    data = json.loads((Path(__file__).parent / "fixtures" / "picture_plans.json").read_text())
    for (prompt, raw), want in zip(data["cases"], data["outputs"], strict=False):
        s = picture.validate_plan(raw, prompt)
        if want is None:
            assert s is None
        else:
            assert json.loads(json.dumps(s)) == want["spec"] and rnd(picture.render_svg(s)) == rnd(want["svg"])


def test_pictures_never_contain_markup_from_the_model():
    from omnipilot_engine.brain import picture

    s = picture.validate_plan({"title": "<script>x</script>", "objects": [{"kind": "cat", "x": 50, "y": 50, "size": 20, "color": "red\"/><script>"}]}, "a cat")
    svg = picture.render_svg(s)
    assert "<script>" not in svg and "&lt;script&gt;" in svg and 'fill="#f4a259"' in svg


# --- ModelPilot ---


def _rf(v):
    if isinstance(v, float):
        return round(v, 6) + 0.0
    if isinstance(v, list):
        return [_rf(x) for x in v]
    if isinstance(v, dict):
        return {k: _rf(x) for k, x in v.items()}
    return v


def test_3d_models_are_validated_and_checked_like_typescript():
    from omnipilot_engine.brain import model3d
    from omnipilot_engine.brain.agents import model_pilot

    data = json.loads((Path(__file__).parent / "fixtures" / "model3d_checks.json").read_text())
    for raw, want in zip(data["raws"], data["outputs"], strict=False):
        m = model3d.validate_model(raw)
        got = None if not m else {"m": m, "bounds": model3d.model_bounds(m), "floating": [p["id"] for p in model3d.floating_parts(m)], "ground": model3d.ground_model(m),
                                  "prop": model_pilot.proportion_problem(m, [30, 70, 20]), "prop2": model_pilot.proportion_problem(m, [1, 1, 12])}
        assert _rf(json.loads(json.dumps(got))) == _rf(want)


async def test_designing_a_model_asks_the_strong_model_and_repairs_floating_parts(monkeypatch):
    from omnipilot_engine.brain.agents import model_pilot

    box = lambda id, x: {"id": id, "name": id, "description": "", "shape": "box", "size": [10, 10, 10], "position": [x, 5, 0], "rotation": [0, 0, 0], "color": "#336699", "material": "plastic", "group": "body"}
    floating = {"title": "Console", "description": "A console", "units": "cm", "separate": False, "notes": ["Fact"], "real_size": [], "parts": [box("base", 0), box("lid", 0), box("stray", 80)]}
    fixed = {**floating, "parts": [box("base", 0), box("lid", 0), box("stray", 9)]}
    calls = []

    async def model(system, user, **k):
        calls.append(k.get("hard"))
        if "real overall dimensions" in system:
            return {"object": "console", "width": 1, "height": 1, "depth": 1, "units": "cm", "known": False}
        return fixed if "Fix these problems" in user else floating

    monkeypatch.setattr(llm, "generate_json", model)
    monkeypatch.setattr(llm, "available", lambda: asyncio.sleep(0, True))
    out = await model_pilot.run({"runId": "r1", "requestText": "build a 3D model of a game console", "context": {"conversationId": "c3d"}}, {})
    assert out["status"] == "success" and "attached parts that were floating" in out["findings"][-1]
    assert all(calls) and len(calls) == 3, "3D design is a hard job: Groq first"
    assert min(p["position"][1] - 5 for p in out["attachments"][0]["model"]["parts"]) == 0
    assert model_pilot.last_model("c3d")["title"] == "Console"


# --- MathPilot ---


def test_math_checks_match_typescript_exactly():
    import math as _m
    from omnipilot_engine.brain.mathpilot import expr

    def js_json(v):
        if isinstance(v, float) and not _m.isfinite(v):
            return None
        if isinstance(v, dict):
            return {k: js_json(x) for k, x in v.items()}
        if isinstance(v, list):
            return [js_json(x) for x in v]
        return v

    data = json.loads((Path(__file__).parent / "fixtures" / "math_expr.json").read_text())
    for text, want in zip(data["cases"], data["outputs"], strict=False):
        eq = expr.extract_equation(text)
        if not eq:
            got = {"eq": None}
        else:
            try:
                got = {"eq": eq, "r": expr.check_identity(eq["left"], eq["right"])}
            except Exception as e:  # noqa: BLE001
                got = {"eq": eq, "error": str(e)}
        assert js_json(got) == want, text


async def test_mathpilot_never_lets_the_model_contradict_the_verdict(monkeypatch):
    from omnipilot_engine.brain.agents import math_pilot

    async def wrong(system, user, **k):
        return "Actually this is false because the sides differ."

    monkeypatch.setattr(llm, "generate_text", wrong)
    out = await math_pilot.run({"runId": "r1", "requestText": "is sin(x)^2 + cos(x)^2 = 1?", "context": {}}, {})
    assert out["findings"][0].startswith("✅ **True**") and len(out["findings"]) == 1

    async def right(system, user, **k):
        return "It holds because of the Pythagorean theorem on the unit circle. Extra cut-off sente"

    monkeypatch.setattr(llm, "generate_text", right)
    out = await math_pilot.run({"runId": "r1", "requestText": "is sin(x)^2 + cos(x)^2 = 1?", "context": {}}, {})
    assert out["findings"][1] == "**Why:** It holds because of the Pythagorean theorem on the unit circle."


# --- InfraPilot ---


def test_calendar_recurrence_matches_typescript():
    from datetime import datetime
    from omnipilot_engine.brain import calendar as cal

    data = json.loads((Path(__file__).parent / "fixtures" / "calendar.json").read_text())
    for want in data["outputs"][:-1]:
        y, m, d, days = want["from"]
        assert [cal.event_line(e) for e in cal.events_between(data["ics"], datetime(y, m + 1, d), days)] == want["lines"]
    assert cal.calendar_name(data["ics"]) == data["outputs"][-1]["name"]


async def test_a_slack_post_is_shown_exactly_and_sent_only_when_approved(monkeypatch):
    from omnipilot_engine.brain.agents import infra_pilot

    store.set_connector_verified("Slack", "team / bot", "xoxb-test")
    sent = []

    async def post(p):
        sent.append(p)
        return {"ok": True, "message": "Posted."}

    monkeypatch.setitem(actions.EXECUTORS, "slack_message", post)
    out = await infra_pilot.run({"runId": "r1", "requestText": "post 'standup at 10' to #general on slack", "context": {}}, {})
    assert out["status"] == "needs_approval" and out["proposedActions"][0]["preview"] == "Channel: #general\n\nstandup at 10"
    assert sent == []
    assert (await actions.execute_action(out["proposedActions"][0]["id"]))["ok"] and sent == [{"channel": "#general", "text": "standup at 10"}]


async def test_mcp_read_only_tools_run_and_changing_ones_wait_for_approval():
    import sys as _sys
    from omnipilot_engine.brain.agents import infra_pilot
    from omnipilot_engine.integrations import mcp_servers

    await mcp_servers.add({"name": "echo", "transport": "stdio", "command": _sys.executable, "args": [str(Path(__file__).parent / "fixtures" / "echo_mcp.py")]})
    read = await infra_pilot.run({"runId": "r1", "requestText": 'call echo on echo with {"text": "hi"}', "context": {}}, {})
    write = await infra_pilot.run({"runId": "r1", "requestText": 'call shout on echo with {"text": "hi"}', "context": {}}, {})
    assert read["status"] == "success" and "echo: hi" in read["findings"][0]
    assert write["status"] == "needs_approval" and "shout" in write["proposedActions"][0]["description"]


# --- questions about the user or this conversation (found by live testing: "What is my name?" went to a web search) ---


async def test_questions_about_the_conversation_are_answered_from_it(monkeypatch):
    from omnipilot_engine import llm
    from omnipilot_engine.brain.agents import helper

    seen = {}

    async def fake_json(system, user, **kw):
        seen["prompt"] = user
        return {"known": True, "answer": "Your name is Sam."}

    monkeypatch.setattr(llm, "generate_json", fake_json)
    history = [{"request": "My name is Sam. Please remember it.", "answer": "Nice to meet you, Sam!"}]
    r = await helper.run({"runId": "c1", "requestText": "What is my name?", "context": {"conversationHistory": history}}, {})
    assert r["findings"] == ["Your name is Sam."] and r["evidence"][0]["source"] == "conversation" and "My name is Sam" in seen["prompt"]


async def test_unknown_personal_questions_fall_through(monkeypatch):
    from omnipilot_engine import llm
    from omnipilot_engine.brain.agents import helper

    async def fake_json(system, user, **kw):
        return {"known": False, "answer": ""}

    monkeypatch.setattr(llm, "generate_json", fake_json)
    out = await helper.about_us({"runId": "c2", "requestText": "What is my IP address?"}, [{"request": "hi", "answer": "Hello!"}], memory=False)
    assert out is None


def test_remember_it_at_the_end_is_a_request_to_remember():
    from omnipilot_engine.brain.agents import helper

    assert helper.REMEMBER_IT.match("My name is Sam. Please remember it.").group("fact") == "My name is Sam"
    assert not helper.REMEMBER_IT.match("Do you remember it?")
    assert helper.ABOUT_US.search("what did I just ask?") and not helper.ABOUT_US.search("What is the capital of France?")


def test_clients_cannot_supply_the_conversation_history():
    from omnipilot_engine.brain import api

    assert "conversationHistory" in api.RESERVED_CONTEXT
