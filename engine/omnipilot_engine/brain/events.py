"""Each run's live events, for the chat's stream: a late subscriber first gets everything so far, then
live events. A finished run's events are dropped after a while (10 minutes, or once there are more than
200 finished runs); after that the stream is rebuilt from the saved run. Runs still going are never
dropped. Activity-log entries for live runs are published here too. (Same as server/src/lib/eventBus.ts.)"""
from __future__ import annotations

import asyncio
import os
import time
from collections import OrderedDict

from .. import store

TERMINAL = {"final_response", "clarification_needed", "run_failed", "run_cancelled"}


class EventBus:
    def __init__(self):
        self.history: dict[str, list[dict]] = {}
        self.subscribers: dict[str, set[asyncio.Queue]] = {}
        self.finished: "OrderedDict[str, float]" = OrderedDict()
        self.retain_s = float(os.environ.get("OMNIPILOT_EVENT_RETAIN_MS", 600_000)) / 1000
        self.max_finished = int(os.environ.get("OMNIPILOT_EVENT_MAX_RUNS", 200))

    def publish(self, event: dict) -> None:
        run_id = event["runId"]
        if event["type"] == "run_started":
            self.history[run_id] = []
            self.finished.pop(run_id, None)
        self.history.setdefault(run_id, []).append(event)
        for q in list(self.subscribers.get(run_id, ())):
            q.put_nowait(event)
        if event["type"] in TERMINAL:
            self.finished.pop(run_id, None)
            self.finished[run_id] = time.monotonic()
        self._evict()

    def live(self, run_id: str) -> bool:
        """A run this process is streaming right now (started here and not finished)."""
        return run_id in self.history and run_id not in self.finished

    def get_history(self, run_id: str) -> list[dict]:
        return list(self.history.get(run_id, []))

    def subscribe(self, run_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self.subscribers.setdefault(run_id, set()).add(q)
        return q

    def unsubscribe(self, run_id: str, q: asyncio.Queue) -> None:
        subs = self.subscribers.get(run_id)
        if subs:
            subs.discard(q)
            if not subs:
                self.subscribers.pop(run_id, None)

    def _evict(self) -> None:
        now = time.monotonic()
        for run_id, at in list(self.finished.items()):
            if now - at > self.retain_s or len(self.finished) > self.max_finished:
                self.finished.pop(run_id, None)
                self.history.pop(run_id, None)


bus = EventBus()


def _audit_to_stream(entry: dict) -> None:
    if bus.live(entry["runId"]):
        bus.publish({"type": "audit", "runId": entry["runId"], "entry": entry})


store.AUDIT_HOOKS.append(_audit_to_stream)
