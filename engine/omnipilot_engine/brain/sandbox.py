"""Runs model-written code (CodePilot's snippets and a project's own tests) so CodePilot can check its work.

Two layers:
  1. A static check refuses code that reaches for files, the network, processes or the environment. This is a
     filter, not a boundary: a determined program can get around any pattern list.
  2. The real boundary is the operating system's sandbox (macOS: sandbox-exec). The code can't use the network,
     can't write outside its own throwaway folder, can't read the user's home folder (keys, .env files, tokens),
     and can only start the interpreters it needs. Every run also has an empty environment and limits on CPU
     time and file size. Where no OS sandbox is available (e.g. a Linux container), the limits still apply.
CODE_VERIFY=off turns execution off."""
from __future__ import annotations

import asyncio
import functools
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


F = re.A
DENY = {
    "python": re.compile(
        r"\b(import|from)\s+(os|sys|subprocess|socket|shutil|pathlib|requests|urllib|http|ctypes|multiprocessing|threading|signal|pickle|importlib|builtins|asyncio)\b"
        r"|\b(open|eval|exec|compile|__import__|input|globals|getattr|setattr|breakpoint|vars)\s*\("
        r"|__(subclasses|globals|builtins|bases|base|mro|code|closure|dict|loader|spec)__", F),
    "javascript": re.compile(r"\b(require|import)\b|\bprocess\b|\bglobalThis\b|\bchild_process\b|\b(eval|Function|fetch|setInterval|XMLHttpRequest|WebSocket)\s*\("
                             r"|\bconstructor\b|\b__proto__\b|\bReflect\b|\bProxy\b", F),
}


def enabled() -> bool:
    return os.environ.get("CODE_VERIFY") != "off"


def python_cmd() -> str:
    return os.environ.get("PYTHON") or ("python" if os.name == "nt" else "python3")


def node_cmd() -> str | None:
    """Node.js, for running and checking JavaScript (None if it isn't installed)."""
    return os.environ.get("NODE") or shutil.which("node") or next((p for p in ("/opt/homebrew/bin/node", "/usr/local/bin/node") if os.path.exists(p)), None)


def language(fence_tag: str, request: str) -> str | None:
    """Which runtime a fenced block can run in; None for languages the sandbox doesn't support (TypeScript, Go...)."""
    tag = fence_tag.lower()
    if tag in ("py", "python", "python3"):
        return "python"
    if tag in ("js", "javascript", "node"):
        return "javascript"
    if tag:
        return None
    return "javascript" if re.search(r"\b(javascript|node\.?js)\b", request, re.I | F) else "python"


def refusal_reason(lang: str, code: str) -> str | None:
    """Why a snippet won't run, or None if it may."""
    m = DENY[lang].search(code)
    return f"uses `{m.group(0).strip()}` (file, network, process or input access)" if m else None


def with_tests(lang: str, code: str, tests: list[str]) -> str:
    """Wraps each boolean test expression on its own, so one wrong test can't hide the others' results."""
    from .agents.jsfmt import js_json  # here, not at the top: the agents package imports this module
    # The code's own "main program" would run first and can exit before the checks; it's switched off in this copy only.
    if lang == "python":
        code = re.sub(r"^if\s+__name__\s*==\s*[\"']__main__[\"']\s*:", "if False:  # (main block skipped while testing)", code, flags=re.M | F)
        checks = "\n".join(f'try:\n    assert ({t})\n    print("TEST PASS")\nexcept Exception as _e:\n    print("TEST FAIL", {js_json(t)}, "->", type(_e).__name__, _e)' for t in tests)
        return f"{code}\n\n{checks}\n"
    body = re.sub(r"\brequire\.main\s*===?\s*module\b", "false", re.sub(r"^\s*export\s+(default\s+)?", "", code, flags=re.M | F), flags=F)
    checks = "\n".join(f'try {{ if (!({t})) throw new Error("returned false"); console.log("TEST PASS"); }} catch (e) {{ console.log("TEST FAIL", {js_json(t)}, "->", e && e.message); }}' for t in tests)
    return f"{body}\n\n{checks}\n"


def clean_env(home: str | None = None) -> dict:
    """Only what's needed to start the interpreter: no tokens, keys or other variables reach the code."""
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    if os.name == "nt":
        env["SystemRoot"] = os.environ.get("SystemRoot", "")
    if home:
        env.update(HOME=home, TMPDIR=home)
    return env


SANDBOX_EXEC = "/usr/bin/sandbox-exec"


def os_sandbox_available() -> bool:
    return sys.platform == "darwin" and os.path.exists(SANDBOX_EXEC) and os.environ.get("OMNIPILOT_OS_SANDBOX") != "off"


@functools.lru_cache(maxsize=8)
def _interpreter_dirs(program: str) -> tuple[str, ...]:
    """Folders an interpreter needs to read: its own install (and, for a Python virtual environment, the base Python)."""
    path = shutil.which(program) or program
    real = os.path.realpath(path)
    dirs = {str(Path(path).resolve().parent.parent), str(Path(real).parent.parent)}
    if "python" in os.path.basename(real):
        try:
            out = subprocess.run([path, "-I", "-c", "import sys; print(sys.prefix); print(sys.base_prefix)"], capture_output=True, text=True, timeout=10, env=clean_env())
            dirs |= {os.path.realpath(d) for d in out.stdout.split() if d}
        except (OSError, subprocess.TimeoutExpired):
            pass
    return tuple(sorted(dirs))


def _sb_str(p: str) -> str:
    return '"' + p.replace("\\", "\\\\").replace('"', '\\"') + '"'


def sandbox_profile(workdir: str, programs: list[str], allow_children: bool) -> str:
    """macOS sandbox rules: no network, writes only in the work folder, no reading the home folder (except what the
    interpreters themselves need), and only the interpreters may be started."""
    home = os.path.realpath(os.path.expanduser("~"))
    work = os.path.realpath(workdir)
    reads = sorted({d for prog in programs for d in _interpreter_dirs(prog)} | {work})
    execs = sorted({os.path.realpath(shutil.which(p) or p) for p in programs} | {shutil.which(p) or p for p in programs})
    rules = [
        "(version 1)",
        "(allow default)",
        "(deny network*)",
        "(deny file-write*)",
        f"(allow file-write* (subpath {_sb_str(work)}) (literal \"/dev/null\") (literal \"/dev/stdout\") (literal \"/dev/stderr\") (regex #\"^/dev/tty\"))",
        f"(deny file-read* (subpath {_sb_str(home)}))",
        "(allow file-read* " + " ".join(f"(subpath {_sb_str(d)})" for d in reads) + ")",
        "(allow file-read-metadata)",
        "(deny process-exec)",
        # the interpreters, and helpers inside their own installs (macOS Python relaunches itself from its framework)
        "(allow process-exec " + " ".join(f"(literal {_sb_str(e)})" for e in execs) + " " + " ".join(f"(subpath {_sb_str(d)})" for d in reads if d != work) + ")",
    ]
    if not allow_children:
        rules.append("(deny process-fork)")
    return "\n".join(rules)


def _limits(cpu_s: int) -> None:
    """Runs in the child before the program starts: caps CPU time and the size of any file it writes."""
    import resource

    for limit, value in ((resource.RLIMIT_CPU, cpu_s), (resource.RLIMIT_FSIZE, 50 * 1024 * 1024), (resource.RLIMIT_CORE, 0)):
        try:
            resource.setrlimit(limit, (value, value))
        except (ValueError, OSError):
            pass


async def run_process(cmd: list[str], cwd: str, timeout: float, env: dict, max_bytes: int = 1024 * 1024, isolate: bool = False, allow_children: bool = False) -> dict:
    """Runs a program with no shell. {"ok", "out", "timed_out"}; a missing program counts as a failure.
    isolate=True: model-written code; it runs inside the OS sandbox (see the module notes) with resource limits."""
    preexec = None
    if isolate:
        if os_sandbox_available():
            cmd = [SANDBOX_EXEC, "-p", sandbox_profile(cwd, [cmd[0]] + (["node", python_cmd()] if allow_children else []), allow_children), *cmd]
        if os.name == "posix":
            preexec = functools.partial(_limits, int(timeout) + 2)
    try:
        proc = await asyncio.create_subprocess_exec(*cmd, cwd=cwd, env=env, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, preexec_fn=preexec)
    except OSError as err:
        return {"ok": False, "out": str(err), "timed_out": False, "missing": True}
    try:
        out, errb = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return {"ok": False, "out": "", "timed_out": True}
    except asyncio.CancelledError:
        proc.kill()
        raise
    text = (out[:max_bytes].decode("utf-8", "replace") + errb[:max_bytes].decode("utf-8", "replace")).strip()
    return {"ok": proc.returncode == 0, "out": text, "timed_out": False}


async def run_sandboxed(lang: str, source: str, timeout_s: float = 5) -> dict:
    """{"ok", "output"} from running one snippet in a throwaway folder with an empty environment."""
    with tempfile.TemporaryDirectory(prefix="omnipilot-run-") as d:
        file = os.path.join(d, "main.py" if lang == "python" else "main.js")
        with open(file, "w", encoding="utf-8") as f:
            f.write(source)
        if lang == "python":
            cmd = [python_cmd(), "-I", file]
        else:
            node = node_cmd()
            if not node:
                return {"ok": False, "output": "Node.js isn't installed here, so JavaScript can't be run."}
            cmd = [node, file]
        r = await run_process(cmd, d, timeout_s, clean_env(), 64 * 1024, isolate=True)
        if r["timed_out"]:
            return {"ok": False, "output": f"Timed out after {timeout_s:g}s (infinite loop or very slow code?)"}
        return {"ok": r["ok"], "output": "\n".join(r["out"].split("\n")[-40:])[:4000]}


async def run_tests(lang: str, code: str, tests: list[str]) -> dict:
    """{"ran", "passed", "total", "failures", "output"}: the code with each test checked on its own."""
    run = await run_sandboxed(lang, with_tests(lang, code, tests))
    lines = run["output"].split("\n")
    passed = sum(1 for l in lines if l.startswith("TEST PASS"))
    failures = [re.sub(r"^TEST FAIL\s*", "", l) for l in lines if l.startswith("TEST FAIL")]
    ran = run["ok"] and passed + len(failures) == len(tests)
    return {"ran": ran, "passed": passed if ran else 0, "total": len(tests), "failures": failures if ran else [], "output": run["output"]}


__all__ = ["enabled", "language", "refusal_reason", "with_tests", "run_sandboxed", "run_tests", "run_process", "clean_env", "python_cmd", "node_cmd"]
