"""The plan's Router + six specialists (docs/product D16): the seven extra abilities run as skills of a specialist,
and only the six specialist names are selected, run, shown or recorded."""
import asyncio

import pytest

from omnipilot_engine import store
from omnipilot_engine.brain import coordinator, decision
from omnipilot_engine.brain.specs import SKILL_OWNER, SPECIALISTS, owner

FOLDED = set(SKILL_OWNER)


@pytest.fixture
def py_runs(monkeypatch):
    monkeypatch.setenv("OMNIPILOT_RUNS", "python")


def test_every_extra_ability_belongs_to_one_of_the_six_specialists():
    assert SPECIALISTS == ["InfraPilot", "Helper", "CodePilot", "PromptPilot", "ScienceLab", "ScriptScholar"]
    assert all(owner(a) in SPECIALISTS for a in FOLDED) and len(FOLDED) == 7
    assert owner("Helper") == "Helper"


@pytest.mark.parametrize("text, specialist, skill", [
    ("Draw a dragon flying over a castle", "Helper", "pictures"),
    ("Is it true that (a+b)^2 = a^2 + b^2?", "ScienceLab", "math checks"),
    ("My kid should learn math for an hour with no AI", "InfraPilot", "focus control"),
    ("Teach me how fractions work", "Helper", "lessons & quizzes"),
])
async def test_the_router_plan_names_only_specialists_and_the_skill_they_use(text, specialist, skill):
    plan = await decision.plan(text)
    assert plan["selectedAgents"] == [specialist]
    assert skill in plan["skills"][specialist]
    assert not FOLDED & (set(plan["selectedAgents"]) | set(plan["scores"]) | set(plan["rationale"]))
    assert set(plan["capabilities"]) & FOLDED  # the abilities the rules chose are kept for planning


async def test_a_specialist_and_its_skill_are_planned_apart_but_shown_and_merged_as_one(monkeypatch):
    plan = await decision.plan("How do I wire a button to my Arduino and how does it work?")
    assert set(plan["selectedAgents"]) <= set(SPECIALISTS)
    steps = coordinator.plan_steps("How do I wire a button to my Arduino and how does it work?", plan["capabilities"])
    shown = coordinator.shown_steps(steps)
    assert all(s["agent"] in SPECIALISTS and set(s["dependsOn"]) <= set(SPECIALISTS) for s in shown)
    base = {"agent": "Helper", "status": "success", "findings": ["a"], "evidence": [], "confidence": 0.9, "limitations": [], "proposedActions": [],
            "completedAt": "t", "elapsedMs": 1, "retries": 0}
    merged = coordinator.fold_results({"Helper": base, "LearnPilot": {**base, "findings": ["b"], "skill": "lessons & quizzes"}})
    assert len(merged) == 1 and merged[0]["findings"] == ["a", "b"] and merged[0]["skill"] == "lessons & quizzes"


async def test_a_run_records_only_specialist_names(make_client, py_runs, monkeypatch):
    from omnipilot_engine.brain import agents, pipeline

    ran = []

    async def fake(name, input, ctx):  # stands in for the abilities (no model in tests)
        ran.append(name)
        return {"status": "success", "findings": [f"done ({name} code, fake)"], "evidence": [], "confidence": 0.9, "limitations": [], "proposedActions": []}

    monkeypatch.setattr(agents, "run", fake)
    async with make_client():
        run_id, task = pipeline.start("Draw a dragon flying over a castle")
        record = await task
    assert "PicturePilot" in ran  # the pictures code still does the work
    assert record["plan"]["selectedAgents"] == ["Helper"] and [r["agent"] for r in record["agentResults"]] == ["Helper"]
    assert record["agentResults"][0]["skill"] == "pictures" and record["steps"][0] == {**record["steps"][0], "agent": "Helper", "skill": "pictures"}
    logged = {r["agent"] for r in store.q("SELECT agent FROM audit_log WHERE run_id = ?", run_id)}
    assert not FOLDED & logged
    await asyncio.sleep(0)
