"""One Stop switch per run, so the Stop button ends a run wherever it is: running agents, the streamed
answer, or between pipeline stages."""
from __future__ import annotations

import asyncio

_runs: dict[str, asyncio.Event] = {}


class RunCancelled(Exception):
    pass


def begin(run_id: str) -> asyncio.Event:
    ev = asyncio.Event()
    _runs[run_id] = ev
    return ev


def end(run_id: str) -> None:
    _runs.pop(run_id, None)


def cancel(run_id: str) -> bool:
    ev = _runs.get(run_id)
    if not ev:
        return False
    ev.set()
    return True


def is_cancelled(run_id: str) -> bool:
    ev = _runs.get(run_id)
    return bool(ev and ev.is_set())


def signal(run_id: str) -> asyncio.Event | None:
    return _runs.get(run_id)


def throw_if_cancelled(run_id: str) -> None:
    if is_cancelled(run_id):
        raise RunCancelled()
