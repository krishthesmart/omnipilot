"""Running commands in an E2B cloud sandbox (https://e2b.dev): a fresh, isolated Linux machine for each job,
thrown away afterwards. This is how CodePilot runs what its local guard rails won't: installing packages,
tests that need the network, any shell command a request or routine asks for. Commands never run on the
user's computer.
  - Only the project's files (or none) are uploaded.
  - Every command has a time limit, the sandbox has a lifetime limit, and it's always shut down at the end.
  - E2B_API_KEY stays on the server; E2B=off turns this off.
(Same behaviour as server/src/lib/e2b.ts.)"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time

from .. import envfiles, store

PROJECT_DIR = "/home/user/project"
_sdk_override = None  # tests replace the SDK's AsyncSandbox with a fake


def set_sdk(sandbox_cls) -> None:
    global _sdk_override
    _sdk_override = sandbox_cls


def enabled() -> bool:
    return bool((envfiles.secret("E2B_API_KEY") or "").strip()) and os.environ.get("E2B") != "off"


def _tail(s: str | None, n: int = 6000) -> str:
    s = s or ""
    return f"…{s[-n:]}" if len(s) > n else s


async def run_in_sandbox(*, commands: list[str], files: list[dict] | None = None, command_timeout_s: float = 120, stop_on_failure: bool = False,
                         run_id: str | None = None, why: str = "") -> list[dict]:
    """Uploads `files` to the project folder and runs `commands` there one after another. Returns each
    command's {"command", "exitCode", "stdout", "stderr", "ms", "timedOut"}."""
    if not enabled():
        raise RuntimeError("E2B isn't set up: add E2B_API_KEY to server/.env (free account at e2b.dev).")
    if _sdk_override is not None:
        Sandbox = _sdk_override
    else:
        from e2b import AsyncSandbox as Sandbox
    lifetime = int(min(15 * 60, command_timeout_s * len(commands) + 60))
    sbx = await Sandbox.create(api_key=envfiles.secret("E2B_API_KEY").strip(), timeout=lifetime)
    runs: list[dict] = []
    try:
        if files:
            for f in files:
                await sbx.files.write(f"{PROJECT_DIR}/{f['path']}", f["content"])
        else:
            await sbx.commands.run(f"mkdir -p {PROJECT_DIR}")
        for command in commands:
            t0 = time.monotonic()
            try:
                r = await sbx.commands.run(command, cwd=PROJECT_DIR, timeout=command_timeout_s)
                run = {"command": command, "exitCode": getattr(r, "exit_code", 0) or 0, "stdout": _tail(r.stdout), "stderr": _tail(r.stderr), "ms": int((time.monotonic() - t0) * 1000), "timedOut": False}
            except Exception as e:  # a non-zero exit arrives as an error that still carries the output
                timed_out = bool(re.search(r"timeout|deadline", f"{type(e).__name__}{e}", re.I))
                code = getattr(e, "exit_code", None)
                run = {"command": command, "exitCode": code if isinstance(code, int) else 1, "stdout": _tail(getattr(e, "stdout", "")),
                       "stderr": _tail(getattr(e, "stderr", None) or str(e)), "ms": int((time.monotonic() - t0) * 1000), "timedOut": timed_out}
            runs.append(run)
            store.audit(run_id or "n/a", "CodePilot", "e2b_command", {"command": command, "why": why},
                        "timed out" if run["timedOut"] else f"exit {run['exitCode']} in {round(run['ms'] / 100) / 10:g}s")
            if run["exitCode"] != 0 and stop_on_failure:
                break
    finally:
        try:
            await asyncio.wait_for(sbx.kill(), 15)
        except Exception:
            pass  # E2B also ends it when its lifetime runs out
    return runs


def install_commands(files: list[dict]) -> list[str]:
    """How to install a project's dependencies, from its files (requirements.txt, pyproject.toml, package.json)."""
    out, paths = [], {f["path"] for f in files}
    if "requirements.txt" in paths:
        out.append("pip install --quiet -r requirements.txt")
    if "pyproject.toml" in paths and "requirements.txt" not in paths:
        out.append("pip install --quiet .")
    pkg = next((f for f in files if f["path"] == "package.json"), None)
    if pkg:
        try:
            p = json.loads(pkg["content"])
            if {**(p.get("dependencies") or {}), **(p.get("devDependencies") or {})}:
                out.append("npm install --silent --no-audit --no-fund")
        except (ValueError, AttributeError, TypeError):
            pass  # invalid package.json: the checks report it
    return out


JS_TEST = re.compile(r"\.test\.(m?js|cjs)$|(^|/)tests?/[^/]+\.(m?js|cjs)$")
PY_TEST = re.compile(r"(^|/)test_[^/]*\.py$|_test\.py$")


def test_commands(files: list[dict]) -> list[str]:
    """The project's test command(s): its own (package.json "test"), or the standard runners."""
    out = []
    pkg = next((f for f in files if f["path"] == "package.json"), None)
    npm_test = False
    if pkg:
        try:
            t = ((json.loads(pkg["content"]) or {}).get("scripts") or {}).get("test")
            npm_test = isinstance(t, str) and "no test specified" not in t
        except (ValueError, AttributeError, TypeError):
            pass
    if npm_test:
        out.append("npm test")
    elif any(JS_TEST.search(f["path"]) for f in files):
        out.append("node --test")
    py_tests = [f for f in files if PY_TEST.search(f["path"])]
    if py_tests:
        if any("pytest" in f["content"] for f in files):
            out.append("python -m pytest -q")
        else:
            for d in dict.fromkeys("/".join(t["path"].split("/")[:-1]) or "." for t in py_tests):
                out.append(f'python -m unittest discover -s {d} -p "*test*.py" -v')
    return out


def count_tests(output: str) -> dict:
    """Pass/fail counts from test output (unittest, pytest, node --test)."""
    node = re.search(r"^# pass (\d+)[\s\S]*?^# fail (\d+)", output, re.M)
    if node:
        return {"passed": int(node.group(1)), "failed": int(node.group(2))}
    passed, failed = re.search(r"(\d+) passed", output), re.search(r"(\d+) (failed|error)", output)
    if passed or failed:
        return {"passed": int(passed.group(1)) if passed else 0, "failed": int(failed.group(1)) if failed else 0}
    return {"passed": len(re.findall(r"\.\.\. ok$", output, re.M)), "failed": len(re.findall(r"\.\.\. (FAIL|ERROR)$", output, re.M))}
