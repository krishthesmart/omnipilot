"""CodePilot's routes: the always-on code alerts, the "scan now" button, and the VS Code extension's scan and
assist endpoints (explain / fix / improve / write tests). For the person at this computer only, like the
TypeScript ones they replace (server/src/routes/code.ts)."""
from __future__ import annotations

import os
import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .. import llm, patches
from ..api_stage2 import body, err
from . import code_watch
from .agents.code_pilot import scan_source
from .project_check import check_project

ASSIST_SYSTEM = {
    "explain": "Explain this code clearly for a student: what it does overall, then the important parts step by step, and anything surprising or risky. Use short paragraphs and bullet points.",
    "fix": "Find and fix the bugs in this code (logic errors, crashes, edge cases, security problems). Keep the style, names and structure; change only what's needed.",
    "improve": "Improve this code: clearer names, simpler logic, better error handling and performance, same behaviour and public interface.",
    "tests": "Write thorough unit tests for this code using the language's standard test framework (unittest for Python, node:test for JavaScript/TypeScript). Cover normal cases, edge cases and errors.",
    "custom": "Change this code exactly as the user asks. Keep everything else the same.",
}
CODE_SCHEMA = {"type": "object", "properties": {"summary": {"type": "string"}, "code": {"type": "string"}}, "required": ["summary", "code"]}


def _text(b: dict, key: str, max_len: int, default: str | None = None, min_len: int = 0) -> str | None:
    v = b.get(key, default)
    if v is None:
        return None
    if not isinstance(v, str) or len(v) > max_len or len(v) < min_len:
        raise ValueError(key)
    return v


def register(app: FastAPI, allowed, denied) -> None:
    @app.get("/api/code/alerts")
    async def code_alerts(request: Request):
        if not await allowed(request):
            return denied()
        return {"level": code_watch.alert_level(), "alerts": code_watch.pending_alerts()}

    @app.post("/api/code/alerts/seen")
    async def code_alerts_seen(request: Request):
        if not await allowed(request):
            return denied()
        code_watch.mark_alerts_seen()
        return {"ok": True}

    @app.post("/api/code/scan")
    async def code_scan(request: Request):
        """The "run button": scan every code file now."""
        if not await allowed(request):
            return denied()
        return code_watch.scan_all(patches.workspace_root())

    @app.post("/api/code/scan-text")
    async def code_scan_text(request: Request):
        """Security scan of an editor's text (the extension shows the results in its Problems panel)."""
        if not await allowed(request):
            return denied()
        b = await body(request)
        try:
            file, content = _text(b or {}, "file", 300, "untitled"), _text(b or {}, "content", 200_000)
        except ValueError:
            return err(400, "invalid_request")
        if b is None or content is None:
            return err(400, "invalid_request")
        return {"findings": [{"line": f["line"], "severity": f["rule"]["severity"], "title": f["rule"]["title"], "fix": f["rule"]["fix"], "rule": f["rule"]["id"]} for f in scan_source(file, content)]}

    @app.post("/api/code/assist")
    async def code_assist(request: Request):
        """Explain / fix / improve / write tests for code from the editor. Code answers are checked before they're returned."""
        if not await allowed(request):
            return denied()
        b = await body(request)
        if b is None or b.get("mode") not in ASSIST_SYSTEM:
            return err(400, "invalid_request")
        try:
            mode = b["mode"]
            file, language = _text(b, "file", 300, "untitled"), _text(b, "language", 40, "")
            code = _text(b, "code", 60_000, min_len=1)
            context, instruction = _text(b, "context", 120_000), _text(b, "instruction", 2000)
        except ValueError:
            return err(400, "invalid_request")
        if code is None:
            return err(400, "invalid_request")
        if not await llm.available():
            return JSONResponse({"error": "ai_unavailable", "message": "No AI model is available: start Ollama with the local model, or add GROQ_API_KEY to server/.env."}, status_code=503)
        where = f"File: {file}" + (f" ({language})" if language else "")
        ctx_text = f"\n\nThe whole file, for context:\n~~~~\n{context[:60_000]}\n~~~~" if context and context != code else ""
        if mode == "explain":
            q = f"\nQuestion: {instruction}" if instruction else ""
            text = await llm.generate_text(ASSIST_SYSTEM["explain"], f"{where}{q}\n\n~~~~\n{code}\n~~~~{ctx_text}", max_tokens=2500, max_input=120_000, effort="medium")
            return {"text": text} if text else err(502, "no_answer", "The AI didn't answer. Try again.")
        req = f"\nRequest: {instruction}" if instruction else ""
        r = await llm.generate_json(f"{ASSIST_SYSTEM[mode]} Return the complete resulting code in `code` (for \"tests\", the complete test file) and a one-paragraph `summary` of what you changed or covered.",
                                    f"{where}{req}\n\n~~~~\n{code}\n~~~~{ctx_text}", schema=CODE_SCHEMA, max_tokens=9000, max_input=120_000, temperature=0.15)
        out = re.sub(r"^```[\w-]*\n|\n```\s*$", "", r["code"]) if isinstance(r, dict) and isinstance(r.get("code"), str) else ""
        if not out.strip():
            return err(502, "no_answer", "The AI didn't return code. Try again.")
        # Checks: the new code parses, and (for fixes/improvements) it adds no new kind of security issue.
        ext = os.path.splitext(file)[1] or (".py" if re.search(r"python", language, re.I) else ".ts" if re.search(r"typescript", language, re.I) else ".js")
        check = await check_project([{"path": f"snippet{ext}", "content": out}], run_tests=False)
        syntax = [f"line {p.get('line') or '?'}: {p['message']}" for p in check["problems"] if "Syntax" in p["message"]]
        before = {f["rule"]["id"] for f in scan_source(file, code)}
        new_issues = [] if mode == "tests" else [f"line {f['line']}: {f['rule']['title']}" for f in scan_source(file, out) if f["rule"]["id"] not in before]
        return {"code": out, "summary": str(r.get("summary") or "")[:1500], "checks": {"syntax": syntax, "newIssues": new_issues}}
