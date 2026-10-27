"""Routing sanity: a 3D game is a software build (CodePilot), a single 3D model is the model skill (ScienceLab),
and common requests reach the right specialist. Keyword routing only (no model in tests)."""
import pytest

from omnipilot_engine.brain import routing


async def route(q):
    return (await routing.route_request(q))["selectedAgents"]


@pytest.mark.parametrize("q", [
    "create a 3d horror game like doors",
    "make a 3d game in three.js",
    "make a snake game",
    "make a 2d platformer with levels",
    "make a first person shooter",
    "build an rpg",
])
async def test_games_build_with_codepilot_not_the_model_skill(q):
    sel = await route(q)
    assert "CodePilot" in sel and "ModelPilot" not in sel


@pytest.mark.parametrize("q", [
    "make a 3d model of a car",
    "a 3d water molecule",
    "build a 3d model of a game console i can explore",
    "build a 3d model of a dna strand",
])
async def test_single_3d_models_use_the_model_skill_not_codepilot(q):
    sel = await route(q)
    assert "ModelPilot" in sel and "CodePilot" not in sel


@pytest.mark.parametrize("q, expected", [
    ("write a python function to reverse a string", "CodePilot"),
    ("scan my code for security bugs", "CodePilot"),
    ("summarize my unread emails", "InfraPilot"),
    ("simulate a pendulum 2m long on mars", "ScienceLab"),
    ("compare linear a and linear b scripts", "ScriptScholar"),
    ("how do i wire an led to my arduino", "HardwarePilot"),
    ("rewrite this prompt to be better for chatgpt", "PromptPilot"),
    ("what is the capital of france", "Helper"),
])
async def test_common_requests_reach_the_right_specialist(q, expected):
    assert expected in await route(q)
