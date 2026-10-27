"""Routes moved from the TypeScript engine in stage 2 of the move to Python (docs/PYTHON_PORT.md):
approvals (code change sets and approved actions), connectors (token checks, Gmail, Google Drive sign-in),
MCP servers, and skills/routines (create, change, delete; running them stays with the agents for now).
Responses match the TypeScript ones, so the web app works unchanged."""
from __future__ import annotations

import html
import json
import re

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse

from . import actions, patches, store
from .integrations import drive, gmail, mcp_servers, services

MAX_SKILLS = 50


def err(status: int, error: str, message: str | None = None) -> JSONResponse:
    return JSONResponse({"error": error, **({"message": message} if message else {})}, status_code=status)


async def body(request: Request) -> dict | None:
    """The JSON object sent, {} when there's no body, None when it isn't a JSON object."""
    raw = await request.body()
    if not raw.strip():
        return {}
    try:
        b = json.loads(raw)
    except ValueError:
        return None
    return b if isinstance(b, dict) else None


def _str(v, lo: int, hi: int) -> str | None:
    return v if isinstance(v, str) and lo <= len(v) <= hi else None


# --- skills (same rules as server/src/lib/skills.ts) ---


def slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", re.sub(r"^/", "", name.lower()))
    return s.strip("_")[:40]


def parse_time(text: str) -> str | None:
    t = text.lower()
    if re.search(r"\bnoon\b", t):
        return "12:00"
    if re.search(r"\bmidnight\b", t):
        return "00:00"
    m = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b", re.sub(r"\bat\b", " ", t), re.A)
    if not m or (not m.group(2) and not m.group(3)):
        return None
    h, mins = int(m.group(1)), int(m.group(2) or 0)
    ampm = (m.group(3) or "").replace(".", "")
    if ampm == "pm" and h < 12:
        h += 12
    if ampm == "am" and h == 12:
        h = 0
    return f"{h:02d}:{mins:02d}" if h <= 23 and mins <= 59 else None


_UNSET = object()


def normalize_time(t):
    """"7:30" / "7am" -> "07:30"; None or "" -> None (no schedule); invalid -> _UNSET."""
    if t is None or t == "":
        return None
    if not isinstance(t, str) or len(t) > 20:
        return _UNSET
    if re.fullmatch(r"\d{1,2}:\d{2}", t):
        h, m = map(int, t.split(":"))
        return f"{h:02d}:{m:02d}" if h < 24 and m < 60 else _UNSET
    return parse_time(t) or _UNSET


def _skill(r: dict) -> dict:
    return {"name": r["name"], "label": r["label"], "kind": r["kind"], "instructions": r["instructions"], "dailyAt": r["daily_at"], "lastRunDate": r["last_run_date"], "conversationId": f"routine-{r['name']}"}


def get_skill(name: str) -> dict | None:
    r = store.q1("SELECT * FROM skills WHERE name = ?", slug(name))
    return _skill(r) if r else None


def save_skill(name: str, label: str, kind: str, instructions: str) -> dict:
    n = slug(name)
    if not n:
        raise ValueError("A skill needs a name with letters or numbers.")
    if not get_skill(n) and store.q1("SELECT COUNT(*) AS n FROM skills")["n"] >= MAX_SKILLS:
        raise ValueError(f"You already have {MAX_SKILLS} skills and agents; delete one first.")
    store.x(
        "INSERT INTO skills (name, label, kind, instructions, created_at) VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(name) DO UPDATE SET label = excluded.label, kind = excluded.kind, instructions = excluded.instructions",
        n, label[:60], kind, instructions[:2000], store.now(),
    )
    return get_skill(n)


_ERROR_PAGE_STYLE = "body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f6f8;color:#1f2937}main{max-width:460px;padding:32px;background:#fff;border-radius:16px;box-shadow:0 4px 24px #0001;text-align:center}h1{font-size:20px;color:%s}@media (prefers-color-scheme:dark){body{background:#111318;color:#e5e7eb}main{background:#1b1e24}}"


def _page(title: str, text: str, ok: bool, status: int = 200) -> HTMLResponse:
    style = _ERROR_PAGE_STYLE % ("#059669" if ok else "#b91c1c")
    return HTMLResponse(f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{title}</title><style>{style}</style></head><body><main><h1>{title}</h1><p>{text}</p></main></body></html>', status_code=status)


def register(app: FastAPI, allowed, denied) -> None:
    # --- approvals ---

    @app.get("/api/approvals")
    async def approvals_list(request: Request, runId: str | None = None, status: str | None = None):
        if not await allowed(request):
            return denied()
        rows = store.list_approvals(runId)
        if status:
            rows = [a for a in rows if a["status"] == status]
        if status == "pending":
            # Only changes OmniPilot can actually carry out (a code change or a stored action).
            rows = [a for a in rows if patches.patch_set(a["id"]) or actions.get_action(a["id"])][:50]
            out = []
            for a in rows:
                run = store.get_run(a["run_id"])
                data = (run or {}).get("data") or {}
                found = next((x for x in ((data.get("finalResponse") or {}).get("nextActions") or []) if x.get("id") == a["id"]), None)
                if not found:
                    found = next((x for r in data.get("agentResults") or [] for x in r.get("proposedActions") or [] if x.get("id") == a["id"]), None)
                out.append({**a, "action": found, "conversationId": data.get("conversationId"), "request": (run or {}).get("request")})
            rows = out
        return {"approvals": rows}

    @app.post("/api/approvals/{id}/decision")
    async def approvals_decide(id: str, request: Request):
        if not await allowed(request):
            return denied()
        b = await body(request) or {}
        from . import approvals as approval_flow

        try:
            return await approval_flow.decide(id, b.get("decision"), b.get("payloadSha256"))
        except approval_flow.ApprovalError as e:
            return err(e.status, e.code, e.message if e.message != e.code else None)

    @app.get("/api/approvals/{id}/preview")
    async def approvals_preview(id: str, request: Request):
        if not await allowed(request):
            return denied()
        from . import approvals as approval_flow

        p = approval_flow.preview(id)
        return p if p else err(404, "not_found")

    @app.post("/api/approvals/{id}/undo")
    async def approvals_undo(id: str, request: Request):
        if not await allowed(request):
            return denied()
        result = patches.undo_patch(id)
        store.audit((store.get_approval(id) or {}).get("run_id") or "n/a", "CodePilot", "undo_fix", {"approvalId": id}, "undone" if result["ok"] else f"not undone: {result['error']}")
        if not result["ok"]:
            return err(404 if result["error"] == "not_found" else 409, result["error"], result["message"])
        return {"ok": True, "file": result["file"], "files": result["files"]}

    # --- connectors ---

    @app.get("/api/connectors")
    async def connectors_list(request: Request):
        if not await allowed(request):
            return denied()
        return {"connectors": store.list_connectors()}

    @app.post("/api/connectors/{name}/connect")
    async def connectors_connect(name: str, request: Request):
        if not await allowed(request):
            return denied()
        if not store.connector_internal(name):
            return err(404, "not_found")
        b = await body(request)
        if b is None:
            return err(400, "invalid_request")
        token, account = b.get("token"), b.get("account")
        if (token is not None and not _str(token, 1, 500)) or (account is not None and not _str(account, 3, 200)):
            return err(400, "invalid_request")
        if name == "Gmail":
            if not token or not account:
                return err(400, "token_required", "Gmail needs your address and an app password.")
            address, app_password = account.strip(), re.sub(r"\s+", "", token)
            try:
                label = await gmail.verify(address, app_password)
            except (ValueError, OSError) as e:
                e = e if isinstance(e, ValueError) else "Couldn't reach Gmail. Check your internet connection."
                store.audit("n/a", "InfraPilot", "connector_verify", {"name": name, "account": account, "token": token}, f"failed: {e}")
                return err(400, "verification_failed", str(e))
            store.audit("n/a", "InfraPilot", "connector_verify", {"name": name, "account": account, "token": token}, f"verified as {label}")
            store.set_connector_verified(name, label, json.dumps({"address": address, "password": app_password}))
            return store.connector_public(name)
        verifier = services.VERIFIERS.get(name)
        if not verifier:
            return err(400, "oauth_required", f"{name} connects by signing in with the provider (use the button on its card).")
        if not token:
            return err(400, "token_required", f"{name} requires a token to verify a real connection.")
        try:
            label = await verifier(token)
        except services.VerifyFailed as e:
            store.audit("n/a", "InfraPilot", "connector_verify", {"name": name, "token": token}, f"failed: {e}")
            return err(400, "verification_failed", str(e))
        store.audit("n/a", "InfraPilot", "connector_verify", {"name": name, "token": token}, f"verified as {label}")
        store.set_connector_verified(name, label or "connected", token)
        return store.connector_public(name)

    @app.post("/api/connectors/{name}/oauth/start")
    async def connectors_oauth_start(name: str, request: Request):
        if not await allowed(request):
            return denied()
        if name != "Google Drive":
            return err(404, "not_found")
        b = await body(request) or {}
        cid, secret, origin = _str(b.get("clientId"), 10, 200), _str(b.get("clientSecret"), 5, 200), _str(b.get("origin"), 1, 100)
        if not (cid and secret and origin):
            return err(400, "invalid_request", "Paste the client ID and client secret from Google Cloud.")
        try:
            return {"url": drive.start(cid, secret, origin)}
        except ValueError as e:
            return err(400, "invalid_request", str(e))

    @app.get("/api/oauth/google/callback")
    async def google_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None):
        if not await allowed(request):
            return denied()
        if error or not code or not state:
            text = "You cancelled the sign-in. You can close this tab." if error == "access_denied" else "Google didn't send a sign-in code. Start again from the Google Drive card."
            return _page("Google Drive wasn't connected", text, False, 400)
        try:
            account = await drive.finish(code, state)
        except Exception as e:  # noqa: BLE001 -- shown to the user on the page
            store.audit("n/a", "InfraPilot", "connector_oauth", {"name": "Google Drive"}, f"failed: {e}")
            return _page("Google Drive wasn't connected", html.escape(str(e) or "Sign-in failed."), False, 400)
        store.audit("n/a", "InfraPilot", "connector_oauth", {"name": "Google Drive"}, f"connected as {account}")
        return _page("Google Drive is connected", f"Signed in as {html.escape(account)}. You can close this tab and go back to OmniPilot.", True)

    @app.post("/api/connectors/{name}/disconnect")
    async def connectors_disconnect(name: str, request: Request):
        if not await allowed(request):
            return denied()
        if not store.connector_internal(name):
            return err(404, "not_found")
        if name == "Google Drive":
            await drive.revoke()
        store.set_connector_status(name, "not_connected")
        store.audit("n/a", "InfraPilot", "connector_disconnect", {"name": name}, "not_connected")
        return store.connector_public(name)

    # --- MCP servers (adding one happens in chat, after approval) ---

    @app.get("/api/mcp/servers")
    async def mcp_list(request: Request):
        if not await allowed(request):
            return denied()
        return {"servers": mcp_servers.list_public()}

    @app.get("/api/mcp/presets")
    async def mcp_presets(request: Request):
        if not await allowed(request):
            return denied()
        return {"presets": mcp_servers.presets()}

    @app.post("/api/mcp/presets/{key}/add")
    async def mcp_preset_add(key: str, request: Request):
        if not await allowed(request):
            return denied()
        out = mcp_servers.propose_preset(key)
        if not out:
            return err(404, "not_found", "No such MCP preset.")
        return out  # {approvalId, runId} — approve it in Activity & Approvals (Permission Preview)

    @app.post("/api/mcp/servers/{name}/refresh")
    async def mcp_refresh(name: str, request: Request):
        if not await allowed(request):
            return denied()
        try:
            return {"tools": await mcp_servers.refresh(name)}
        except Exception as e:  # noqa: BLE001 -- the server's own error, shown to the user
            return err(400, "refresh_failed", str(e)[:300] or "failed")

    @app.delete("/api/mcp/servers/{name}")
    async def mcp_delete(name: str, request: Request):
        if not await allowed(request):
            return denied()
        if not mcp_servers.remove(name):
            return err(404, "not_found")
        store.audit("n/a", "InfraPilot", "mcp_remove_server", {"name": name}, "removed")
        return {"ok": True}

    # --- skills and routines (running them is still the TypeScript agents' job) ---

    @app.get("/api/skills")
    async def skills_list(request: Request):
        if not await allowed(request):
            return denied()
        return {"skills": [_skill(r) for r in store.q("SELECT * FROM skills ORDER BY kind, name")]}

    @app.post("/api/skills")
    async def skills_create(request: Request):
        if not await allowed(request):
            return denied()
        b = await body(request) or {}
        name, instructions, kind = _str(b.get("name"), 2, 60), _str(b.get("instructions"), 3, 2000), b.get("kind", "skill")
        if not name or not instructions or kind not in ("skill", "agent"):
            return err(400, "invalid_request", "Give it a name and say what it should do.")
        daily = normalize_time(b.get("dailyAt"))
        if daily is _UNSET:
            return err(400, "invalid_time", 'Use a time like "07:30" or "7am".')
        try:
            s = save_skill(name, name.strip(), kind, instructions)
        except ValueError as e:
            return err(400, "invalid_request", str(e))
        if "dailyAt" in b and kind == "skill":
            store.x("UPDATE skills SET daily_at = ? WHERE name = ?", daily, s["name"])
        store.audit("n/a", "InfraPilot", "save_skill", {"name": s["name"], "kind": kind, "dailyAt": daily}, "saved")
        return {"skill": get_skill(s["name"])}

    @app.patch("/api/skills/{name}")
    async def skills_change(name: str, request: Request):
        if not await allowed(request):
            return denied()
        s = get_skill(name)
        if not s:
            return err(404, "not_found")
        b = await body(request)
        if b is None or ("instructions" in b and not _str(b["instructions"], 3, 2000)):
            return err(400, "invalid_request")
        if b.get("instructions"):
            save_skill(s["name"], s["label"], s["kind"], b["instructions"])
        if "dailyAt" in b:
            t = normalize_time(b["dailyAt"])
            if t is _UNSET:
                return err(400, "invalid_time", 'Use a time like "07:30" or "7am".')
            if s["kind"] == "agent":
                return err(400, "invalid_request", "Custom agents can't run on a schedule; make a skill for that.")
            store.x("UPDATE skills SET daily_at = ? WHERE name = ?", t, s["name"])
        return {"skill": get_skill(s["name"])}

    @app.delete("/api/skills/{name}")
    async def skills_delete(name: str, request: Request):
        if not await allowed(request):
            return denied()
        if not store.x("DELETE FROM skills WHERE name = ?", slug(name)):
            return err(404, "not_found")
        store.audit("n/a", "InfraPilot", "delete_skill", {"name": name}, "deleted")
        return {"ok": True}
