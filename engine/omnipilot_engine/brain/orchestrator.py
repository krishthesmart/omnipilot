"""Runs one agent in isolation: its own time budget, a retry on timeout/unreachable where allowed, the
Stop button, and a terminal result whatever happens (one agent's failure never takes down the others).
Actions awaiting approval are recorded before the app hears about them. (Same as server/src/orchestrator.ts.)"""
from __future__ import annotations

import asyncio
import time

from .. import store
from . import agents, control
from .agents.bridge import BridgeError
from .events import bus
from .agents.research import research_minutes  # noqa: F401  (also used by Helper)
from .specs import EDIT_PROJECT, SPECS, is_project_request, owner, rx, skill_of  # noqa: F401

def budget_scale() -> float:
    """The time budgets were tuned for Groq's fast models; the medium model on this computer, which answers
    first, needs longer for agents that chain several model calls."""
    import os

    try:
        return max(1.0, float(os.environ.get("OMNIPILOT_BUDGET_SCALE", "2")))
    except ValueError:
        return 2.0


def budget_for(agent: str, text: str) -> tuple[float, int]:
    spec = SPECS[agent]
    timeout = spec.timeout_s * budget_scale()
    minutes = research_minutes(text) if agent == "Helper" else None
    if minutes:
        timeout = max(timeout, minutes * 60 + 75)
    elif agent == "CodePilot" and (is_project_request(text) or EDIT_PROJECT.search(text)):
        timeout = max(timeout, 360)
    return timeout, spec.max_retries


def _iso() -> str:
    return store.now()


async def _attempt(agent: str, input: dict, timeout_s: float) -> dict:
    started_at, t0 = _iso(), time.monotonic()
    stop = control.signal(input["runId"])
    shown = owner(agent)  # a skill runs as its specialist (specs.SKILL_OWNER)
    base = {"agent": shown, "startedAt": started_at, **({"skill": skill_of(agent)} if skill_of(agent) else {})}
    try:
        from .. import projects

        scope = projects.current.get()
        # Inside a project, an agent's workspace is that project's own folder and nothing else.
        ctx = {"timeout_s": timeout_s, "stop": stop, **({"workspace_root": scope["root"], "project_id": scope["id"]} if scope else {})}
        raw = await asyncio.wait_for(agents.run(agent, input, ctx), timeout_s + 25)
        return {**base, **raw, "completedAt": _iso(), "elapsedMs": int((time.monotonic() - t0) * 1000)}
    except (asyncio.TimeoutError, BridgeError, Exception) as err:  # noqa: BLE001 -- isolated: always a terminal result
        elapsed = int((time.monotonic() - t0) * 1000)
        if stop and stop.is_set():
            return {**base, "status": "timeout", "stopped": True, "findings": [f"{shown} was stopped."], "evidence": [], "confidence": 0, "limitations": [], "proposedActions": [], "completedAt": _iso(), "elapsedMs": elapsed}
        status = "timeout" if isinstance(err, asyncio.TimeoutError) or getattr(err, "kind", "") == "timeout" else "unreachable"
        store.audit(input["runId"], shown, "agent_execution", {}, f"error: {status} ({str(err)[:200] or type(err).__name__})")
        return {**base, "status": status,
                "findings": [f"{shown} did not complete within its time budget." if status == "timeout" else f"{shown} raised an unexpected error and could not complete."],
                "evidence": [], "confidence": 0, "limitations": ["This agent's result is unavailable; other agents' results are unaffected."], "proposedActions": [],
                "completedAt": _iso(), "elapsedMs": elapsed}


async def run_agent_isolated(agent: str, input: dict, annotations: dict | None = None) -> dict:
    """Runs one ability. `agent` may be a skill (e.g. LearnPilot); it runs, is shown and is recorded as the
    specialist that owns it (Helper), with the skill named alongside."""
    run_id = input["runId"]
    timeout_s, max_retries = budget_for(agent, input["requestText"])
    skill, ability = skill_of(agent), agent
    agent = owner(agent)
    bus.publish({"type": "agent_start", "runId": run_id, "agent": agent, **({"skill": skill} if skill else {})})
    store.audit(run_id, agent, "agent_start", {"engine": agents.where(ability), **({"skill": skill} if skill else {})}, "started")
    attempt = await _attempt(ability, input, timeout_s)
    retries = 0
    while attempt["status"] in ("timeout", "unreachable") and retries < max_retries and not control.is_cancelled(run_id):
        retries += 1
        bus.publish({"type": "agent_retry", "runId": run_id, "agent": agent, "attempt": retries})
        store.audit(run_id, agent, "agent_retry", {"attempt": retries}, "retrying")
        attempt = await _attempt(ability, input, timeout_s)
    result = {**attempt, "retries": retries, **{k: v for k, v in (annotations or {}).items() if v is not None}}
    store.audit(run_id, agent, "agent_complete", {"status": result["status"], "confidence": result["confidence"]}, result["status"])
    for a in result.get("proposedActions") or []:
        if a.get("requiresApproval"):
            store.create_approval(a["id"], run_id, agent, a["description"], a["riskLevel"])
    bus.publish({"type": "agent_complete", "runId": run_id, "result": result})
    return result
