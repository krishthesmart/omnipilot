"""CodePilot running things, from chat or from a routine ("every day at 6pm, run the tests in my snake game
project"):
  - "run the tests in my <project>": checked and tested here when it's safe, or in an E2B cloud sandbox when
    the tests need packages, the network or files deleted;
  - "run `python main.py` in my <project>" / "run `ls -la`": any shell command, but ONLY in an E2B cloud
    sandbox (with the project's files), never on the user's computer.
(Ported from server/src/agents/runCommand.ts.)"""
from __future__ import annotations

import os
import re

from ... import patches, store
from .. import cloud_run
from ..files import named_code_project
from ..project_check import check_project, describe_check
from .base import evidence, result
from .jsfmt import to_fixed

F = re.I | re.A
RUN_INTENT = re.compile(r"\b(run|execute|launch)\b[^.?!]*(`[^`]+`|\b(tests?|test suite|command|script|npm|pip|pytest|python3?|node|main\.py|make)\b)", F)
TESTS = re.compile(r"\btests?\b|test suite|pytest", F)
SKIP_DIRS = {"node_modules", "dist", "build", "__pycache__", ".venv", "venv"}


def project_files(root: str, folder: str) -> list[dict]:
    """A workspace project's files (text files under 200 kB, at most 300)."""
    out: list[dict] = []
    base = os.path.join(root, folder)

    def walk(d: str) -> None:
        for e in os.scandir(d):
            if e.name.startswith(".") or e.name in SKIP_DIRS:
                continue
            if e.is_dir():
                walk(e.path)
            elif e.is_file() and e.stat().st_size < 200_000 and len(out) < 300:
                with open(e.path, encoding="utf-8", errors="replace") as fh:
                    content = fh.read()
                if "\0" not in content:
                    out.append({"path": os.path.relpath(e.path, base).replace(os.sep, "/"), "content": content})

    walk(base)
    return out


def fence(s: str) -> str:
    return f"~~~text\n{s.strip() or '(no output)'}\n~~~"


async def run_command_skill(input: dict, ctx: dict) -> dict | None:
    # The whole request as typed: commands are taken from it exactly (never from a reworded part).
    typed = (input.get("context") or {}).get("originalRequest")
    typed = typed if isinstance(typed, str) else ""
    text = typed if typed and re.search(r"`[^`]+`", typed) else input["requestText"]
    if not RUN_INTENT.search(text):
        return None
    root = ctx.get("workspace_root") or patches.workspace_root()
    project = named_code_project(root, text)
    m = re.search(r"`([^`]+)`", text)
    command = m.group(1).strip() if m else None
    files = project_files(root, project.folder) if project else []

    # The project's tests.
    if not command and TESTS.search(text):
        if not project:
            return None  # not about a workspace project: CodePilot's usual paths handle it
        report = await check_project(files)
        t = report["tests"]
        store.audit(input["runId"], "CodePilot", "run_tests", {"project": project.folder, "via": t.get("via") or "none", "passed": t["passed"], "failed": t["failed"]}, "ran" if t["ran"] else "not run")
        return result(
            "success" if t["ran"] and not t["failed"] and not report["problems"] else "partial_success",
            [f"**Tests for {project.name}** (`{project.folder}/`): {describe_check(report)}", *([fence("\n".join(t["output"].split("\n")[-30:]))] if t["ran"] else [])],
            evidence=[evidence("e2b-sandbox" if t.get("via") == "e2b" else "local-sandbox", f"{t['passed']} passed, {t['failed']} failed")],
            confidence=0.9 if t["ran"] else 0.5,
        )

    # Any other command: only in a cloud sandbox.
    if not command:
        return None
    if not cloud_run.enabled():
        return result("partial_success", [
            "I don't run shell commands on your computer (for safety). With an E2B key, I run them in a throwaway cloud machine"
            f"{f' with your {project.name} files' if project else ''}: add E2B_API_KEY to server/.env (free account at e2b.dev) and ask again."], confidence=0.9)
    runs = await cloud_run.run_in_sandbox(files=files, commands=[command], command_timeout_s=180, run_id=input["runId"], why=text[:120])
    r = runs[0]
    store.audit(input["runId"], "CodePilot", "run_command", {"command": command, "project": project.folder if project else None, "exitCode": r["exitCode"]}, f"exit {r['exitCode']}")
    out = r["stdout"] + (f"\n{r['stderr']}" if r["stderr"] else "")
    return result(
        "success" if r["exitCode"] == 0 else "partial_success",
        [
            f"Ran `{command}` in an E2B cloud sandbox{f' with the files of **{project.name}**' if project else ''} ({to_fixed(r['ms'] / 1000, 1)} s, exit code {r['exitCode']}{', timed out' if r['timedOut'] else ''}):",
            fence("\n".join(out.split("\n")[-60:])),
            "The sandbox was thrown away afterwards: nothing it did affects your computer or your workspace files.",
        ],
        evidence=[evidence("e2b-sandbox", f"exit {r['exitCode']}")],
        confidence=0.9,
    )
