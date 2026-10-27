"""The specialists. Every agent now runs here, in Python. The bridge (bridge.py) to the TypeScript engine
remains only as a fallback for a name Python doesn't know.

An agent is `async def agent(input, ctx) -> dict` returning its raw result: status, findings, evidence,
confidence, limitations, proposedActions (and optionally attachments, role)."""
from __future__ import annotations

from . import bridge, code_pilot, hardware_pilot, helper, infra_pilot, learn_pilot, math_pilot, model_pilot, picture_pilot, prompt_pilot, school_pilot, science_lab, script_scholar, watcher_pilot

PYTHON_AGENTS = {"CodePilot": code_pilot.run, "InfraPilot": infra_pilot.run, "MathPilot": math_pilot.run, "ModelPilot": model_pilot.run, "PicturePilot": picture_pilot.run, "SchoolPilot": school_pilot.run, "LearnPilot": learn_pilot.run, "HardwarePilot": hardware_pilot.run, "WatcherPilot": watcher_pilot.run, "PromptPilot": prompt_pilot.run, "Helper": helper.run, "ScienceLab": science_lab.run, "ScriptScholar": script_scholar.run}


async def run(name: str, input: dict, ctx: dict) -> dict:
    fn = PYTHON_AGENTS.get(name)
    return await fn(input, ctx) if fn else await bridge.run(name, input, ctx)


def where(name: str) -> str:
    return "python" if name in PYTHON_AGENTS else "typescript"
