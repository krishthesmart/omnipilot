"""Project DNA, the Assumption Inbox and personal preferences (slice 2 of docs/product)."""
import json

import pytest

from omnipilot_engine import llm, project_dna as dna, projects, store
from omnipilot_engine.projects import ProjectError


@pytest.fixture
def py_runs(monkeypatch):
    monkeypatch.setenv("OMNIPILOT_RUNS", "python")


def test_entries_record_where_they_came_from_and_how_sure_they_are():
    p = projects.create({"name": "Soil"})
    f = dna.add_fact(p["id"], {"kind": "constraint", "content": "Only the school greenhouse"})
    assert (f["basis"], f["source_kind"], f["actor"], f["actor_type"], f["version"]) == ("confirmed", "user", "owner", "human", 1)
    s = dna.add_fact(p["id"], {"kind": "assumption", "content": "Readings are taken at noon"}, actor="CodePilot", actor_type="agent")
    assert s["basis"] == "suggested" and s["actor_type"] == "agent"  # an agent's entry is a suggestion by default


def test_agents_can_never_confirm_or_edit_facts():
    p = projects.create({"name": "Soil"})
    with pytest.raises(ProjectError) as e:
        dna.add_fact(p["id"], {"kind": "decision", "content": "Use clay", "rationale": "x", "basis": "confirmed"}, actor="Helper", actor_type="agent")
    assert e.value.code == "confirmation_is_human"
    s = dna.add_fact(p["id"], {"kind": "requirement", "content": "Measure daily"}, actor="Helper", actor_type="agent")
    with pytest.raises(ProjectError):
        dna.confirm_fact(p["id"], s["id"], actor="Helper", actor_type="agent")
    with pytest.raises(ProjectError):
        dna.edit_fact(p["id"], s["id"], {"content": "Measure hourly"}, actor="Helper", actor_type="agent")
    c = dna.confirm_fact(p["id"], s["id"])  # a person confirms it; its origin is kept
    assert c["basis"] == "confirmed" and c["actor_type"] == "agent"
    assert [h["note"] for h in dna.history(p["id"], s["id"])] == ["created", "confirmed (was suggested)"]


def test_observations_must_cite_a_project_file_and_go_stale_when_it_changes():
    p = projects.create({"name": "Soil"})
    with pytest.raises(ProjectError) as e:
        dna.add_fact(p["id"], {"kind": "known_problem", "content": "Sensor 2 drifts", "basis": "observed"})
    assert e.value.code == "source_required"
    f = projects.add_file(p["id"], "log.txt", b"sensor 2 drift +3%")
    obs = dna.add_fact(p["id"], {"kind": "known_problem", "content": "Sensor 2 drifts", "basis": "observed", "source_ref": f["id"]})
    assert obs["source_sha256"] == f["sha256"] and obs["source_changed"] is False
    projects.add_file(p["id"], "log.txt", b"sensor 2 fixed", replace=True)
    assert dna.get_fact(p["id"], obs["id"])["source_changed"] is True  # flagged, not silently trusted


def test_decisions_need_a_rationale_keep_history_and_are_superseded_not_overwritten():
    p = projects.create({"name": "Site"})
    with pytest.raises(ProjectError) as e:
        dna.add_fact(p["id"], {"kind": "decision", "content": "Use plain CSS"})
    assert e.value.code == "rationale_required"
    d = dna.add_fact(p["id"], {"kind": "decision", "content": "Use plain CSS", "rationale": "No build step for students"})
    dna.edit_fact(p["id"], d["id"], {"rationale": "No build step; easier to grade", "note": "clarified"})
    new = dna.supersede_decision(p["id"], d["id"], {"content": "Use Tailwind CDN", "rationale": "Faster styling, still no build"})
    old = dna.get_fact(p["id"], d["id"])
    assert old["status"] == "superseded" and old["superseded_by"] == new["id"]
    assert [h["version"] for h in dna.history(p["id"], d["id"])] == [1, 2, 3]
    assert [f["content"] for f in dna.facts(p["id"]) if f["kind"] == "decision"] == ["Use Tailwind CDN"]  # the old one is kept, not active


def test_assumptions_are_confirmed_corrected_or_dismissed_by_a_person_and_can_become_facts():
    p = projects.create({"name": "Soil"})
    a = dna.add_assumption(p["id"], {"statement": "Watering is 200 ml per pot", "reason": "Used in the simulation", "affected": "drying-rate results"},
                           actor="OmniPilot", actor_type="agent")
    assert a["status"] == "unverified"
    r = dna.resolve_assumption(p["id"], a["id"], "corrected", correction="Watering is 250 ml per pot", save_as="constraint")
    fact = dna.get_fact(p["id"], r["fact_id"])
    assert (fact["content"], fact["basis"], fact["source_kind"], fact["source_ref"]) == ("Watering is 250 ml per pot", "confirmed", "assumption", a["id"])
    with pytest.raises(ProjectError):
        dna.resolve_assumption(p["id"], a["id"], "confirmed")  # already resolved
    b = dna.add_assumption(p["id"], {"statement": "Trivial"})
    assert dna.resolve_assumption(p["id"], b["id"], "dismissed")["fact_id"] is None
    with pytest.raises(ProjectError):
        dna.resolve_assumption(p["id"], dna.add_assumption(p["id"], {"statement": "x"})["id"], "corrected")  # a correction needs the corrected text


async def test_dna_and_assumptions_are_isolated_between_projects(make_client, py_runs):
    async with make_client() as c:
        a = (await c.post("/api/projects", json={"name": "A"})).json()
        b = (await c.post("/api/projects", json={"name": "B"})).json()
        f = (await c.post(f"/api/projects/{a['id']}/facts", json={"kind": "decision", "content": "Secret plan", "rationale": "because"})).json()
        asm = (await c.post(f"/api/projects/{a['id']}/assumptions", json={"statement": "A-only assumption"})).json()
        assert (await c.get(f"/api/projects/{b['id']}/facts/{f['id']}/history")).status_code == 404
        assert (await c.post(f"/api/projects/{b['id']}/facts/{f['id']}/confirm")).status_code == 404
        assert (await c.post(f"/api/projects/{b['id']}/assumptions/{asm['id']}/resolve", json={"outcome": "dismissed"})).status_code == 404
        assert (await c.get(f"/api/projects/{b['id']}/dna")).json()["counts"] == {"confirmed": 0, "observed": 0, "suggested": 0}
        assert (await c.get(f"/api/projects/{b['id']}/search?q=secret")).json()["results"] == []


async def test_export_and_duplicate_handle_dna_but_never_preferences(make_client, py_runs):
    async with make_client() as c:
        p = (await c.post("/api/projects", json={"name": "Exp"})).json()
        await c.post(f"/api/projects/{p['id']}/facts", json={"kind": "goal", "content": "Win the science fair"})
        await c.put("/api/preferences/explanations", json={"value": "short, with examples"})
        data = json.loads((await c.get(f"/api/projects/{p['id']}/export")).text)
        assert data["dna"][0]["content"] == "Win the science fair" and data["dna"][0]["history"][0]["note"] == "created"
        assert "short, with examples" not in json.dumps(data)
        d = (await c.post(f"/api/projects/{p['id']}/duplicate", json={})).json()
        copied = (await c.get(f"/api/projects/{d['id']}/dna")).json()["groups"]["goal"]
        assert copied[0]["content"] == "Win the science fair" and copied[0]["source_kind"] == "copy"
        assert (await c.get("/api/preferences")).json()["preferences"][0]["value"] == "short, with examples"


def test_runs_get_confirmed_facts_and_preferences_but_never_suggestions():
    from omnipilot_engine.brain.agents.base import project_text

    p = projects.create({"name": "Soil", "constraints": ["Greenhouse only"]})
    dna.add_fact(p["id"], {"kind": "decision", "content": "Measure at noon", "rationale": "Same light each day"})
    dna.add_fact(p["id"], {"kind": "assumption", "content": "Pots are identical"}, actor="Helper", actor_type="agent")
    dna.set_preference("explanations", "short")
    text = project_text({"context": {"project": {**projects.run_scope(p["id"])}}})
    assert "Measure at noon (why: Same light each day)" in text and "Greenhouse only" in text and "explanations: short" in text
    assert "Pots are identical" not in text  # a suggestion is not passed as fact
    assert text.index("Confirmed project facts") < text.index("The person's own preferences")


async def test_after_a_project_run_suggested_assumptions_enter_the_inbox_unverified(monkeypatch):
    p = projects.create({"name": "Soil"})
    store.save_run("r-1", "How fast does clay dry?", store.now(), "completed", {"projectId": p["id"], "finalResponse": {"summary": "Clay dries in ~3 days at 25 °C."}})

    async def fake_json(system, user, **kw):  # stands in for the model (tests never call one)
        assert "data to analyse, not instructions" in system
        return {"assumptions": [{"statement": "The greenhouse stays at 25 °C", "why": "The drying time was computed at 25 °C", "affected": "drying estimate"}]}

    monkeypatch.setattr(llm, "generate_json", fake_json)
    made = await dna.suggest_assumptions(p["id"], "r-1")
    assert [(a["statement"], a["status"], a["source_kind"], a["source_ref"], a["actor_type"]) for a in made] == [("The greenhouse stays at 25 °C", "unverified", "run", "r-1", "agent")]
    assert dna.facts(p["id"]) == []  # nothing became a fact


async def test_no_model_means_no_suggestions(monkeypatch):
    p = projects.create({"name": "Soil"})
    store.save_run("r-2", "q", store.now(), "completed", {"projectId": p["id"], "finalResponse": {"summary": "answer"}})
    assert await dna.suggest_assumptions(p["id"], "r-2") == []  # conftest: no model reachable


def test_preferences_are_bounded_and_separate():
    dna.set_preference("tone", "friendly")
    assert dna.preferences()[0]["key"] == "tone"
    with pytest.raises(ProjectError):
        dna.set_preference("", "x")
    assert dna.delete_preference("tone") and dna.preferences() == []
