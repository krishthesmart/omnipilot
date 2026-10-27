"""CodePilot: writes code and checks it by running it (generate -> test -> repair -> resample), builds whole
projects and changes existing ones (project_builder), runs tests and commands (run_command), scans code for
security issues and offers fixes as diffs applied only when approved, and manages the always-on code alerts.
(Ported from server/src/agents/codePilot.ts.)"""
from __future__ import annotations

import asyncio
import os
import posixpath
import re

from ... import llm, patches, store
from .. import code_watch, sandbox
from ..specs import EDIT_PROJECT, REVIEW_INTENT
from .base import clip, evidence, model_limitation, previous_turn_text, prior_results, proposed_action, result
from .jsfmt import js_round
from .project_builder import build_project, edit_project, is_project_request, project_to_edit
from .run_command import run_command_skill

F = re.I | re.A
GENERATE_INTENT = re.compile("|".join([
    # "write a function", "make a webpage", "build me a calculator app"
    r"\b(write|create|generate|implement|build|make|code|program|develop|design)\b[^.?!]*\b(function|code|script|class|program|algorithm|snippet|regex|query|component|endpoint|app|application|web ?page|web ?site|site|page|html|css|calculator|game|tool|bot|api|server|cli|form|ui|landing page|dashboard|extension)s?\b",
    # "code a calculator", "code it", "can you code ..."
    r"(^|[.!?,]\s*|\b(you|please|can you|could you|now)\s+)code\s+(a|an|me|it|this|that|the|up)\b",
]), F)
WEB_PAGE = re.compile(r"\b(html|web ?page|web ?site|landing page|front[- ]?end|css|page with|browser game)\b", F)
FENCE = "```"

GENERATE_SYSTEM = (
    "You are CodePilot, a careful senior engineer. Write correct, secure, idiomatic code for the user's request. "
    "Use the language they asked for (default to Python if unstated). Handle edge cases, never hardcode secrets, never build SQL or shell commands by string concatenation. "
    "For a web page or anything that runs in a browser, write ONE complete, self-contained HTML file (inline <style> and <script>, no external files or libraries) that works when opened directly. "
    "Reply with one fenced code block followed by at most 3 short sentences of explanation."
)
GENERATE_EXAMPLE = {
    "user": "Write a python function that checks if a string is a palindrome",
    "assistant": "\n".join([
        f"{FENCE}python",
        "def is_palindrome(text: str) -> bool:",
        '    """Return True if text reads the same forwards and backwards, ignoring case and non-alphanumerics."""',
        "    cleaned = [c.lower() for c in text if c.isalnum()]",
        "    return cleaned == cleaned[::-1]",
        FENCE,
        'Non-alphanumeric characters and case are ignored, so "A man, a plan, a canal: Panama" counts as a palindrome. An empty string is a palindrome.',
    ]),
}
TESTS_SCHEMA = {"type": "object", "properties": {"tests": {"type": "array", "items": {"type": "string"}, "minItems": 3, "maxItems": 5}}, "required": ["tests"]}


def tests_system(lang: str) -> str:
    example = 'is_palindrome("racecar") == True' if lang == "python" else 'isPalindrome("racecar") === true'
    return (f"You write unit tests. Given {lang} code, return test expressions: each is ONE {lang} boolean expression that calls the code with literal inputs and is true when the code is correct "
            f"(e.g. {example}). Cover normal cases and at least one edge case. No print statements, no imports.")


REPAIR_SYSTEM = ("You are CodePilot fixing your own code. The code below failed when run. Find the bug and return the corrected code as one fenced code block. "
                 "Keep the same function names and signatures. If a test is clearly wrong rather than the code, keep the code correct anyway.")

NO_MODEL = ("Code generation needs an AI model, and none answered: start Ollama with the local model (or add GROQ_API_KEY to server/.env), then try again, "
            "or paste existing code for a security scan.")


def pasted_code(text: str) -> str | None:
    """Code pasted into the message: a fenced block, or what follows a colon when it looks like code."""
    fenced = re.search(r"```[\w+-]*\n?([\s\S]*?)```", text, re.A)
    if fenced and fenced.group(1).strip():
        return fenced.group(1).strip()
    after = text[text.find(":") + 1:].strip()
    if ":" in text and len(after) > 12 and re.search(r"[;{}()=]", after) and re.search(r"\b(const|let|var|function|def|import|return|select|insert|eval|exec|query|class|if|for)\b|=>|\$\{", after, F):
        return after
    return None


def extract_code_block(text: str) -> tuple[str, str]:
    m = re.search(r"```([\w+-]*)\n([\s\S]*?)```", text, re.A)
    return (m.group(1), m.group(2).strip()) if m else ("", text.strip())


def fenced_code(text: str) -> str | None:
    """Only an actual fenced block (a repair that replies in prose isn't code)."""
    m = re.search(r"```[\w+-]*\n([\s\S]*?)```", text, re.A)
    return m.group(1).strip() if m and m.group(1).strip() else None


def prose_outside_fence(text: str) -> str:
    return re.sub(r"```[\w+-]*\n[\s\S]*?```", "", text, flags=re.A).strip()


def defined_names(lang: str, code: str) -> list[str]:
    """Top-level functions/classes the code defines: the names tests may call."""
    if lang == "python":
        return [m.group(1) for m in re.finditer(r"^(?:def|class)\s+([A-Za-z_]\w*)", code, re.M | re.A)]
    rx = re.compile(r"^(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)|class\s+([A-Za-z_$][\w$]*))", re.M | re.A)
    return [n for m in rx.finditer(code) if (n := m.group(1) or m.group(2) or m.group(3))]


def edit_distance(a: str, b: str) -> int:
    """For repairing near-miss names (small models "autocorrect" nth_prime to ninth_prime)."""
    dp = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev, dp[0] = dp[0], i
        for j in range(1, len(b) + 1):
            tmp = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + (0 if a[i - 1] == b[j - 1] else 1))
            prev = tmp
    return dp[len(b)]


def normalize_test(test: str, defined: list[str]) -> str | None:
    """Rewrites calls to undefined names within 2 edits of a defined one; drops tests that call nothing defined."""
    def fix(m: re.Match) -> str:
        name = m.group(1)
        if name in defined:
            return m.group(0)
        near = next((d for d in defined if edit_distance(d, name) <= 2), None)
        return m.group(0).replace(name, near, 1) if near else m.group(0)

    fixed = re.sub(r"\b([A-Za-z_$][\w$]*)\s*\(", fix, test, flags=re.A)
    return fixed if any(re.search(rf"\b{re.escape(n)}\s*\(", fixed, re.A) for n in defined) else None


async def generate_tests(lang: str, code: str, defined: list[str]) -> list[str]:
    """Self-consistent tests: three samples at different temperatures; tests most samples agree on are kept
    (a sample that misremembers expected values is outvoted); if too few agree, the de-duplicated union."""
    if not defined:
        return []
    prompt = f"{FENCE}{lang}\n{code}\n{FENCE}\n\nCall these exact names: {', '.join(defined)}"
    samples = await asyncio.gather(*(llm.generate_json(tests_system(lang), prompt, schema=TESTS_SCHEMA, temperature=t, max_tokens=300) for t in (0.1, 0.5, 0.8)))
    norm = lambda t: re.sub(r"\s+", "", t).replace("'", '"')
    counts: dict[str, dict] = {}
    for sample in samples:
        seen = set()
        raws = sample.get("tests") if isinstance(sample, dict) else None
        for raw in raws if isinstance(raws, list) else []:
            if not isinstance(raw, str) or not raw.strip() or "\n" in raw or sandbox.refusal_reason(lang, raw):
                continue
            if not re.search(r"==|!=|<|>|\bnot\b|\bis\b|\bin\b|!", raw):  # a bare predicate call doesn't say what it expects
                continue
            test = normalize_test(raw.strip(), defined)
            if not test or norm(test) in seen:
                continue
            seen.add(norm(test))
            counts.setdefault(norm(test), {"test": test, "n": 0})["n"] += 1
    entries = list(counts.values())
    agreed = [e["test"] for e in entries if e["n"] >= 2]
    return (agreed if len(agreed) >= 2 else [e["test"] for e in sorted(entries, key=lambda e: -e["n"])])[:6]


async def verify_code(lang: str | None, code: str, prose: str, regenerate) -> dict:
    """Generate -> test -> repair -> resample: runs the code against model-written tests in the sandbox; on
    failure feeds the failures back for up to two repairs, then samples up to two fresh solutions and keeps
    whichever passes the most tests. Execution feedback is the biggest quality lever for a small model."""
    base = {"code": code, "prose": prose, "repairs": 0}
    if not lang:
        return {**base, "status": "not_run", "detail": "Not executed: only Python and JavaScript can be run."}
    if not sandbox.enabled():
        return {**base, "status": "not_run", "detail": "Not executed: code execution is disabled (CODE_VERIFY=off)."}
    refusal = sandbox.refusal_reason(lang, code)
    if refusal:
        return {**base, "status": "not_run", "detail": f"Not executed: the code {refusal}."}

    defined = defined_names(lang, code)
    tests = await generate_tests(lang, code, defined)
    if not tests:
        run = await sandbox.run_sandboxed(lang, code)
        return ({**base, "status": "passed", "detail": "Verified: the code runs without errors (no usable tests could be generated)."} if run["ok"]
                else {**base, "status": "failed", "detail": f"The code failed to run:\n{FENCE}\n{run['output']}\n{FENCE}"})

    best = {"code": code, "prose": prose, "report": await sandbox.run_tests(lang, code, tests)}
    repairs = 0
    while best["report"]["passed"] < len(tests) and repairs < 2:
        repairs += 1
        problem = "\n".join(best["report"]["failures"]) if best["report"]["ran"] else best["report"]["output"]
        repaired = await llm.generate_text(REPAIR_SYSTEM, f"{FENCE}{lang}\n{best['code']}\n{FENCE}\n\nTests:\n" + "\n".join(tests) + f"\n\nFailures:\n{problem}", temperature=0.2, max_tokens=700)
        nxt = fenced_code(repaired) if repaired else None
        if not nxt or sandbox.refusal_reason(lang, nxt):
            continue
        report = await sandbox.run_tests(lang, nxt, tests)
        if report["passed"] > best["report"]["passed"]:
            best = {"code": nxt, "prose": best["prose"], "report": report}

    # Best-of-N: small models fix their own bugs poorly but often get it right on a fresh try.
    resamples = 0
    while best["report"]["passed"] < len(tests) and resamples < 2:
        resamples += 1
        fresh = await regenerate()
        nxt = fenced_code(fresh) if fresh else None
        if not nxt or sandbox.refusal_reason(lang, nxt) or not all(n in defined_names(lang, nxt) for n in defined):
            continue
        report = await sandbox.run_tests(lang, nxt, tests)
        if report["passed"] > best["report"]["passed"]:
            best = {"code": nxt, "prose": prose_outside_fence(fresh), "report": report}
    repairs += resamples

    report, n = best["report"], len(tests)
    out = {"code": best["code"], "prose": best["prose"], "repairs": repairs}
    test_list = ", ".join(f"`{t}`" for t in tests)
    if report["passed"] == n:
        return {**out, "status": "passed", "detail": f"Verified: ran {n} tests ({test_list}) and all passed{f' (after {repairs} repair/resample attempt(s))' if repairs else ''}."}
    if not report["ran"]:
        tail = "\n".join(report["output"].split("\n")[-8:])
        return {**out, "status": "failed", "detail": f"The code failed to run:\n{FENCE}\n{tail}\n{FENCE}"}
    # Mostly passing: the failing test is as likely to be wrong as the code (both come from the same small model).
    fails = "; ".join(f"`{f}`" for f in report["failures"])
    return {**out, "status": "passed" if report["passed"] >= n / 2 else "failed",
            "detail": f"Ran {n} tests: {report['passed']} passed, {len(report['failures'])} failed -- {fails}. A failing test may itself be wrong; check that case by hand."}


def _rule(id, severity, confidence, pattern, flags, title, fix):
    return {"id": id, "severity": severity, "confidence": confidence, "pattern": re.compile(pattern, flags | re.A), "title": title, "fix": fix}


RULES = [
    _rule("sql-injection", "critical", 0.9, r"(\"|')\s*\+\s*\w+.*\b(SELECT|INSERT|UPDATE|DELETE)\b|\b(SELECT|INSERT|UPDATE|DELETE)\b[^\n]*\+\s*\w+", re.I,
          "Possible SQL injection via string concatenation",
          "Use parameterized queries / a query builder (e.g. `db.query('... WHERE id = ?', [id])`) instead of concatenating user input into SQL."),
    _rule("command-injection", "critical", 0.85, r"\bexec(Sync)?\s*\(\s*([\"'`][^\"'`]*[\"'`]\s*\+|`[^`]*\$\{)", 0,
          "Possible command injection via child_process.exec with concatenated input",
          "Use `execFile`/`spawn` with an argument array instead of a shell string, and validate/allowlist any user-supplied values."),
    # A literal key assigned directly, kept as a fallback (process.env.API_KEY || "sk-..."), or as a default (os.getenv("API_KEY", "sk-...")).
    _rule("hardcoded-secret", "high", 0.75,
          r"\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*(?:[^\n;]*?(?:\|\||\?\?|\bor\b)\s*)?[\"'`][A-Za-z0-9_\-\.]{8,}[\"'`]"
          r"|\b(getenv|environ\.get|env\.get)\(\s*[\"'][A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*[\"']\s*,\s*[\"'][A-Za-z0-9_\-\.]{8,}[\"']", re.I,
          "Hardcoded credential-looking literal", "Move the value to an environment variable / secrets manager and rotate the exposed credential."),
    _rule("xss-unescaped-response", "high", 0.7, r"res\.send\(\s*[\"'`][^)]*\+\s*\w+", 0,
          "Possible reflected XSS: unescaped input concatenated into an HTML response",
          "Escape the value (e.g. a templating engine with auto-escaping, or a library such as `escape-html`) before writing it into HTML."),
    _rule("insecure-cookie", "medium", 0.65, r"\.cookie\([^)]*httpOnly\s*:\s*false", 0,
          "Session cookie set without httpOnly", "Set `httpOnly: true` (and `secure: true`, `sameSite: 'lax'` or stricter) on session cookies to reduce XSS-driven session theft."),
    _rule("eval-usage", "high", 0.8, r"\beval\s*\(", 0, "Use of eval()", "Avoid `eval`; parse/validate structured input instead, or use a safe expression evaluator."),
    _rule("unhandled-error-throw", "low", 0.5, r"if\s*\(\s*err\s*\)\s*throw\s+err", 0,
          "Database/callback error rethrown without handling",
          "Handle the error explicitly (log + return a safe response) instead of throwing inside an async callback, which can crash the process."),
]
SEVERITY_RANK = code_watch.SEVERITY_RANK
CODE_EXTS = {".js", ".ts", ".jsx", ".tsx", ".py", ".go"}


def scan_source(file: str, content: str) -> list[dict]:
    found = []
    for idx, line in enumerate(content.split("\n")):
        for rule in RULES:
            if rule["pattern"].search(line):
                found.append({"file": file, "line": idx + 1, "rule": rule, "snippet": line.strip()[:240]})
    return found


def list_code_files(root: str) -> list[str]:
    if not os.path.exists(root):
        return []
    out, stack = [], [root]
    while stack:
        d = stack.pop()
        for e in os.scandir(d):
            if e.is_dir():
                stack.append(e.path)
            elif os.path.splitext(e.name)[1] in CODE_EXTS:
                out.append(e.path)
    return out


def scan_files(files: list[str], root: str) -> list[dict]:
    """Scans files on disk (run in a worker thread, so a big workspace doesn't hold up the server)."""
    found = []
    for f in files:
        with open(f, encoding="utf-8", errors="replace") as fh:
            found += scan_source(os.path.relpath(f, root), fh.read())
    return found


FIX_SYSTEM = ("You fix security issues in a source file. Fix ONLY the listed issues, the safest standard way (parameterized queries, escaping output, secrets from environment variables, httpOnly/secure cookies, handled errors). "
              "Keep everything else exactly the same: names, structure, formatting and comments. Return the complete fixed file in `code` and a one-sentence `summary` of what changed.")
FIX_SCHEMA = {"type": "object", "properties": {"summary": {"type": "string"}, "code": {"type": "string"}}, "required": ["summary", "code"]}


async def write_fix(file: str, issues: list[dict], root: str) -> dict | None:
    """A fix for one workspace file, if the model's version really removes issues and adds none."""
    target = patches.safe_workspace_path(root, file)
    if not target:
        return None
    with open(target, encoding="utf-8", errors="replace") as fh:
        original = fh.read()
    if len(original.encode()) > patches.MAX_PATCH_FILE_BYTES:
        return None
    listing = "\n".join(f"- line {i['line']}: {i['rule']['title']} ({i['rule']['severity']}). Fix: {i['rule']['fix']}" for i in issues)
    r = await llm.generate_json(FIX_SYSTEM, f"File: {file}\nIssues:\n{listing}\n\n{FENCE}\n{original}\n{FENCE}", schema=FIX_SCHEMA, temperature=0.1,
                                max_tokens=min(6000, 600 + -(-len(original) * 2 // 5)), max_input=60_000)
    code = re.sub(r"^```[\w-]*\n|\n```\s*$", "", r["code"]) if isinstance(r, dict) and isinstance(r.get("code"), str) else ""
    if not code.strip() or code == original or len(code) < len(original) * 0.5 or len(code) > len(original) * 2.5:
        return None
    # Check the fix with the same scanner: fewer issues, and no kind of issue that wasn't there before.
    after = scan_source(file, code)
    before_rules = {i["rule"]["id"] for i in issues}
    if len(after) >= len(issues) or any(f["rule"]["id"] not in before_rules for f in after):
        return None
    fixed = code if code.endswith("\n") or not original.endswith("\n") else code + "\n"
    return {"original": original, "code": fixed, "summary": clip(r.get("summary", ""), 200), "diff": patches.unified_diff(file, original, code), "before": len(issues), "resolved": len(issues) - len(after)}


async def write_fixes(findings: list[dict], root: str, ctx: dict) -> dict[str, dict | None]:
    """Fixes for up to three workspace files with issues."""
    by_file: dict[str, list[dict]] = {}
    for f in findings:
        if not f["file"].startswith("<"):
            by_file.setdefault(f["file"], []).append(f)
    out = {}
    for file, issues in list(by_file.items())[:3]:
        stop = ctx.get("stop")
        if stop is not None and stop.is_set():
            break
        out[file] = await write_fix(file, issues, root)
    return out


def helper_files(input: dict, root: str) -> list[str]:
    """Code files inside the workspace that an upstream Helper result pointed at (evidence sources are "file:line")."""
    root = os.path.abspath(root)
    files: dict[str, None] = {}
    for prior in (p for p in prior_results(input) if p.get("agent") == "Helper"):
        for ev in prior.get("evidence") or []:
            full = os.path.abspath(os.path.join(root, re.sub(r":\d+$", "", ev.get("source", ""))))
            if full.startswith(root + os.sep) and os.path.splitext(full)[1] in CODE_EXTS and os.path.exists(full):
                files[full] = None
    return list(files)


ALERT_SETTINGS = re.compile(
    r"\b(code |security |codepilot )?alerts?\b[^.?!]*\b(only|off|on|stop|settings?|level|critical|high|medium|low|every|all)\b"
    r"|\b(turn (off|on)|stop|mute|pause|resume)\b[^.?!]*\b(code |security )?alerts?\b|\balert me\b", F)


def alert_settings(input: dict) -> dict:
    t = input["requestText"].lower()
    current = code_watch.alert_level()
    level = current
    turn_on = bool(re.search(r"\b(turn|switch)\b[^.?!]*\bon\b|\b(resume|enable|unmute|start)\b", t, re.A))
    if not turn_on and re.search(r"\b(turn|switch)\b[^.?!]*\boff\b|\b(stop|mute|pause|disable|silence)\b|\bno (code )?alerts\b", t, re.A):
        level = "off"
    elif re.search(r"\bcritical\b", t) and not re.search(r"\bhigh\b", t):
        level = "critical"
    elif re.search(r"\bhigh\b", t):
        level = "high"
    elif re.search(r"\bmedium\b", t):
        level = "medium"
    elif re.search(r"\b(low|every|all|any)\b", t):
        level = "low"
    elif turn_on and level == "off":
        level = "medium"
    changed = level != current
    if changed:
        code_watch.set_alert_level(level)
    store.audit(input["runId"], "CodePilot", "alert_settings", {"level": level}, "changed" if changed else "unchanged")
    describe = "off" if level == "off" else "on for every new issue" if level == "low" else f"on for {'critical' if level == 'critical' else f'{level} and more serious'} issues"
    waiting = len(code_watch.pending_alerts())
    text = (f"Code alerts are {describe}. CodePilot watches your workspace's code folder and checks a file as soon as it changes; new issues show up in the sidebar"
            f"{' (when alerts are on)' if level == 'off' else ''}. {f'There are {waiting} new issue(s) waiting.' if waiting else ''}").strip()
    return result("success", [text], evidence=[evidence("codepilot-watch", f"alert level: {level}")], confidence=0.95)


def locations(group: list[dict]) -> str:
    return ", ".join(f"{g['file']}:{g['line']}" for g in group)


def model_name() -> str:
    return (llm.last_answer.get() or {}).get("model") or llm.local_model()


CHANGE_VERB = re.compile(r"\b(fix|change|update|add|implement|refactor|rename|improve|correct|repair|edit|modify|rewrite|extend)\b", re.I)
SECURITY_REVIEW = re.compile(r"\b(scan|audit|review|security|vulnerab\w*|secrets?)\b", re.I)


def project_folder_edit(text: str, root: str):
    """A request, inside a project, to change that project's own files: the project folder is the codebase to edit.
    Security reviews keep going to the scanner."""
    from ..files import Project

    if not CHANGE_VERB.search(text) or SECURITY_REVIEW.search(text) or not os.path.isdir(root):
        return None
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in ("node_modules", "__pycache__", "dist", "build")]
        for fn in filenames:
            if not fn.startswith(".") and not os.path.islink(os.path.join(dirpath, fn)):
                files.append(os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/"))
    named = [f for f in files if re.search(rf"(?<![\w/.-]){re.escape(f)}(?![\w-])", text) or re.search(rf"(?<![\w/.-]){re.escape(posixpath.basename(f))}(?![\w-])", text)]
    if not named and not EDIT_PROJECT.search(text):
        return None
    from ... import projects

    scope = projects.current.get() or {}
    return Project(folder=".", name=scope.get("name") or "this project", description="", files=[f"./{f}" for f in files[:400]])


async def run(input: dict, ctx: dict) -> dict:
    text = input["requestText"]
    context = input.get("context") or {}
    root = ctx.get("workspace_root") or patches.workspace_root()
    if ALERT_SETTINGS.search(text):
        return alert_settings(input)

    explicit_code = context["code"] if isinstance(context.get("code"), str) else pasted_code(text)
    wants_learn_mode = bool(re.search(r"learn mode", text, re.I)) or context.get("learnMode") is True

    # Running tests or a command (here when safe, otherwise in an E2B cloud sandbox).
    ran = await run_command_skill(input, ctx)
    if ran:
        return ran

    # Inside a project: a change to the project's own files is planned and proposed across them, for approval.
    # (A short expression in the request, like an acceptance check "add(2, 3) == 5", isn't code to scan.)
    if ctx.get("project_id") and not isinstance(context.get("code"), str):
        own = project_folder_edit(text, root)
        if own:
            return await edit_project(input, ctx, own)

    # Large-scale work: a change across an existing project, or a whole new multi-file project.
    if not explicit_code and not REVIEW_INTENT.search(text):
        project = project_to_edit(text, root)
        if project:
            return await edit_project(input, ctx, project)
        if is_project_request(text):
            return await build_project(input, ctx)

    if not explicit_code and GENERATE_INTENT.search(text) and not REVIEW_INTENT.search(text):
        prompt = text + previous_turn_text(input)
        max_tokens = 2200 if WEB_PAGE.search(text) else 900  # a whole web page is much longer than a function
        generated = await llm.generate_text(GENERATE_SYSTEM, prompt, examples=[GENERATE_EXAMPLE], max_tokens=max_tokens, temperature=0.2)
        if generated:
            tag, code = extract_code_block(generated)
            lang = sandbox.language(tag, text)
            regenerate = lambda: llm.generate_text(GENERATE_SYSTEM, prompt, examples=[GENERATE_EXAMPLE], max_tokens=max_tokens, temperature=0.8)
            v = await verify_code(lang, code, prose_outside_fence(generated), regenerate)
            issues = scan_source("<generated code>", v["code"])
            store.audit(input["runId"], "CodePilot", "generate_code", {"model": model_name(), "language": lang, "verification": v["status"], "repairs": v["repairs"], "scanIssues": len(issues)}, "completed")
            prose = v["prose"]
            # A finished HTML page gets a live preview (shown in a sandboxed frame in the app).
            html = v["code"] if re.fullmatch(r"html?", tag, re.I) or re.search(r"^\s*<!doctype html|^\s*<html[\s>]", v["code"], re.I) else None
            passed = v["status"] == "passed"
            return result(
                "partial_success" if issues or v["status"] == "failed" else "success",
                [
                    f"{FENCE}{tag or lang or ''}\n{v['code']}\n{FENCE}" + (f"\n\n{prose}" if prose else ""),
                    v["detail"],
                    f"Security scan flagged {len(issues)} issue(s): " + "; ".join(f"{i['rule']['title']} (line {i['line']})" for i in issues) + ". Review before using."
                    if issues else f"Security scan: passed ({len(RULES)} rules).",
                ],
                evidence=[evidence(f"ai-model:{model_name()}", "Code written by the AI model."), *([evidence("sandbox-run", v["detail"])] if passed else [])],
                confidence=0.8 if passed and not issues else 0.35 if v["status"] == "failed" else 0.55,
                limitations=[
                    model_limitation(),
                    "Tests were written by the same model, so passing them is strong but not complete evidence of correctness." if passed
                    else "The page wasn't run automatically; try it in the preview, or save it as an .html file and open it." if html
                    else "The code was not fully verified by execution; test it before relying on it.",
                ],
                attachments=[{"type": "html-preview", "title": text[:80], "html": html}] if html else None,
            )
        store.audit(input["runId"], "CodePilot", "generate_code", {"model": model_name()}, "local_model_unavailable")
        return result("partial_success", [NO_MODEL], confidence=0.1, limitations=["Without the AI model CodePilot can only scan existing code; it does not write new code."])

    # Neither "write" nor "review": CodePilot has no code task here (e.g. "explain how it works"). It passes
    # along the code from the previous turn, if any, for the agent that's teaching it.
    original = context.get("originalRequest") if isinstance(context.get("originalRequest"), str) else ""
    if not explicit_code and not REVIEW_INTENT.search(f"{text}\n{original}") and not prior_results(input):
        prev = context.get("previousTurn") or {}
        m = re.search(r"```[\w+-]*\n[\s\S]*?```", prev.get("answer") or "", re.A) if isinstance(prev, dict) else None
        earlier = m.group(0) if m else None
        store.audit(input["runId"], "CodePilot", "no_code_task", {"passedEarlierCode": bool(earlier)}, "skipped_scan")
        return {**result("success", [f"Code from earlier in the conversation:\n{earlier}" if earlier else "No code to write or review in this request."], confidence=0.5), "role": "support"}

    findings: list[dict] = []
    if explicit_code:
        findings = scan_source("<submitted snippet>", explicit_code)
        scanned = "the submitted code snippet"
        store.audit(input["runId"], "CodePilot", "scan_code", {"source": "inline_snippet", "chars": len(explicit_code)}, "completed")
    elif helper_files(input, root):
        # Helper ran first and located relevant code files: scan exactly those.
        files = helper_files(input, root)
        findings += await asyncio.to_thread(scan_files, files, root)
        scanned = f"{len(files)} code file(s) Helper located ({', '.join(os.path.relpath(f, root) for f in files)})"
        store.audit(input["runId"], "CodePilot", "scan_code", {"source": "helper_results", "filesScanned": len(files)}, "completed")
    else:
        files = await asyncio.to_thread(list_code_files, os.path.join(root, "code"))
        findings += await asyncio.to_thread(scan_files, files, root)
        scanned = f"{len(files)} approved code file(s) in the workspace"
        store.audit(input["runId"], "CodePilot", "scan_code", {"source": "workspace", "filesScanned": len(files)}, "completed")

    if not findings:
        return result("success", [f"Scanned {scanned}; no issues matched the supported rule set ({len(RULES)} rules)."], confidence=0.5,
                      limitations=["Static scan only covers a fixed rule set (injection, secrets, XSS, eval, cookie flags); it is not a full SAST tool."])

    findings.sort(key=lambda f: -SEVERITY_RANK[f["rule"]["severity"]])
    by_rule: dict[str, list[dict]] = {}
    for f in findings:
        by_rule.setdefault(f["rule"]["id"], []).append(f)
    out = [f"Scanned {scanned} and found {len(findings)} issue(s) across {len(by_rule)} rule(s)."]
    actions = []
    for group in by_rule.values():
        rule = group[0]["rule"]
        out.append(f"[{rule['severity'].upper()}] {rule['title']} — found at {locations(group)}. Suggested fix: {rule['fix']}")

    # Ready-to-apply fixes for workspace files: written by the AI model, kept only if a rescan shows fewer issues
    # and no new kinds, shown as a diff, and applied to the file only when approved.
    fixed = {} if explicit_code else await write_fixes(findings, root, ctx)
    for file, fix in fixed.items():
        if not fix:
            continue
        worst = any(f["file"] == file and f["rule"]["severity"] in ("critical", "high") for f in findings)
        action = proposed_action(f"Apply CodePilot's fix to {file}: {fix['summary']}", "high" if worst else "medium", preview=fix["diff"][:8000])
        patches.save_patch(action["id"], patches.to_workspace_rel(ctx.get("workspace_root"), file), fix["original"], fix["code"], fix["summary"])
        actions.append(action)
        out.append(f"**Fix ready for {file}** (resolves {fix['resolved']} of {fix['before']} issue{'' if fix['before'] == 1 else 's'}): review the change below and approve it to update the file. You can undo it afterwards.")
    # Issues without a ready fix are still listed as to-dos for the user (no approval button).
    for group in by_rule.values():
        rule = group[0]["rule"]
        still = [g for g in group if not fixed.get(g["file"])]
        if still:
            actions.append(proposed_action(f"Fix \"{rule['title']}\" at {locations(still)}",
                                           "high" if rule["severity"] in ("critical", "high") else "medium", False))
    if fixed:
        store.audit(input["runId"], "CodePilot", "write_fixes", {"files": list(fixed), "ready": sum(1 for v in fixed.values() if v)}, "completed")
    if wants_learn_mode:
        out.append("Learn Mode: each finding above is a teachable pattern — ask me to walk through why a specific rule fires and how the fix prevents it, and I will explain it step by step.")

    avg = sum(f["rule"]["confidence"] for f in findings) / len(findings)
    return result(
        "success", out,
        evidence=[evidence(f"{f['file']}:{f['line']}", f"[{f['rule']['id']}] {f['snippet']}") for f in findings],
        confidence=js_round(avg * 100) / 100,
        limitations=["Static, regex/pattern-based scan only — not a full compiler-aware SAST tool and cannot prove the absence of other issues.",
                     "Confidence reflects pattern-match certainty, not a guarantee of exploitability in this specific runtime."],
        actions=actions,
    )
