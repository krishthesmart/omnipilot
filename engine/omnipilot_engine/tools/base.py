"""What every tool call shares: a per-request budget (calls, time, estimated cost), bounded retries,
a small cache for repeatable look-ups, and a record of each service's status. Keys are only ever read
to send to their own service; nothing here stores, logs or returns them."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import os
import sqlite3
import threading
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from .. import envfiles

envfiles.load()

DATA_DIR = Path(os.environ.get("OMNIPILOT_DATA_DIR") or (envfiles.ROOT / "server" / "data"))


class ToolError(Exception):
    """A service couldn't do the job. `retry_elsewhere` means another service may still do it."""

    def __init__(self, provider: str, message: str, *, code: str = "failed", retry_elsewhere: bool = True):
        super().__init__(message)
        self.provider, self.code, self.retry_elsewhere = provider, code, retry_elsewhere


class BudgetExceeded(ToolError):
    def __init__(self, message: str):
        super().__init__("budget", message, code="budget", retry_elsewhere=False)


class RunSpend:
    """A project's per-run spending limit on paid services (slice 9), shared by every tool call in that run."""

    def __init__(self, limit_usd: float):
        self.limit_usd, self.spent_usd = limit_usd, 0.0

    def take(self, est_cost_usd: float) -> None:
        if self.spent_usd + est_cost_usd > self.limit_usd + 1e-9:
            raise BudgetExceeded(f"this project's budget per run (${self.limit_usd:.2f}) would be exceeded, so the paid service wasn't called")
        self.spent_usd += est_cost_usd


run_spend: ContextVar[RunSpend | None] = ContextVar("omnipilot_run_spend", default=None)
tool_usage_sink: ContextVar[list | None] = ContextVar("omnipilot_tool_usage", default=None)  # per-run paid-tool log (slice 9)


@dataclass
class Budget:
    """Shared by every tool call in one request, so one request can't run up costs or time."""

    max_calls: int = 6
    max_cost_usd: float = 0.05
    deadline_s: float = 120.0
    calls: int = 0
    cost_usd: float = 0.0
    started: float = field(default_factory=time.monotonic)
    log: list[dict] = field(default_factory=list)

    def remaining_s(self) -> float:
        return self.deadline_s - (time.monotonic() - self.started)

    def take(self, provider: str, est_cost_usd: float) -> float:
        """Reserves one call; returns the time it may take. Raises BudgetExceeded instead of going over."""
        if self.calls >= self.max_calls:
            raise BudgetExceeded(f"tool call limit reached ({self.max_calls})")
        if self.cost_usd + est_cost_usd > self.max_cost_usd + 1e-9:
            raise BudgetExceeded(f"cost limit reached (about ${self.max_cost_usd:.2f} per request)")
        left = self.remaining_s()
        if left < 2:
            raise BudgetExceeded("time limit reached")
        self.calls += 1
        self.cost_usd += est_cost_usd
        return left

    def note(self, provider: str, kind: str, outcome: str, ms: int, cost: float) -> None:
        entry = {"provider": provider, "kind": kind, "outcome": outcome, "ms": ms, "est_cost_usd": round(cost, 4)}
        self.log.append(entry)
        if (sink := tool_usage_sink.get()) is not None:
            sink.append(entry)


RETRY_STATUSES = {429, 500, 502, 503, 504}


async def http(
    provider: str,
    method: str,
    url: str,
    *,
    timeout: float,
    retries: int = 2,
    client: httpx.AsyncClient | None = None,
    **kwargs,
) -> httpx.Response:
    """One HTTP call with bounded retries on rate limits and server errors (never on other 4xx).
    Errors carry the service's own short message, never the request's headers."""
    owned = client is None
    client = client or httpx.AsyncClient(timeout=timeout, follow_redirects=True)
    try:
        for attempt in range(retries + 1):
            try:
                res = await client.request(method, url, timeout=timeout, **kwargs)
            except (httpx.TimeoutException, httpx.TransportError) as err:
                if attempt == retries:
                    raise ToolError(provider, f"couldn't reach {provider} ({type(err).__name__})", code="unreachable") from None
                await asyncio.sleep(0.5 * 2**attempt)
                continue
            if res.status_code in RETRY_STATUSES and attempt < retries:
                wait = min(10.0, float(res.headers.get("retry-after", 0) or 0) or 0.5 * 2**attempt)
                await asyncio.sleep(wait)
                continue
            if res.status_code in (401, 403):
                raise ToolError(provider, f"{provider} rejected the API key (HTTP {res.status_code}): {short(res)}", code="auth")
            if res.status_code == 402:
                raise ToolError(provider, f"{provider} says the account is out of credits (HTTP 402)", code="credits")
            if res.status_code == 429:
                raise ToolError(provider, f"{provider} is rate-limiting (HTTP 429)", code="rate_limited")
            if res.status_code >= 400:
                raise ToolError(provider, f"{provider} answered HTTP {res.status_code}: {short(res)}", code="http_error")
            return res
        raise ToolError(provider, f"{provider} kept failing", code="failed")
    finally:
        if owned:
            await client.aclose()


def short(res: httpx.Response) -> str:
    try:
        body = res.json()
        msg = body.get("error") or body.get("message") or body.get("detail") or body
        if isinstance(msg, dict):
            msg = msg.get("message") or json.dumps(msg)
        return scrub(str(msg))[:160]
    except Exception:
        return scrub(res.text)[:160]


def scrub(text: str) -> str:
    """Removes any configured key from a service's reply (in case one echoes it back) before it's shown or logged."""
    for name, value in os.environ.items():
        if len(value) >= 12 and re.search(r"KEY|TOKEN|SECRET|PASSWORD", name) and value in text:
            text = text.replace(value, "[redacted]")
    return text


# --- cache and status (a small SQLite file next to OmniPilot's database) ---

_db_lock = threading.RLock()  # re-entrant: record_status and cache_put hold it while db() opens the file
_db: sqlite3.Connection | None = None


def db() -> sqlite3.Connection:
    global _db
    with _db_lock:
        if _db is None:
            path = os.environ.get("OMNIPILOT_TOOLS_DB") or str(DATA_DIR / "tools.sqlite")
            if path != ":memory:":
                Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            _db = sqlite3.connect(path, check_same_thread=False)
            from ..store import private_files

            private_files(path)
            _db.execute("PRAGMA journal_mode=WAL")
            _db.execute("CREATE TABLE IF NOT EXISTS tool_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at REAL NOT NULL)")
            _db.execute(
                "CREATE TABLE IF NOT EXISTS service_status (name TEXT PRIMARY KEY, state TEXT NOT NULL, detail TEXT NOT NULL, checked_at REAL NOT NULL, ms INTEGER)"
            )
            _db.commit()
        return _db


def reset_db_for_tests() -> None:
    global _db
    with _db_lock:
        if _db is not None:
            _db.close()
        _db = None


def cache_key(*parts) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()


def cache_get(key: str, ttl_s: float):
    if os.environ.get("OMNIPILOT_TOOLS_CACHE") == "off":
        return None
    row = db().execute("SELECT value, at FROM tool_cache WHERE key = ?", (key,)).fetchone()
    return json.loads(row[0]) if row and time.time() - row[1] < ttl_s else None


def cache_put(key: str, value) -> None:
    if os.environ.get("OMNIPILOT_TOOLS_CACHE") == "off":
        return
    with _db_lock:
        db().execute("INSERT OR REPLACE INTO tool_cache (key, value, at) VALUES (?, ?, ?)", (key, json.dumps(value), time.time()))
        db().execute("DELETE FROM tool_cache WHERE at < ?", (time.time() - 7 * 86400,))
        db().commit()


def record_status(name: str, state: str, detail: str, ms: int | None = None) -> None:
    """state: verified | failed. (configured/implemented are worked out live from the environment and code.)"""
    with _db_lock:
        db().execute("INSERT OR REPLACE INTO service_status (name, state, detail, checked_at, ms) VALUES (?, ?, ?, ?, ?)", (name, state, detail[:300], time.time(), ms))
        db().commit()


def last_status(name: str) -> dict | None:
    row = db().execute("SELECT state, detail, checked_at, ms FROM service_status WHERE name = ?", (name,)).fetchone()
    return {"state": row[0], "detail": row[1], "checked_at": row[2], "ms": row[3]} if row else None
