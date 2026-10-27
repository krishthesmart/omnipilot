"""Optional remote execution in an E2B cloud sandbox (https://e2b.dev).

Only one operation exists: a fixed smoke test that prints a message inside a
fresh sandbox and returns the output. Nothing here runs on the user's computer,
nothing from the project is uploaded, and no command is ever built from user or
model input. It is not offered to agents as a tool.

Safety limits:
- E2B_API_KEY stays in the backend's environment (server/.env); it's never sent
  to the browser, logged, or returned.
- A new sandbox per test (never a long-lived or manually created one), with no
  environment variables, no files and no internet access, a 60-second lifetime
  that E2B enforces even if cleanup fails, and a 10-second command timeout.
- Output is cut to a fixed size; the sandbox is killed in `finally`.
- Start, success/failure and cleanup are written to OmniPilot's activity log.
"""
from __future__ import annotations

import asyncio
import os
import time
from typing import Any, Awaitable, Callable

# The only command this module ever runs. Fixed: never built from input.
SMOKE_COMMAND = "echo 'OmniPilot E2B smoke test: hello from the sandbox'"
COMMAND_TIMEOUT_S = 10
SANDBOX_LIFETIME_S = 60
API_TIMEOUT_S = 20
MAX_OUTPUT_CHARS = 4000

AuditFn = Callable[[str, str, dict[str, Any]], Awaitable[None]]
SandboxFactory = Callable[..., Awaitable[Any]]

# One smoke test at a time: each one starts a (billed) cloud sandbox.
_one_at_a_time = asyncio.Lock()


def api_key() -> str | None:
    key = (os.environ.get("E2B_API_KEY") or "").strip()
    return key or None


def configured() -> bool:
    return api_key() is not None


def bounded(text: str | None) -> str:
    text = text or ""
    return text if len(text) <= MAX_OUTPUT_CHARS else text[:MAX_OUTPUT_CHARS] + f"\n[output cut at {MAX_OUTPUT_CHARS} characters]"


def _default_factory() -> SandboxFactory:
    from e2b import AsyncSandbox  # imported lazily: E2B is optional

    return AsyncSandbox.create


def _failure(kind: str) -> str:
    """A plain description of what went wrong, never the raw exception text (which could echo request details)."""
    return {
        "timeout": "The sandbox didn't respond in time.",
        "auth": "E2B rejected the API key. Check E2B_API_KEY in server/.env.",
        "rate_limit": "E2B is rate-limiting this account. Try again shortly.",
        "exit": "The smoke-test command failed inside the sandbox.",
    }.get(kind, "The sandbox couldn't run the smoke test.")


async def run_smoke_test(audit: AuditFn, factory: SandboxFactory | None = None) -> dict[str, Any]:
    key = api_key()
    if not key:
        await audit("e2b_smoke_test", "skipped: E2B_API_KEY isn't set", {})
        return {"ok": False, "error": "not_configured", "message": "Set E2B_API_KEY in server/.env to use E2B."}
    if _one_at_a_time.locked():
        return {"ok": False, "error": "busy", "message": "A smoke test is already running."}

    async with _one_at_a_time:
        factory = factory or _default_factory()
        started = time.monotonic()
        sandbox = None
        await audit("e2b_smoke_test", "started", {"command": SMOKE_COMMAND})
        try:
            sandbox = await asyncio.wait_for(
                factory(
                    timeout=SANDBOX_LIFETIME_S,
                    allow_internet_access=False,
                    metadata={"purpose": "omnipilot-smoke-test"},
                    api_key=key,
                    request_timeout=API_TIMEOUT_S,
                ),
                API_TIMEOUT_S + 5,
            )
            result = await asyncio.wait_for(
                sandbox.commands.run(SMOKE_COMMAND, envs={}, timeout=COMMAND_TIMEOUT_S, request_timeout=API_TIMEOUT_S),
                COMMAND_TIMEOUT_S + API_TIMEOUT_S,
            )
            elapsed = round((time.monotonic() - started) * 1000)
            output = {"ok": True, "output": bounded(result.stdout), "stderr": bounded(result.stderr), "exitCode": result.exit_code, "elapsedMs": elapsed}
            await audit("e2b_smoke_test", "success", {"exitCode": result.exit_code, "elapsedMs": elapsed, "outputChars": len(result.stdout or "")})
            return output
        except Exception as err:  # noqa: BLE001 -- every failure is reported, none escapes
            kind = _classify(err)
            await audit("e2b_smoke_test", f"failed: {kind}", {"error": type(err).__name__, "elapsedMs": round((time.monotonic() - started) * 1000)})
            failure: dict[str, Any] = {"ok": False, "error": kind, "message": _failure(kind)}
            if kind == "exit":
                failure["exitCode"] = getattr(err, "exit_code", None)
                failure["stderr"] = bounded(getattr(err, "stderr", ""))
            return failure
        finally:
            if sandbox is not None:
                try:
                    await asyncio.wait_for(sandbox.kill(request_timeout=API_TIMEOUT_S), API_TIMEOUT_S + 5)
                    await audit("e2b_smoke_test", "cleanup: sandbox terminated", {})
                except Exception as err:  # noqa: BLE001
                    # E2B still ends it when its 60-second lifetime runs out.
                    await audit("e2b_smoke_test", f"cleanup failed ({type(err).__name__}); E2B ends it after {SANDBOX_LIFETIME_S}s", {})


def _classify(err: Exception) -> str:
    name = type(err).__name__
    if isinstance(err, asyncio.TimeoutError) or name == "TimeoutException":
        return "timeout"
    if name == "AuthenticationException":
        return "auth"
    if name == "RateLimitException":
        return "rate_limit"
    if name == "CommandExitException":
        return "exit"
    return "error"
