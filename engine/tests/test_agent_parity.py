"""Ported agents give exactly the answers recorded in tests/fixtures/agents/<agent>.json.gz (with the AI model
off). Each fixture started as the TypeScript agent's own answers, so a port is proven identical; deliberate
improvements since then are listed in the fixture's "improvements" field."""
import gzip
import importlib
import json
import re
from pathlib import Path

import pytest

FIXTURES = sorted((Path(__file__).parent / "fixtures" / "agents").glob("*.json.gz"))



import base64 as _b64, re as _re

def _round_floats(v):
    if isinstance(v, float):
        return round(v, 6) + 0.0
    if isinstance(v, list):
        return [_round_floats(x) for x in v]
    if isinstance(v, dict):
        return {k: _round_floats(x) for k, x in v.items()}
    return v


def _svg_norm(r):
    """Pictures: decode the SVG and round its numbers (V8 and the system maths library differ in the last bit of sin/cos)."""
    out = []
    for a in r.get("attachments") or []:
        if isinstance(a, dict) and str(a.get("src", "")).startswith("data:image/svg+xml;base64,"):
            svg = _b64.b64decode(a["src"].split(",", 1)[1]).decode()
            a = {**a, "src": _re.sub(r"-?\d+\.\d+(?:e-?\d+)?", lambda m: f"{round(float(m.group(0)), 9):g}", svg)}
        if isinstance(a, dict) and a.get("type") == "model-3d":
            a = _round_floats(a)  # 3D geometry: V8 and the system maths library differ in the last bit
        out.append(a)
    return {**r, "attachments": out} if r.get("attachments") else r


# A deliberate change since the fixtures were recorded (docs/product D16): the seven extra agents became skills
# of the plan's six specialists, so the text people see names the specialist. Only these exact phrases differ.
RENAMED = [
    ("HardwarePilot can't draw", "CodePilot can't draw"),
    ("MathPilot does two things:", "ScienceLab's math checks do two things:"),
    ("Request blocked by LearnPilot's safety policy", "Request blocked by Helper's safety policy for lessons"),
    ("Request blocked by SchoolPilot's safety policy", "Request blocked by Helper's safety policy for schoolwork"),
    ("The request asks LearnPilot to complete", "The request asks Helper to complete"),
    ("The request asks SchoolPilot to complete", "The request asks Helper to complete"),
    ("LearnPilot only supports safe", "Helper's lessons only support safe"),
    ("SchoolPilot helps students learn and plan", "Helper helps students learn and plan"),
]
RENAMED_IN = {"prompt_pilot": [("LearnPilot", "Helper (lessons)")]}  # its per-specialist prompt labels


def _renamed(want: dict, agent: str = "") -> dict:
    text = json.dumps(want, ensure_ascii=False)
    for old, new in [*RENAMED, *RENAMED_IN.get(agent, [])]:
        text = text.replace(old, new)
    return json.loads(text)


def _norm(r: dict) -> dict:
    r = _svg_norm(r)
    text = json.dumps(r, ensure_ascii=False)
    # Collapse machine-specific home directories (split_command expands "~/Documents" to "$HOME/..."
    # for real server launches) back to "~", so a fixture recorded on one machine matches any other.
    text = re.sub(r"/(?:Users|home)/[^/\"]+|/root(?=/)", "~", text)
    r = json.loads(re.sub(r"in \d+(\.\d+)? ms", "in X ms", re.sub(r"Web search is off \([^)]*\)", "Web search is off", text)))
    return {**r, "proposedActions": [{k: v for k, v in a.items() if k != "id"} for a in r.get("proposedActions", [])]}


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda p: p.name.split(".")[0])
async def test_matches_typescript(fixture):
    mod = importlib.import_module(f"omnipilot_engine.brain.agents.{fixture.name.split('.')[0]}")
    data = json.loads(gzip.open(fixture, "rt", encoding="utf-8").read())
    if data.get("workspace"):  # files the agent searched when the answers were recorded
        import os

        root = Path(os.environ["OMNIPILOT_WORKSPACE"])
        for rel, text in data["workspace"].items():
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_text(text)
    bad = []
    for i, (inp, want) in enumerate(zip(data["inputs"], data["outputs"], strict=False)):
        input = {"runId": f"p{i}", "requestText": inp, "context": {}} if isinstance(inp, str) else {"runId": f"p{i}", **inp}
        got = await mod.run(input, {"timeout_s": 30, "stop": None})
        if _norm(got) != _norm(_renamed(want, fixture.name.split(".")[0])):
            bad.append(input["requestText"][:80])
    assert not bad, f"{len(bad)} of {len(data['inputs'])} differ, e.g. {bad[:3]}"
