"""Runs an agent that hasn't been ported yet in the TypeScript engine (POST /api/internal/agent/<name>,
internal secret). Pressing Stop or running out of time closes the request, which stops the agent there."""
from __future__ import annotations

import asyncio
import os

import httpx


class BridgeError(Exception):
    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind  # "timeout" | "unreachable"


def _node() -> tuple[str, str]:
    return os.environ.get("OMNIPILOT_NODE_URL", "http://127.0.0.1:8898"), os.environ.get("OMNIPILOT_INTERNAL_TOKEN", "")


async def run(name: str, input: dict, ctx: dict) -> dict:
    url, token = _node()
    timeout_s = ctx["timeout_s"]
    stop: asyncio.Event | None = ctx.get("stop")

    async def call():
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=timeout_s + 15)) as c:
            r = await c.post(f"{url}/api/internal/agent/{name}", json={"input": input, "timeoutMs": int(timeout_s * 1000)},
                             headers={"x-omnipilot-internal": token, "x-omnipilot-client-local": "1"})
            if r.status_code >= 400:
                raise BridgeError("unreachable", f"the TypeScript engine answered HTTP {r.status_code}")
            return r.json()

    task = asyncio.ensure_future(call())
    waiters = [task] + ([asyncio.ensure_future(stop.wait())] if stop else [])
    try:
        done, _ = await asyncio.wait(waiters, timeout=timeout_s + 20, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for w in waiters[1:]:
            w.cancel()
    if task not in done:
        task.cancel()  # closes the connection: the agent stops in the TypeScript engine
        raise BridgeError("timeout", "stopped" if stop and stop.is_set() else "timeout")
    try:
        body = task.result()
    except httpx.HTTPError as err:
        raise BridgeError("unreachable", f"couldn't reach the TypeScript engine ({type(err).__name__})")
    if "result" in body:
        return body["result"]
    raise BridgeError("timeout" if body.get("error") == "timeout" else "unreachable", body.get("message") or body.get("error") or "failed")
