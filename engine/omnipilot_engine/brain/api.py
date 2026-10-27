"""Routes for runs, answered by the Python engine (stage 3): chat, runs and their live event stream (plus a
JSON polling fallback for connections that can't stream), Stop, feedback, CodePilot's preview pages,
conversations, the one-shot /api/ask, workspace projects, attachment parsing, and the internal endpoints
the TypeScript engine calls. Responses match the TypeScript ones, so the web app and SDKs work unchanged.

SDK clients (API-token holders) are a different party from the person at this computer: they may read only
runs they started (proved by the run's key, sent as x-run-key), and their conversations are kept apart."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse

from .. import patches, store
from ..api_stage2 import body, err
from ..security import token_matches
from ..tools.base import ToolError
from . import control, conversation, learning, pipeline
from .events import TERMINAL, bus
from .files import workspace_index

PREVIEW_CSP = "sandbox allow-scripts allow-forms allow-modals; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
RESERVED_CONTEXT = {"customAgent", "previousTurn", "conversationHistory", "project", "originalRequest", "attachedFile", "priorResults", "conversationId"}
_tasks: set[asyncio.Task] = set()


def enabled() -> bool:
    return os.environ.get("OMNIPILOT_RUNS", "python") != "node"


def grant_run_key(run_id: str) -> str:
    key = secrets.token_urlsafe(24)
    store.x("INSERT OR REPLACE INTO run_access (run_id, key_hash, created_at) VALUES (?, ?, ?)", run_id, hashlib.sha256(key.encode()).hexdigest(), store.now())
    return key


def run_key_matches(run_id: str, key: str | None) -> bool:
    row = store.q1("SELECT key_hash FROM run_access WHERE run_id = ?", run_id)
    return bool(key and row) and hmac.compare_digest(row["key_hash"], hashlib.sha256(key.encode()).hexdigest())


def _keep(task: asyncio.Task) -> None:
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


def register(app: FastAPI, allowed, denied, settings, internal) -> None:
    def sdk(request: Request) -> bool:
        return token_matches(request.headers.get("authorization"), settings.api_token) is True

    async def who(request: Request) -> str | None:
        """'sdk', 'owner', or None (not allowed)."""
        if sdk(request):
            return "sdk"
        return "owner" if await allowed(request) else None

    def sdk_conversation(cid: str | None) -> str | None:
        return f"sdk:{cid}" if cid else None

    def sdk_may_read(request: Request, run_id: str) -> bool:
        return run_key_matches(run_id, request.headers.get("x-run-key"))

    async def parse_chat(request: Request) -> tuple[dict | None, JSONResponse | None]:
        b = await body(request)
        msg = (b or {}).get("message")
        if b is None or not isinstance(msg, str) or not 1 <= len(msg) <= 4000:
            return None, err(400, "invalid_request")
        cid = b.get("conversationId")
        if cid is not None and (not isinstance(cid, str) or not 1 <= len(cid) <= 100):
            return None, err(400, "invalid_request")
        ctx = b.get("context") or {}
        if not isinstance(ctx, dict):
            return None, err(400, "invalid_request")
        ctx = {k: v for k, v in ctx.items() if k not in RESERVED_CONTEXT}
        att = b.get("attachment")
        if att is not None:
            if not (isinstance(att, dict) and isinstance(att.get("name"), str) and isinstance(att.get("text"), str) and 1 <= len(att["name"]) <= 120 and 1 <= len(att["text"]) <= 60_000):
                return None, err(400, "invalid_request")
            ctx["attachedFile"] = {"name": att["name"], "text": att["text"]}
        return {"message": msg, "conversationId": cid, "context": ctx, "textOnly": bool(b.get("textOnly"))}, None

    @app.post("/api/chat")
    async def chat(request: Request):
        role = await who(request)
        if not role:
            return denied()
        p, bad = await parse_chat(request)
        if bad:
            return bad
        cid = sdk_conversation(p["conversationId"]) if role == "sdk" else p["conversationId"]
        run_id, task = pipeline.start(p["message"], p["context"], None, cid)
        _keep(task)
        return JSONResponse({"runId": run_id, "runKey": grant_run_key(run_id)} if role == "sdk" else {"runId": run_id}, status_code=202)

    @app.post("/api/ask")
    async def ask(request: Request):
        role = await who(request)
        if not role:
            return denied()
        p, bad = await parse_chat(request)
        if bad:
            return bad
        cid = sdk_conversation(p["conversationId"]) if role == "sdk" else p["conversationId"]
        import uuid

        run_id = str(uuid.uuid4())
        key = grant_run_key(run_id) if role == "sdk" else None
        rec = await pipeline.execute_run(p["message"], {}, run_id, cid)
        final = rec.get("finalResponse") or {}
        q = (rec.get("review") or {}).get("clarifyingQuestion")
        out = {"runId": run_id, **({"runKey": key} if key else {}), "status": rec["status"], "answer": final.get("summary") or q or "",
               "confidence": final.get("confidence", 0), "agents": [{"agent": r["agent"], "status": r["status"]} for r in rec.get("agentResults") or []],
               "limitations": final.get("limitations", [])}
        if rec["status"] == "needs_clarification":
            out["clarifyingQuestion"] = q
        if not p["textOnly"]:
            out["attachments"] = final.get("attachments", [])
        return out

    @app.get("/api/runs")
    async def runs(request: Request):
        role = await who(request)
        if role != "owner":
            return err(403, "forbidden_for_token") if role else denied()
        return {"runs": store.list_runs()}

    @app.get("/api/runs/{id}")
    async def run_get(id: str, request: Request):
        role = await who(request)
        if not role:
            return denied()
        if role == "sdk" and not sdk_may_read(request, id):
            return err(404, "not_found")
        run = store.get_run(id)
        return run["data"] if run else err(404, "not_found")

    def history(id: str) -> list[dict] | None:
        ev = bus.get_history(id)
        if ev:
            return ev
        saved = store.get_run(id)
        return pipeline.replay_events(saved["data"]) if saved else None

    @app.get("/api/runs/{id}/events.json")
    async def events_json(id: str, request: Request, after: int = 0):
        role = await who(request)
        if not role:
            return denied()
        if role == "sdk" and not sdk_may_read(request, id):
            return err(404, "not_found")
        ev = history(id)
        if ev is None:
            return err(404, "not_found")
        return JSONResponse({"events": ev[max(0, after):], "next": len(ev), "done": any(e["type"] in TERMINAL for e in ev)}, headers={"cache-control": "no-store"})

    @app.get("/api/runs/{id}/events")
    async def events_stream(id: str, request: Request):
        role = await who(request)
        if not role:
            return denied()
        if role == "sdk" and not sdk_may_read(request, id):
            return err(404, "not_found")

        async def gen():
            live = bus.get_history(id)
            if not live:
                saved = store.get_run(id)
                if saved and saved["data"].get("status") != "running":
                    for e in pipeline.replay_events(saved["data"]):
                        yield f"data: {json.dumps(e)}\n\n"
                    return
            q = bus.subscribe(id)
            try:
                seen = 0
                for e in bus.get_history(id):
                    seen += 1
                    yield f"data: {json.dumps(e)}\n\n"
                    if e["type"] in TERMINAL:
                        return
                # Drop events that arrived in the queue while history was being sent.
                for _ in range(min(seen, q.qsize())):
                    q.get_nowait()
                while True:
                    try:
                        e = await asyncio.wait_for(q.get(), 15)
                    except asyncio.TimeoutError:
                        if await request.is_disconnected():
                            return
                        yield ": heartbeat\n\n"
                        continue
                    yield f"data: {json.dumps(e)}\n\n"
                    if e["type"] in TERMINAL:
                        return
            finally:
                bus.unsubscribe(id, q)

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"cache-control": "no-cache", "x-accel-buffering": "no"})

    @app.post("/api/runs/{id}/cancel")
    async def cancel(id: str, request: Request):
        if not await allowed(request):
            return denied()
        return {"cancelled": control.cancel(id)}

    @app.post("/api/runs/{id}/feedback")
    async def feedback(id: str, request: Request):
        role = await who(request)
        if role != "owner":
            return err(403, "forbidden_for_token") if role else denied()
        b = await body(request) or {}
        rating = b.get("rating") if b.get("rating") in (1, -1) else None
        if not rating:
            return err(400, "bad_rating", "rating must be 1 or -1")
        run = store.get_run(id)
        final = (run or {}).get("data", {}).get("finalResponse")
        if not final:
            return err(404, "not_found")
        comment = b.get("comment") if isinstance(b.get("comment"), str) else ""
        lesson = await learning.record_feedback(id, rating, comment, run["data"].get("standaloneRequest") or run["request"], final.get("summary") or "")
        store.audit(id, "System", "feedback", {"rating": rating}, f"learned: {lesson['lesson']}" if lesson else ("thumbs up" if rating == 1 else "thumbs down"))
        return {"ok": True, "lesson": {"id": lesson["id"], "lesson": lesson["lesson"]} if lesson else None}

    @app.get("/api/runs/{id}/preview/{n}")
    async def preview(id: str, n: int, request: Request):
        if sdk(request) or not await allowed(request):
            return err(404, "not_found")
        atts = ((store.get_run(id) or {}).get("data", {}).get("finalResponse") or {}).get("attachments") or []
        page = atts[n] if 0 <= n < len(atts) else None
        if not page or page.get("type") != "html-preview" or not isinstance(page.get("html"), str):
            return err(404, "not_found")
        return HTMLResponse(page["html"], headers={"content-security-policy": PREVIEW_CSP, "x-content-type-options": "nosniff"})

    @app.get("/api/conversations")
    async def conversations(request: Request):
        if not await allowed(request):
            return denied()
        return {"conversations": conversation.list_conversations()}

    @app.get("/api/conversations/{id}")
    async def conversation_get(id: str, request: Request):
        if not await allowed(request):
            return denied()
        return {"id": id, "turns": conversation.conversation_runs(id)}

    @app.delete("/api/conversations/{id}")
    async def conversation_delete(id: str, request: Request):
        if not await allowed(request):
            return denied()
        return {"deleted": conversation.delete_conversation(id)}

    @app.get("/api/workspace/projects")
    async def workspace_projects(request: Request):
        if not await allowed(request):
            return denied()
        idx = await asyncio.to_thread(workspace_index, patches.workspace_root())
        return {"projects": [{"folder": p.folder, "name": p.name, "description": p.description, "files": len(p.files), "sample": p.files[:8]} for p in idx.projects], "files": len(idx.files)}

    @app.post("/api/attachments/parse")
    async def parse_attachment(request: Request, name: str = "document"):
        """A PDF, Word or PowerPoint file as text for the chat: PDFs are read on this computer; only Word and
        PowerPoint files, or scanned PDFs with no text, go to LlamaParse (if it's set up)."""
        if not await allowed(request):
            return denied()
        data = await request.body()
        if not data:
            return err(400, "empty", "That file is empty.")
        from . import documents

        try:
            text, where = await documents.to_text(name, data)
        except documents.Unsupported as e:
            return err(400, "unsupported", str(e))
        except ToolError as e:
            return err(502, "parse_failed", f"Couldn't read that file: {e}")
        if not text.strip():
            return err(422, "no_text", "I couldn't find any text in that file.")
        return {"name": name[:120], "text": text[:60_000], "where": where, "truncated": len(text) > 60_000}

    # --- WatcherPilot: the parent's focus rules (the browser extension reads them and checks every page) ---

    from . import watcher

    def domain(d: str) -> str:
        return re.sub(r"^www\.", "", re.sub(r"^https?://", "", d.strip().lower())).split("/")[0]

    @app.get("/api/watcher/policy")
    async def watcher_policy(request: Request):
        if not await allowed(request):
            return denied()
        return {"policy": watcher.get_policy(), "hasPin": watcher.has_pin(), "locked": watcher.pin_locked(), "aiDomains": watcher.AI_DOMAINS, "aiExtensionPattern": watcher.AI_EXTENSION_PATTERN}

    @app.post("/api/watcher/policy")
    async def watcher_save(request: Request):
        if not await allowed(request):
            return denied()
        b = await body(request) or {}
        p, pin, new_pin = b.get("policy"), b.get("pin"), b.get("newPin")
        ok = (isinstance(pin, str) and len(pin) <= 8 and (new_pin is None or (isinstance(new_pin, str) and len(new_pin) <= 8)) and isinstance(p, dict)
              and isinstance(p.get("active"), bool) and isinstance(p.get("task"), str) and len(p["task"]) <= 120 and p.get("subject") in (None, *watcher.SUBJECTS)
              and all(isinstance(p.get(k), bool) for k in ("blockAI", "blockAIExtensions", "onTaskOnly"))
              and all(isinstance(p.get(k), list) and len(p[k]) <= 100 and all(isinstance(d, str) and len(d) <= 100 for d in p[k]) for k in ("allow", "block"))
              and (p.get("until") is None or (isinstance(p["until"], str) and re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$", p["until"]))))
        if not ok:
            return err(400, "invalid_request")
        clean = {**watcher.DEFAULT_POLICY, **{k: p[k] for k in watcher.DEFAULT_POLICY}, "allow": [d for d in map(domain, p["allow"]) if d], "block": [d for d in map(domain, p["block"]) if d]}
        result = watcher.save_policy(clean, pin, new_pin)
        if not result["ok"]:
            return err(429 if result["error"] == "locked" else 403, result["error"])
        store.audit("watcher", "WatcherPilot", "policy_saved", {"task": clean["task"], "active": clean["active"], "until": clean["until"]}, "saved")
        return {"policy": watcher.get_policy()}

    @app.post("/api/watcher/check")
    async def watcher_check(request: Request):
        if not await allowed(request):
            return denied()
        b = await body(request) or {}
        url, title = b.get("url"), b.get("title", "")
        if not isinstance(url, str) or len(url) > 2000 or not isinstance(title, str) or len(title) > 300:
            return err(400, "invalid_request")
        d = await watcher.classify_page(watcher.get_policy(), url, title)
        if d["decision"] == "block":
            watcher.log_event(url, title, d["decision"], d["reason"])
        return d

    @app.post("/api/watcher/events")
    async def watcher_events(request: Request):
        if not await allowed(request):
            return denied()
        pin = (await body(request) or {}).get("pin")
        if watcher.pin_locked():
            return err(429, "locked")
        if not watcher.verify_pin(pin if isinstance(pin, str) else ""):
            return err(403, "wrong_pin")
        return {"events": watcher.list_events(100)}

    # --- internal (the TypeScript engine only) ---

    @app.post("/api/internal/run")
    async def internal_run(request: Request):
        if not internal(request):
            return err(404, "not_found")
        b = await request.json()
        import uuid

        b["runId"] = b.get("runId") or str(uuid.uuid4())
        coro = pipeline.execute_run(b["message"], b.get("context") or {}, b["runId"], b.get("conversationId"))
        if b.get("wait"):
            return await coro
        task = asyncio.ensure_future(coro)
        _keep(task)
        return JSONResponse({"runId": b.get("runId")}, status_code=202)

    @app.post("/api/internal/events")
    async def internal_events(request: Request):
        if not internal(request):
            return err(404, "not_found")
        e = await request.json()
        if isinstance(e, dict) and e.get("type") == "audit" and bus.live(str(e.get("runId"))):
            bus.publish(e)
        return {"ok": True}
