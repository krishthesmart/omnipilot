"""Checks a whole multi-file project before CodePilot offers it, the way a careful developer would:
  1. Every file parses (Python via ast, JavaScript via `node --check`, JSON, and local links in HTML).
  2. Files fit together: every local import points to a file in the project, and every name imported from
     it is really defined there.
  3. The project's own tests run (Python unittest, Node's built-in test runner) in a throwaway folder with an
     empty environment and a time limit, but only if no file reaches for the network, other processes or
     deleting files, and inside the same OS sandbox as CodePilot's snippets (brain/sandbox.py: no network, no
     writes outside the throwaway folder, no reading the home folder). What the local rules won't run
     (packages, network) runs in an E2B cloud sandbox when there's a key.
(Same behaviour as server/src/lib/projectCheck.ts.)"""
from __future__ import annotations

import json
import os
import posixpath
import re
import tempfile

from . import cloud_run
from .sandbox import clean_env, node_cmd, python_cmd, run_process

F = re.A
PY_INSPECT = r'''
import ast, json, sys
out = {}
for path in sys.argv[1:]:
    src = open(path, encoding="utf-8").read()
    try:
        tree = ast.parse(src, path)
    except SyntaxError as e:
        out[path] = {"error": {"line": e.lineno or 0, "msg": e.msg}}
        continue
    imports, names = [], set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                for n in ast.walk(t):
                    if isinstance(n, ast.Name): names.add(n.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for a in node.names: names.add((a.asname or a.name).split(".")[0])
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names: imports.append({"module": a.name, "names": [], "level": 0, "line": node.lineno})
        elif isinstance(node, ast.ImportFrom):
            imports.append({"module": node.module or "", "names": [a.name for a in node.names], "level": node.level, "line": node.lineno})
    out[path] = {"imports": imports, "names": sorted(names)}
print(json.dumps({"files": out, "stdlib": sorted(getattr(sys, "stdlib_module_names", []))}))
'''

PY_DENY = re.compile(
    r"\bimport\s+(subprocess|socket|ctypes|multiprocessing|requests|urllib3?|httpx|ftplib|smtplib|telnetlib|shutil)\b"
    r"|\bfrom\s+(subprocess|socket|ctypes|multiprocessing|requests|urllib3?|http|httpx|ftplib|smtplib|shutil)\b"
    r"|\bos\.(system|popen|exec\w*|spawn\w*|remove|unlink|rmdir|removedirs|kill|fork)\b|\b(eval|exec|__import__)\s*\(", F)
JS_DENY = re.compile(
    r"\b(child_process|worker_threads|node:net|node:dgram|node:https?|node:tls|node:cluster)\b|[\"'](net|dgram|https?|tls|cluster)[\"']|\bfetch\s*\("
    r"|\bprocess\.(kill|exit)\b|\b(rmSync|rm|unlink|unlinkSync|rmdir|rmdirSync)\s*\(|\beval\s*\(|\bnew\s+Function\b|\bXMLHttpRequest\b|\bWebSocket\b", F)
BUILTIN_JS = set("assert buffer crypto events fs path os readline stream string_decoder test timers url util zlib process perf_hooks querystring child_process http https net dgram worker_threads cluster tls module vm".split())
JS_IMPORT = re.compile(r"""\bimport\s+(?:type\s+)?(?:([\w$*{}\s,]+?)\s+from\s+)?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)|\bimport\(\s*["']([^"']+)["']\s*\)""", F)


def ext(p: str) -> str:
    return posixpath.splitext(p)[1].lower()


def is_py(p: str) -> bool:
    return ext(p) == ".py"


def is_js(p: str) -> bool:
    return ext(p) in (".js", ".mjs", ".cjs", ".jsx")


def is_ts(p: str) -> bool:
    return ext(p) in (".ts", ".tsx", ".mts")


def dirname(p: str) -> str:
    """Node's path.posix.dirname: "." for a file at the top."""
    return posixpath.dirname(p) or "."


def normalize(p: str) -> str:
    return posixpath.normpath(p) if p else "."


def test_run_refusal(files: list[dict]) -> str | None:
    """Why the project's tests won't be run here, or None if they may."""
    for f in files:
        rule = PY_DENY if is_py(f["path"]) else JS_DENY if is_js(f["path"]) or is_ts(f["path"]) else None
        m = rule.search(f["content"]) if rule else None
        if m:
            return f"{f['path']} uses `{m.group(0).strip()}` (network, processes or deleting files), so its tests weren't run automatically"
    return None


def resolve_js(frm: str, spec: str, paths: set[str]) -> str | None:
    """Where a JS import specifier points inside the project, or None."""
    base = normalize(posixpath.join(dirname(frm), spec))
    candidates = [base, *(base + e for e in (".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx")), *(f"{base}/{i}" for i in ("index.js", "index.ts", "index.jsx", "index.tsx"))]
    if base.endswith(".js"):  # TypeScript code imports "./x.js" for a file named x.ts
        candidates += [base[:-3] + ".ts", base[:-3] + ".tsx"]
    return next((c for c in candidates if c in paths), None)


def js_exports(src: str) -> set[str] | None:
    """Names a JS/TS module exports (best effort, by pattern); None when any name might be fine."""
    names = {m.group(1) for m in re.finditer(r"\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)", src, F)}
    for m in re.finditer(r"\bexport\s*\{([^}]*)\}", src, F):
        for part in m.group(1).split(","):
            n = re.split(r"\s+as\s+", part.strip())[-1].strip()
            if n:
                names.add(n)
    names |= {m.group(1) for m in re.finditer(r"\bexports\.([A-Za-z_$][\w$]*)\s*=", src, F)}
    cjs = re.search(r"\bmodule\.exports\s*=\s*\{([^}]*)\}", src, F)
    if cjs:
        for part in cjs.group(1).split(","):
            n = re.split(r"\s*:\s*", part.strip())[0].strip()
            if re.fullmatch(r"[A-Za-z_$][\w$]*", n, F):
                names.add(n)
    if re.search(r"\bmodule\.exports\s*=\s*(?!\{)", src, F) or re.search(r"\bexport\s+\*\s+from\b", src, F):
        return None
    return names


def _line_of(text: str, index: int) -> int:
    return text[:index].count("\n") + 1


async def check_project(files: list[dict], *, run_tests: bool = True, timeout_s: float | None = None, cloud: bool = True) -> dict:
    """{"problems": [{"file", "line"?, "message"}], "warnings": [...], "tests": {"ran", "passed", "failed", "output", "why"?, "via"?}}"""
    problems: list[dict] = []
    warnings: list[str] = []
    paths = {f["path"] for f in files}
    with tempfile.TemporaryDirectory(prefix="omnipilot-project-") as d:
        for f in files:
            full = os.path.join(d, f["path"])
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", encoding="utf-8") as fh:
                fh.write(f["content"])
        env = clean_env(d)

        # --- Python: syntax, local imports and names ---
        py = [f for f in files if is_py(f["path"])]
        py_third_party = False
        if py:
            r = await run_process([python_cmd(), "-I", "-c", PY_INSPECT, *(f["path"] for f in py)], d, 20, env, isolate=True)
            info = None
            try:
                info = json.loads(r["out"].split("\n")[-1])
            except ValueError:
                warnings.append("Python isn't available here, so the Python files weren't checked.")
            if info:
                stdlib = set(info["stdlib"])

                def module_path(mod: str, frm: str, level: int) -> str | None:
                    parts_of_dir = [p for p in dirname(frm).split("/") if p and p != "."]
                    base_parts = parts_of_dir[: max(0, len(parts_of_dir) - (level - 1))] if level else []
                    stem = "/".join([*base_parts, *(p for p in mod.split(".") if p)])
                    # Absolute imports may be relative to the project root or to the importing file's folder (scripts run from there).
                    roots = [""] if level else ["", "" if dirname(frm) == "." else dirname(frm) + "/"]
                    for root in roots:
                        for c in (f"{root}{stem}.py", f"{root}{stem}/__init__.py"):
                            if c.lstrip("/") in paths:
                                return c.lstrip("/")
                    return "<package>" if stem and any(f["path"].startswith(f"{root}{stem}/") for root in roots for f in files) else None

                for f in py:
                    fi = info["files"].get(f["path"])
                    if not fi:
                        continue
                    if fi.get("error"):
                        problems.append({"file": f["path"], "line": fi["error"]["line"], "message": f"Syntax error: {fi['error']['msg']}"})
                        continue
                    for imp in fi["imports"]:
                        top = imp["module"].split(".")[0]
                        local = module_path(imp["module"], f["path"], imp["level"])
                        if not local:
                            if imp["level"] > 0:
                                problems.append({"file": f["path"], "line": imp["line"], "message": f"Imports \"{'.' * imp['level']}{imp['module']}\", which isn't a file in the project."})
                            elif top and top not in stdlib:
                                py_third_party = True
                            continue
                        if local == "<package>":
                            continue
                        target = info["files"].get(local)
                        if not target or target.get("error"):
                            continue
                        for n in imp["names"]:
                            if n == "*" or n in target["names"] or module_path(f"{imp['module']}.{n}", f["path"], imp["level"]):
                                continue
                            problems.append({"file": f["path"], "line": imp["line"], "message": f"Imports {n} from {local}, but {local} doesn't define {n}."})

        # --- JavaScript / TypeScript: syntax and local imports ---
        if any(is_ts(f["path"]) for f in files):
            warnings.append("TypeScript files were checked for imports only (the TypeScript parser isn't installed here).")
        node = node_cmd()
        js_bare = False
        for f in [x for x in files if is_js(x["path"]) or is_ts(x["path"])]:
            if is_js(f["path"]) and ext(f["path"]) != ".jsx":
                if node:
                    r = await run_process([node, "--check", f["path"]], d, 10, env, isolate=True)
                    if not r["ok"]:
                        m = re.search(r":(\d+)\n", r["out"])
                        first = next((l.strip() for l in r["out"].split("\n") if "Error" in l), None)
                        problems.append({"file": f["path"], "line": int(m.group(1)) if m and int(m.group(1)) else None, "message": f"Syntax error: {first or r['out'][:200]}"})
                elif "Node.js isn't installed here, so JavaScript syntax wasn't checked." not in warnings:
                    warnings.append("Node.js isn't installed here, so JavaScript syntax wasn't checked.")
            for m in JS_IMPORT.finditer(f["content"]):
                spec = m.group(2) or m.group(3) or m.group(4)
                line = _line_of(f["content"], m.start())
                if not spec.startswith(".") and not spec.startswith("/"):
                    name = re.sub(r"^node:", "", spec).split("/")[0]
                    if not spec.startswith("node:") and name not in BUILTIN_JS:
                        js_bare = True
                    continue
                target = resolve_js(f["path"], spec, paths)
                if not target:
                    problems.append({"file": f["path"], "line": line, "message": f"Imports \"{spec}\", which isn't a file in the project."})
                    continue
                named = re.search(r"\{([^}]*)\}", m.group(1) or "")
                exported = js_exports(next(x for x in files if x["path"] == target)["content"]) if named else None
                if named and exported is not None:
                    for part in named.group(1).split(","):
                        n = re.split(r"\s+as\s+", re.sub(r"^type\s+", "", part.strip()))[0].strip()
                        if n and n not in exported:
                            problems.append({"file": f["path"], "line": line, "message": f"Imports {n} from {target}, but {target} doesn't export it."})

        # --- JSON and HTML ---
        for f in files:
            if ext(f["path"]) == ".json":
                try:
                    json.loads(f["content"])
                except ValueError as e:
                    problems.append({"file": f["path"], "message": f"Invalid JSON: {e}"})
            if ext(f["path"]) == ".html":
                for m in re.finditer(r"<(?:script|img)[^>]+src=[\"']([^\"']+)[\"']|<link[^>]+href=[\"']([^\"']+)[\"']", f["content"], re.I):
                    ref = re.split(r"[?#]", m.group(1) or m.group(2))[0]
                    if not ref or re.match(r"^(https?:|data:|//|#|mailto:)", ref):
                        continue
                    target = normalize(posixpath.join(dirname(f["path"]), ref)).lstrip("/")
                    if target not in paths:
                        problems.append({"file": f["path"], "message": f"Links to \"{ref}\", which isn't a file in the project."})

        # --- Tests ---
        tests: dict = {"ran": False, "passed": 0, "failed": 0, "output": ""}
        py_tests = [f for f in py if cloud_run.PY_TEST.search(f["path"])]
        js_tests = [f for f in files if cloud_run.JS_TEST.search(f["path"])]
        if run_tests and (py_tests or js_tests):
            refusal = test_run_refusal(files)
            needs_cloud = refusal or ("the Python code uses packages that aren't installed here" if py_tests and py_third_party
                                      else "the JavaScript code uses npm packages that aren't installed here" if js_tests and js_bare else None)
            if problems:
                tests["why"] = "the files still have the problems listed above"
            elif needs_cloud and cloud_run.enabled() and cloud:
                # What the local guard rails won't run runs in a throwaway E2B cloud machine instead.
                try:
                    install = cloud_run.install_commands(files)
                    runs = await cloud_run.run_in_sandbox(files=files, commands=[*install, *cloud_run.test_commands(files)], command_timeout_s=timeout_s or 180, why="project tests")
                    test_runs = runs[len(install):]
                    output = "\n".join(f"$ {r['command']}\n{r['stdout']}{r['stderr']}" for r in runs).strip()
                    counts = [cloud_run.count_tests(f"{r['stdout']}\n{r['stderr']}") for r in test_runs]
                    passed, failed = sum(c["passed"] for c in counts), sum(c["failed"] for c in counts)
                    if any(r["exitCode"] != 0 for r in test_runs) and failed == 0:
                        failed = 1
                    if any(r["exitCode"] != 0 for r in runs[: len(install)]):
                        problems.append({"file": "(install)", "message": "Installing the project's packages failed in the cloud sandbox."})
                    tests = {"ran": bool(test_runs), "passed": passed, "failed": failed, "output": "\n".join(output.split("\n")[-60:])[:6000], "via": "e2b"}
                except Exception as e:
                    tests["why"] = f"{needs_cloud}, and the E2B cloud sandbox couldn't run them ({str(e)[:120]})"
            elif needs_cloud:
                tests["why"] = needs_cloud + ("" if cloud_run.enabled() else " (with an E2B key, OmniPilot runs these in a cloud sandbox)")
            else:
                timeout = timeout_s or 30
                output, passed, failed = "", 0, 0
                if py_tests:
                    # Run from the project root (so `from todo.core import ...` works) with a clean environment.
                    for test_dir in dict.fromkeys(dirname(t["path"]) for t in py_tests):
                        r = await run_process([python_cmd(), "-E", "-s", "-m", "unittest", "discover", "-s", test_dir, "-p", "*test*.py", "-v"], d, timeout, env, isolate=True)
                        output += f"Python tests timed out after {timeout:g}s.\n" if r["timed_out"] else r["out"] + "\n"
                        passed += len(re.findall(r"\.\.\. ok$", r["out"], re.M))
                        failed += (len(re.findall(r"\.\.\. (FAIL|ERROR)$", r["out"], re.M))
                                   + (1 if re.search(r"^(ERROR|FAIL):", r["out"], re.M) and not re.search(r"\.\.\. (FAIL|ERROR)$", r["out"], re.M) else 0)
                                   + (1 if r["timed_out"] else 0))
                        if not r["ok"] and passed + failed == 0:
                            failed = 1
                if js_tests:
                    if not node:
                        output += "Node.js isn't installed here, so the JavaScript tests couldn't run.\n"
                        failed += 1
                    else:
                        r = await run_process([node, "--test", *(t["path"] for t in js_tests)], d, timeout, env, isolate=True, allow_children=True)
                        output += f"JavaScript tests timed out after {timeout:g}s.\n" if r["timed_out"] else r["out"] + "\n"
                        mp, mf = re.search(r"^# pass (\d+)", r["out"], re.M), re.search(r"^# fail (\d+)", r["out"], re.M)
                        passed += int(mp.group(1)) if mp else 0
                        failed += (int(mf.group(1)) if mf else 0) + (1 if r["timed_out"] else 0)
                        if not r["ok"] and not mf:
                            failed = max(failed, 1)
                tests = {"ran": True, "passed": passed, "failed": failed, "output": "\n".join(output.strip().split("\n")[-60:])[:6000], "via": "local"}
        elif not py_tests and not js_tests:
            tests["why"] = "the project has no automated tests"
        return {"problems": problems, "warnings": warnings, "tests": tests}


def describe_check(r: dict) -> str:
    """Plain-words summary of a check, for the answer."""
    probs = r["problems"]
    parts = [f"⚠️ {len(probs)} problem{'' if len(probs) == 1 else 's'} left: " + "; ".join(f"{p['file']}{':' + str(p['line']) if p.get('line') else ''} {p['message']}" for p in probs[:5])
             if probs else "✅ Every file parses and all local imports match."]
    t = r["tests"]
    where = "in an E2B cloud sandbox" if t.get("via") == "e2b" else "in a sandbox"
    if t["ran"]:
        parts.append(f"❌ Tests: {t['passed']} passed, {t['failed']} failed ({where})." if t["failed"] else f"✅ Tests: all {t['passed']} passed (run {where}).")
    elif t.get("why"):
        parts.append(f"Tests not run: {t['why']}.")
    return " ".join([*parts, *r["warnings"]])
