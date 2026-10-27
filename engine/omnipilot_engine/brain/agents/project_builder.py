"""CodePilot's large-scale coding: whole projects, and changes across an existing codebase.

New project ("build a flashcard app in Python with tests"): plan the files and what each provides -> write
them in dependency order (each file sees the files it uses, so names and signatures match) -> check the whole
project (every file parses, imports match, the project's own tests run in a sandbox) -> repair what failed, up
to three rounds -> offer it as one change set under workspace/projects/, with a file browser and (for web
projects) a live preview. Nothing is written until the user approves.

Existing project ("add a high-score table to my snake game project"): read the project -> plan which files
change -> rewrite small files whole and edit big files with exact find/replace blocks -> check the whole
project with the changes -> repair -> offer the change set as diffs, applied all-or-nothing on approval.

These are hard jobs, so they go to Groq first (the local model is the fallback).
(Ported from server/src/agents/projectBuilder.ts.)"""
from __future__ import annotations

import asyncio
import os
import posixpath
import re
import time

from ... import llm, patches, store
from ..files import workspace_index
from ..specs import EDIT_PROJECT, is_project_request  # noqa: F401  (re-exported for CodePilot)
from ..project_check import check_project, describe_check
from .base import clip, evidence, proposed_action, result

F = re.A
MAX_FILES = 24
FENCE_RE = re.compile(r"^~~~~(file|edit) ([^\n]+)\n([\s\S]*?)\n~~~~[ \t]*$", re.M)

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"}, "summary": {"type": "string"},
        "language": {"type": "string", "enum": ["python", "javascript", "typescript", "web"]},
        "run": {"type": "string"}, "test": {"type": "string"},
        "files": {"type": "array", "items": {"type": "object", "properties": {"path": {"type": "string"}, "purpose": {"type": "string"}, "provides": {"type": "string"}, "uses": {"type": "array", "items": {"type": "string"}}},
                                             "required": ["path", "purpose", "provides", "uses"]}},
    },
    "required": ["name", "summary", "language", "run", "test", "files"],
}

PLAN_SYSTEM = f"""You are a senior software architect planning a complete, working project that a student can run immediately.
Rules:
- Use only the language's standard library unless the user names a framework or library. Plain web projects are HTML + CSS + JavaScript with no build step.
- Web projects: load scripts with classic <script src> tags in dependency order (no import/export), so index.html works when double-clicked. Put game/app logic in its own file and end it with: if (typeof module !== "undefined") module.exports = {{ ...the logic functions }};  so tests can require it. Test files are named *.test.cjs and use node:test + node:assert with require(). No package.json for plain web projects.
- Python: a package folder for the logic, a main.py entry point, and tests in tests/test_*.py using unittest (import the package from the project root).
- JavaScript (Node): ES modules ("type": "module" in package.json), tests as *.test.js with node:test.
- Separate concerns: logic, data/storage, interface. Small focused files (under ~250 lines each), at most {MAX_FILES} files including a README.md (what it is, how to run, how to test).
- Write real tests for the logic (several meaningful cases each), not placeholders. Tests that touch files use a temporary folder that cleans itself up (Python: tempfile.TemporaryDirectory(); Node: fs.mkdtempSync(path.join(os.tmpdir(), "t-"))) and never delete files directly (no os.remove/os.unlink/shutil/fs.rmSync). No network, no subprocesses.
- For each file give its path, its purpose, exactly what it provides (function/class names with parameters and return values; for HTML the element ids; for CSS the main classes), and which other project files it uses.
- name: short kebab-case folder name. run/test: the exact shell commands, run from the project folder."""

FILE_SYSTEM = """You write ONE file of a multi-file project, complete and production quality: no placeholders, no "TODO", no omitted parts.
Tests: use a self-cleaning temporary folder for any files (tempfile.TemporaryDirectory() / fs.mkdtempSync in os.tmpdir()), never delete files directly, no network or subprocesses.
Match the plan exactly: use the exact names, parameters and return values the plan and the files you depend on define. Handle errors and edge cases. Comment only where it helps.
Reply with only the file inside one block that starts with a line "~~~~file <path>" and ends with a line "~~~~"."""

REPAIR_SYSTEM = """You fix a multi-file project so it passes its checks and tests. You see the problems, the test output and the relevant files.
Fix the real cause (the code under test is usually what's wrong, but fix a test if the test itself contradicts the plan). Keep everything that works.
For each file you change, reply with the COMPLETE new file in a block that starts with "~~~~file <path>" and ends with "~~~~". Change only files that need it."""

EDIT_PLAN_SCHEMA = {
    "type": "object",
    "properties": {"summary": {"type": "string"},
                   "changes": {"type": "array", "items": {"type": "object", "properties": {"path": {"type": "string"}, "action": {"type": "string", "enum": ["modify", "create"]}, "what": {"type": "string"}}, "required": ["path", "action", "what"]}}},
    "required": ["summary", "changes"],
}

EDIT_SYSTEM = """You change an existing codebase as requested, like a careful senior engineer: keep its style, structure and names, change only what's needed, and keep existing behaviour working (update or add tests for what you change).
For a NEW file or a small file, reply with the complete file: "~~~~file <path>" ... "~~~~".
For a LARGE existing file, reply with exact edits instead:
~~~~edit <path>
<<<<<<< FIND
(exact existing lines, copied character for character, enough to be unique)
=======
(replacement lines)
>>>>>>> REPLACE
~~~~
(several FIND/REPLACE pairs may go in one edit block)."""


def project_to_edit(text: str, root: str):
    """Changing an existing workspace project (one the file index recognises)."""
    if not EDIT_PROJECT.search(text):
        return None
    try:
        found = workspace_index(root).match_projects(text)
        return found[0] if found else None
    except OSError:
        return None


def clean_path(p: str) -> str:
    return re.sub(r"^\./", "", re.sub(r"^[\"'`]|[\"'`]$", "", p.strip())).replace("\\", "/")


def unwrap_fence(body: str, file: str) -> str:
    """A file body the model wrapped in an extra ```lang fence (inside our block): take the code out."""
    if re.search(r"\.(md|markdown)$", file.strip(), re.I):
        return body
    m = re.match(r"^\s*```[\w+.-]*[ \t]*\n([\s\S]*?)\n```[ \t]*\s*$", body, F)
    return m.group(1) if m else body


def parse_blocks(text: str) -> list[dict]:
    """Every "~~~~file path" / "~~~~edit path" block in a reply."""
    return [{"kind": m.group(1), "path": clean_path(m.group(2)), "body": unwrap_fence(m.group(3), m.group(2)) if m.group(1) == "file" else m.group(3)} for m in FENCE_RE.finditer(text)]


def extract_file(reply: str, file: str) -> str | None:
    """The file's content from a reply, whatever fence the model used: our "~~~~file" block (even without its
    closing line), else the largest ``` block, else the whole reply."""
    blocks = [b for b in parse_blocks(reply) if b["kind"] == "file"]
    exact = next((b for b in blocks if b["path"] == file), blocks[0] if blocks else None)
    if exact:
        return exact["body"]
    open_ = re.search(r"^~~~~file[^\n]*\n([\s\S]*)$", reply, re.M)
    if open_:
        return unwrap_fence(re.sub(r"\n~~~~\s*$", "", open_.group(1)), file)
    if re.search(r"\.(md|markdown)$", file, re.I):
        return re.sub(r"^\s*```(markdown|md)?\n|\n```\s*$", "", reply) if reply.strip() else None
    fences = [m.group(1) for m in re.finditer(r"```[\w+.-]*[ \t]*\n([\s\S]*?)\n```", reply, F)]
    if fences:
        return sorted(fences, key=len, reverse=True)[0]
    return reply if reply.strip() else None


def safe_rel(p: str) -> str | None:
    """A safe relative path inside the project (no absolute paths, no "..", no hidden folders)."""
    c = clean_path(p)
    if not c or c.startswith("/") or re.match(r"^[a-z]:", c, re.I) or any(part in ("..", "") or part.startswith(".") for part in c.split("/")) or len(c) > 160:
        return None
    return c


def apply_edits(original: str, body: str) -> dict:
    """Applies FIND/REPLACE pairs; each FIND must match exactly once. {"text", "failed"}"""
    text, failed = original, []
    for m in re.finditer(r"<<<<<<< FIND\n([\s\S]*?)\n=======\n([\s\S]*?)\n?>>>>>>> REPLACE", body):
        find, replace = m.group(1), m.group(2)
        at = text.find(find)
        if at < 0 or text.find(find, at + 1) >= 0:
            failed.append(find.split("\n")[0][:80])
            continue
        text = text[:at] + replace + text[at + len(find):]
    return {"text": text, "failed": failed}


def write_order(files: list[dict]) -> list[list[dict]]:
    """Files grouped so each group only uses files from earlier groups (writing order)."""
    paths = {f["path"] for f in files}
    done: set[str] = set()
    levels, left = [], list(files)
    while left:
        ready = [f for f in left if all(u in done for u in f["uses"] if u in paths and u != f["path"])]
        level = ready or left  # a cycle: write the rest together
        levels.append(level)
        done |= {f["path"] for f in level}
        left = [f for f in left if f not in level]
    return levels


LANGS = {".py": "python", ".js": "javascript", ".cjs": "javascript", ".mjs": "javascript", ".ts": "typescript", ".tsx": "tsx", ".jsx": "jsx", ".html": "html", ".css": "css", ".json": "json", ".md": "markdown"}


def lang(p: str) -> str:
    return LANGS.get(posixpath.splitext(p)[1].lower(), "text")


def tree_text(files: list[dict]) -> str:
    return "\n".join(f"{f['path']} ({len(f['content'].split(chr(10)))} lines)" for f in files)


def inline_web_preview(files: list[dict]) -> str | None:
    """index.html with its local CSS and scripts inlined, for the sandboxed live preview."""
    index = next((f for f in files if re.search(r"(^|/)index\.html$", f["path"], re.I)), None)
    if not index:
        return None
    d = posixpath.dirname(index["path"]) or "."

    def get(ref: str):
        target = posixpath.normpath(posixpath.join(d, ref)).lstrip("/")
        return next((f for f in files if f["path"] == target), None)

    if any(re.search(r"\.m?js$", f["path"]) and re.search(r"^\s*(import|export)\s", f["content"], re.M) for f in files):
        return None  # ES modules can't be inlined safely
    css = lambda m: f"<style>\n{get(m.group(1))['content']}\n</style>" if get(m.group(1)) else m.group(0)
    js = lambda m: "<script>\n" + re.sub(r"</script", r"<\\/script", get(m.group(2))["content"], flags=re.I) + "\n</script>" if get(m.group(2)) else m.group(0)
    out = re.sub(r"<link[^>]*href=[\"']([^\"':]+\.css)[\"'][^>]*>", css, index["content"], flags=re.I)
    return re.sub(r"<script([^>]*)src=[\"']([^\"':]+\.js)[\"']([^>]*)>\s*</script>", js, out, flags=re.I)


OUTLINE_LINE = re.compile(
    r"^\s*(async\s+)?(def|class)\s+\w|^\s*(export\s+)?(default\s+)?(async\s+)?(function\*?|class|interface|type|enum)\s+\w"
    r"|^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(\(|function|\w+\s*=>)|module\.exports|^\s*[A-Z_]{3,}\s*=|\sid=[\"'][\w-]+[\"']", F)


def outline(file: str, content: str) -> str:
    """A file's outline: its size and the lines that define things (functions, classes, exports, ids)."""
    defs = [f"    {l.strip()[:140]}" for l in content.split("\n") if OUTLINE_LINE.search(l)][:25]
    return f"- {file} ({len(content.split(chr(10)))} lines)" + ("\n" + "\n".join(defs) if defs else "")


def progress(input: dict, message: str, **details) -> None:
    store.audit(input["runId"], "CodePilot", "build_progress", {"message": message, **details}, message)


def model_name() -> str:
    return (llm.last_answer.get() or {}).get("model") or llm.local_model()


async def ask(system: str, user: str, max_tokens: int, temperature: float = 0.2) -> str | None:
    return await llm.generate_text(system, user, max_tokens=max_tokens, temperature=temperature, max_input=60_000, hard=True, effort="medium")


def _stopped(ctx: dict) -> bool:
    stop = ctx.get("stop")
    return bool(stop is not None and stop.is_set())


def _refused(r: dict) -> bool:
    """Tests the sandbox refused to run (they delete files, use the network...) count as a problem to fix."""
    return bool(r["tests"].get("why") and re.search(r"\buses `", r["tests"]["why"]))


def _badness(r: dict) -> int:
    return len(r["problems"]) * 2 + r["tests"]["failed"] + (1 if _refused(r) else 0)


async def check_and_repair(input: dict, ctx: dict, files: dict[str, str], context: str, deadline: float) -> tuple[dict, int]:
    """Rounds of check -> repair. A repair is kept only if it leaves fewer problems + failing tests."""
    as_list = lambda: [{"path": p, "content": c} for p, c in files.items()]
    report = await check_project(as_list())
    repairs = 0
    round_ = 1
    while round_ <= 3 and (report["problems"] or report["tests"]["failed"] or _refused(report)) and time.monotonic() < deadline - 40 and not _stopped(ctx):
        n_probs, n_failed = len(report["problems"]), report["tests"]["failed"]
        progress(input, f"Fixing {f'{n_probs} problem(s)' if n_probs else f'{n_failed} failing test(s)' if n_failed else 'tests so they can run safely'} (round {round_})…")
        involved = {p["file"] for p in report["problems"]}
        refused_file = None
        if _refused(report):
            m = re.match(r"^(\S+) uses", report["tests"]["why"])
            refused_file = m.group(1) if m else None
        if refused_file and refused_file in files:
            involved.add(refused_file)
        if n_failed:
            for p in files:
                if re.search(r"test", p, re.I) or posixpath.splitext(posixpath.basename(p))[0] in report["tests"]["output"]:
                    involved.add(p)
        if not involved:
            involved = {p for p in files if not re.search(r"\.(md|json|css)$", p)}
        budget = 30_000
        full = []
        for p in [p for p in involved if p in files]:
            budget -= len(files[p])
            if budget >= 0:
                full.append(p)
        shown = "\n\n".join([*(f"~~~~file {p}\n{files[p]}\n~~~~" for p in full),
                             "Outline of the other files:\n" + "\n".join(outline(p, c) for p, c in files.items() if p not in full)])
        problems = "\n".join(f"- {p['file']}{':' + str(p['line']) if p.get('line') else ''}: {p['message']}" for p in report["problems"])
        refusal_note = (f"\n- {report['tests']['why']}. Rewrite it to use a self-cleaning temporary folder (tempfile.TemporaryDirectory() / fs.mkdtempSync in os.tmpdir()) "
                        "with no direct file deletion, network or subprocesses, so the tests can run.") if refused_file else ""
        reply = await ask(REPAIR_SYSTEM, f"{context}\n\nAll files: {', '.join(files)}\n\nProblems:\n{problems or '(none)'}{refusal_note}\n\nTest output:\n"
                                         f"{report['tests']['output'][-4000:] if report['tests']['ran'] else '(not run)'}\n\nFiles:\n{shown}", 9000, 0.15)
        blocks = [b for b in parse_blocks(reply) if b["kind"] == "file" and safe_rel(b["path"]) and b["body"].strip()] if reply else []
        if not blocks:
            break
        before = dict(files)
        for b in blocks:
            files[safe_rel(b["path"])] = b["body"] if b["body"].endswith("\n") else b["body"] + "\n"
        nxt = await check_project(as_list())
        if _badness(nxt) < _badness(report) or (nxt["tests"]["ran"] and not report["tests"]["ran"] and len(nxt["problems"]) <= len(report["problems"])):
            report, repairs = nxt, repairs + 1
        else:
            files.clear()
            files.update(before)
        round_ += 1
    return report, repairs


def security_notes(files: dict[str, str]) -> list[str]:
    from .code_pilot import scan_source

    return [f"{p}:{f['line']} {f['rule']['title']}" for p, c in files.items() for f in scan_source(p, c)][:6]


def free_folder(root: str, name: str) -> str:
    slug = (re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9-]+", "-", name.lower())) or "project")[:40]
    for i in range(1, 50):
        rel = f"projects/{slug}{f'-{i}' if i > 1 else ''}"
        if not os.path.exists(os.path.join(root, rel)):
            return rel
    return f"projects/{slug}-{int(time.time() * 1000)}"


NO_MODEL = ("Building or changing a project needs an AI model, and none answered: add GROQ_API_KEY to server/.env (these big jobs go to Groq first) "
            "or start Ollama with the local model, then try again.")


def no_model() -> dict:
    return result("partial_success", [NO_MODEL], confidence=0.1)


async def build_project(input: dict, ctx: dict, budget_s: float = 330) -> dict:
    """Builds a new multi-file project."""
    if not await llm.available():
        return no_model()
    deadline = time.monotonic() + budget_s
    request = input["requestText"]
    root = ctx.get("workspace_root") or patches.workspace_root()
    progress(input, "Planning the project…")
    plan = await llm.generate_json(PLAN_SYSTEM, request, schema=PLAN_SCHEMA, temperature=0.2, max_tokens=4000, hard=True)
    if not isinstance(plan, dict) or not plan.get("files"):
        return no_model()
    planned, seen = [], set()
    for f in plan["files"]:
        p = safe_rel(str(f.get("path") or ""))
        if p and p not in seen:
            seen.add(p)
            planned.append({**f, "path": p, "uses": [u for u in (safe_rel(str(u)) for u in (f.get("uses") or [])) if u]})
    planned = planned[:MAX_FILES]
    plan_text = (f"Project: {plan['name']} -- {plan['summary']}\nLanguage: {plan['language']}. Run: {plan['run']}. Test: {plan['test']}\nFiles:\n"
                 + "\n".join(f"- {f['path']}: {f['purpose']}. Provides: {f['provides']}" + (f". Uses: {', '.join(f['uses'])}" if f["uses"] else "") for f in planned))
    store.audit(input["runId"], "CodePilot", "project_plan", {"name": plan["name"], "files": len(planned), "language": plan["language"]}, "planned")

    # Write in dependency order; files in the same group are written in parallel.
    files: dict[str, str] = {}
    levels = write_order(planned)
    written = 0
    for level in levels:
        if _stopped(ctx):
            break
        names = ", ".join(f["path"] for f in level[:3])
        progress(input, f"Writing {names}{f' and {len(level) - 3} more' if len(level) > 3 else ''} ({written}/{len(planned)} done)…")

        async def write(f: dict) -> None:
            room = 18_000
            deps = []
            for u in (u for u in f["uses"] if u in files):
                room -= len(files[u])
                deps.append(f"~~~~file {u}\n{files[u]}\n~~~~" if room >= 0 else outline(u, files[u]))
            deps_text = "\n\n".join(deps) or "(none)"
            reply = await ask(FILE_SYSTEM, f"User's request: {request}\n\n{plan_text}\n\nFiles it uses (already written):\n{deps_text}"
                                           f"\n\nNow write: {f['path']}\nPurpose: {f['purpose']}\nIt must provide: {f['provides']}", 1500 if f["path"].endswith(".md") else 6000)
            body = extract_file(reply, f["path"]) if reply else None
            # An empty file is fine when the model meant it (a Python package's __init__.py).
            if body is not None:
                files[f["path"]] = body if body.endswith("\n") or not body else body + "\n"

        await asyncio.gather(*(write(f) for f in level))
        written += len(level)
    missing = [f["path"] for f in planned if f["path"] not in files]
    if not files:
        return no_model()

    progress(input, "Checking the project (syntax, imports, tests)…")
    report, repairs = await check_and_repair(input, ctx, files, f"User's request: {request}\n\n{plan_text}", deadline)

    folder = free_folder(root, plan["name"])
    project_files = [{"path": p, "content": c} for p, c in files.items()]
    checks = describe_check(report)
    action = proposed_action(f"Create the project \"{plan['name']}\" ({len(files)} files) in {folder}/", "medium",
                             preview=f"New folder: {folder}/\n\n{tree_text(project_files)}\n\nChecks: {checks}")
    patches.save_patch_set(action["id"], f"New project {plan['name']}", [{"file": patches.to_workspace_rel(ctx.get("workspace_root"), f"{folder}/{f['path']}"), "original": "", "fixed": f["content"], "isNew": True} for f in project_files])
    security = security_notes(files)
    tests = report["tests"]
    store.audit(input["runId"], "CodePilot", "build_project", {"name": plan["name"], "files": len(files), "problems": len(report["problems"]), "testsPassed": tests["passed"],
                                                               "testsFailed": tests["failed"], "repairs": repairs, "model": model_name()}, "completed")
    preview = inline_web_preview(project_files) if plan["language"] == "web" else None
    attachments = [{"type": "code-project", "title": plan["name"], "folder": folder, "files": [{**f, "language": lang(f["path"])} for f in project_files], "checks": checks, "run": plan["run"], "test": plan["test"]}]
    if preview:
        attachments.append({"type": "html-preview", "title": plan["name"], "html": preview})
    good = not report["problems"] and (not tests["ran"] or not tests["failed"])
    n_levels = len(levels)
    return result(
        "needs_approval" if good and not missing else "partial_success",
        [
            f"**{plan['name']}**: {plan['summary']}",
            f"{len(files)} files, written in {n_levels} dependency-ordered step{'' if n_levels == 1 else 's'}"
            + (f" and repaired {repairs} time{'' if repairs == 1 else 's'} after checking" if repairs else "") + f":\n~~~text\n{tree_text(project_files)}\n~~~",
            f"**Checks:** {checks}",
            f"**Run it:** `{plan['run']}`" + (f" · **Test it:** `{plan['test']}`" if plan["test"] else ""),
            f"Browse every file below{' and try the live preview' if preview else ''}. Approve to create it in your workspace at `{folder}/` (you can undo it).",
            *([f"These planned files couldn't be written: {', '.join(missing)}."] if missing else []),
            *([f"Security scan flagged: {'; '.join(security)}."] if security else []),
        ],
        evidence=[evidence(f"ai-model:{model_name()}", "Code written by the AI model."), *([evidence("project-tests", f"{tests['passed']} passed, {tests['failed']} failed")] if tests["ran"] else [])],
        confidence=(0.85 if tests["ran"] else 0.65) if good else 0.4,
        limitations=["The tests were written by the same AI, so passing them is strong but not complete evidence." if tests["ran"]
                     else "The project's tests weren't run automatically; run them yourself after creating it."],
        actions=[action],
        attachments=attachments,
    )


async def edit_project(input: dict, ctx: dict, project, budget_s: float = 330) -> dict:
    """Changes an existing project across files."""
    if not await llm.available():
        return no_model()
    deadline = time.monotonic() + budget_s
    root = ctx.get("workspace_root") or patches.workspace_root()
    progress(input, f"Reading {project.name}…")
    index = workspace_index(root)
    relevant = {h["file"] for h in index.search(input["requestText"], 20)}
    paths = sorted((f for f in project.files if not re.search(r"(^|/)(node_modules|dist|build|__pycache__)/", f)), key=lambda f: -(f in relevant))
    original: dict[str, str] = {}
    total = 0
    for p in paths:
        try:
            with open(os.path.join(root, p), encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        if total + len(text) > 90_000:
            continue
        original[p] = text
        total += len(text)
    rel = lambda p: posixpath.relpath(p, project.folder)
    # The AI sees an outline of every file and the full text only of the files it works on.
    outline_text = "\n".join(outline(rel(p), c) for p, c in original.items())

    def full_of(ps: list[str], cap: int) -> str:
        used, out = 0, []
        for p in ps:
            c = original.get(f"{project.folder}/{p}")
            if c is None or used + len(c) > cap:
                continue
            used += len(c)
            out.append(f"~~~~file {p}\n{c}\n~~~~")
        return "\n\n".join(out)

    most_relevant = [rel(p) for p in original][:3]
    progress(input, "Planning the change…")
    plan = await llm.generate_json(
        "Plan the change to this codebase: which files to modify or create (paths relative to the project folder) and exactly what changes in each. Include tests for new behaviour if the project has tests. Never delete files.",
        f"Request: {input['requestText']}\n\nProject {project.name}, outline of every file:\n{outline_text}\n\nThe most relevant files in full:\n{full_of(most_relevant, 14_000)}",
        schema=EDIT_PLAN_SCHEMA, temperature=0.2, max_tokens=2500, max_input=40_000, hard=True)
    if not isinstance(plan, dict) or not plan.get("changes"):
        return no_model()

    files = {rel(p): c for p, c in original.items()}
    failed_edits: list[str] = []
    progress(input, f"Changing {len(plan['changes'])} file(s)…")
    targets = [c for c in ({**c, "path": safe_rel(str(c.get("path") or "")) or ""} for c in plan["changes"]) if c["path"]][:12]
    plan_text = f"Plan: {plan['summary']}\n" + "\n".join(f"- {c['action']} {c['path']}: {c['what']}" for c in targets)

    async def change(c: dict) -> str | None:
        content = files.get(c["path"], "")
        related = [p for p in files if p != c["path"] and (posixpath.splitext(posixpath.basename(p))[0] in content or any(t["path"] == p for t in targets))]
        large = "This file is LARGE: reply with edit blocks." if len(content.split("\n")) > 250 else ""
        body = f"~~~~file {c['path']}\n{content}\n~~~~\n{large}" if content else "(new file)"
        return await ask(EDIT_SYSTEM, f"Request: {input['requestText']}\n\n{plan_text}\n\nProject outline:\n{outline_text}\n\nRelated files:\n{full_of(related, 12_000) or '(none)'}"
                                      f"\n\nNow {'create' if c['action'] == 'create' else 'change'} ONLY this file: {c['path']} -- {c['what']}\n{body}", 8000)

    replies = await asyncio.gather(*(change(c) for c in targets))
    for b in (b for r in replies if r for b in parse_blocks(r)):
        p = safe_rel(b["path"])
        if not p:
            continue
        if b["kind"] == "file":
            files[p] = b["body"] if b["body"].endswith("\n") else b["body"] + "\n"
        elif p in files:
            r = apply_edits(files[p], b["body"])
            files[p] = r["text"]
            failed_edits += [f"{p}: \"{f}\"" for f in r["failed"]]
    if not any(original.get(f"{project.folder}/{p}") != c for p, c in files.items()):
        return result("partial_success", ["The AI didn't produce a usable change for this request. Try describing the change more specifically (which feature, where)."], confidence=0.2)

    progress(input, "Checking the changed project…")
    report, repairs = await check_and_repair(input, ctx, files, f"Request: {input['requestText']}\nPlan: {plan['summary']}", deadline)

    changed = []
    for p, c in files.items():
        full = f"{project.folder}/{p}"
        before = original.get(full)
        if before == c:
            continue
        exists = os.path.exists(os.path.join(root, full))
        if before is None and exists:
            continue  # files outside what was read (too large) are never rewritten blind
        changed.append({"file": full, "original": before or "", "fixed": c, "isNew": before is None and not exists})
    diff = "\n\n".join(f"+++ new file {c['file']} ({len(c['fixed'].split(chr(10)))} lines)" if c["isNew"] else patches.unified_diff(c["file"], c["original"], c["fixed"]) for c in changed)
    action = proposed_action(f"Apply the change to {project.name}: {clip(plan['summary'], 120)} ({len(changed)} file{'' if len(changed) == 1 else 's'})", "medium", preview=diff[:12_000])
    patches.save_patch_set(action["id"], plan["summary"], [{**c, "file": patches.to_workspace_rel(ctx.get("workspace_root"), c["file"])} for c in changed])
    tests = report["tests"]
    store.audit(input["runId"], "CodePilot", "edit_project", {"project": project.folder, "files": len(changed), "problems": len(report["problems"]), "testsPassed": tests["passed"], "testsFailed": tests["failed"], "repairs": repairs}, "completed")
    good = not report["problems"] and (not tests["ran"] or not tests["failed"])
    return result(
        "needs_approval" if good else "partial_success",
        [
            f"**Change to {project.name}:** {plan['summary']}",
            "Files: " + ", ".join(f"`{c['file']}`" + (" (new)" if c["isNew"] else "") for c in changed) + (f". Repaired {repairs} time{'' if repairs == 1 else 's'} after checking." if repairs else "."),
            f"**Checks on the whole project with the change:** {describe_check(report)}",
            "Review the diff below; approving applies every file together (all or nothing), and you can undo it.",
            *([f"Some edits didn't match the files exactly and were skipped: {'; '.join(failed_edits[:4])}."] if failed_edits else []),
        ],
        evidence=[evidence(f"ai-model:{model_name()}", "Change written by the AI model.")],
        confidence=0.75 if good else 0.4,
        limitations=["The project is large; only the most relevant files were read."] if total >= 90_000 else [],
        actions=[action],
    )
