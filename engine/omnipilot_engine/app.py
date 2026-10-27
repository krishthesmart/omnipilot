"""OmniPilot's front door (FastAPI). Every request passes the security checks in
security.py first. Endpoints the Python engine has taken over are served here;
everything else is passed through to the TypeScript engine on an internal
loopback port (it only accepts requests carrying the internal token), with
streams (server-sent events) passed through as they arrive. The web UI is
served from web/dist.
"""
from __future__ import annotations

import asyncio

from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

import posixpath
import sys
from urllib.parse import unquote

import hmac

from .brain import api as brain_api, api_code
from . import api_projects
from . import api_stage2, auth, config, llm, remote_exec, speech, store
from .security import CLIENT_LOCAL_HEADER, FrontDoor, is_local_client
from .tools import router as tool_router, status as tools_status
from .tools.base import Budget, ToolError

HOP_BY_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length"}
INTERNAL_HEADER = "x-omnipilot-internal"


async def _relay(upstream: httpx.Response):
    """Passes the engine's response through as it arrives. If the engine closes the connection
    partway (it restarted, or an event stream ended abruptly), the response just ends: the browser
    reconnects event streams by itself, so there's nothing to report beyond a short note."""
    try:
        async for chunk in upstream.aiter_raw():
            yield chunk
    except (httpx.RemoteProtocolError, httpx.ReadError, httpx.StreamClosed) as err:
        print(f"engine closed a response early ({type(err).__name__}); ended it", file=sys.stderr)


def create_app(settings: config.Settings | None = None, transport: httpx.AsyncBaseTransport | None = None, e2b_factory=None, transcriber=None) -> FastAPI:
    settings = settings or config.load()
    state: dict = {}

    def node() -> httpx.AsyncClient:
        # Streams can stay open for minutes (a long answer), so no read timeout on the passthrough.
        if "client" not in state:
            state["client"] = httpx.AsyncClient(base_url=settings.node_url, transport=transport, timeout=httpx.Timeout(10.0, read=None))
        return state["client"]

    app = FastAPI(title="OmniPilot", docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/api/engine/health")
    async def engine_health():
        return {"ok": True, "engine": "python"}

    async def audit(action: str, outcome: str, parameters: dict) -> None:
        """Writes to OmniPilot's activity log (kept by the TypeScript engine)."""
        try:
            await node().post(
                "/api/internal/audit",
                json={"agent": "RemoteExec", "action": action, "outcome": outcome, "parameters": parameters, "runId": "remote-exec"},
                headers={INTERNAL_HEADER: settings.internal_token, CLIENT_LOCAL_HEADER: "1"},
            )
        except httpx.HTTPError as err:
            print(f"activity log unavailable ({type(err).__name__}): {action} {outcome}", file=sys.stderr)

    async def allowed(request: Request) -> bool:
        """Endpoints this service answers itself: anyone on this computer, or a visitor signed in to
        OmniPilot from the right address (see auth.py)."""
        if is_local_client(request.scope, {k.lower(): v for k, v in request.headers.items()}):
            return True
        return bool(auth.password()) and auth.address_ok(request) is None and auth.signed_in(request)

    def client_ip(request: Request) -> str:
        h = request.headers
        return h.get("cf-connecting-ip") or (h.get("x-forwarded-for") or "").split(",")[0].strip() or (request.client.host if request.client else "unknown")

    # --- Signing in (when OmniPilot is reached from another device; never needed on this computer) ---

    @app.get("/api/auth")
    async def auth_status(request: Request):
        local = is_local_client(request.scope, {k.lower(): v for k, v in request.headers.items()})
        required = bool(auth.password()) and not local
        return {"required": required, "signedIn": (not required) or auth.signed_in(request)}

    @app.post("/api/login")
    async def login(request: Request):
        if not auth.password():
            return JSONResponse({"error": "not_found"}, status_code=404)
        if (problem := auth.address_ok(request)) is not None:
            return JSONResponse({"error": problem}, status_code=403)
        ip = client_ip(request)
        if not auth.login_allowed(ip):
            return JSONResponse({"error": "rate_limited", "message": "Too many tries. Wait 15 minutes."}, status_code=429)
        try:
            given = str((await request.json()).get("password", ""))
        except ValueError:
            given = ""
        if not auth.check_password(given):
            auth.note_failed_login(ip)
            await asyncio.sleep(1)  # each wrong guess costs a second
            return JSONResponse({"error": "wrong_password", "message": "That password isn't right."}, status_code=401)
        store.audit("n/a", "System", "sign_in", {}, "signed in")
        return JSONResponse({"ok": True}, headers={"set-cookie": auth.cookie_header(request, auth.issue_session())})

    @app.post("/api/logout")
    async def logout(request: Request):
        return JSONResponse({"ok": True}, headers={"set-cookie": auth.cookie_header(request, None)})

    def internal(request: Request) -> bool:
        sent = request.headers.get(INTERNAL_HEADER, "")
        return bool(settings.internal_token) and hmac.compare_digest(sent.encode(), settings.internal_token.encode())

    denied = lambda: JSONResponse({"error": "login_required", "message": "Sign in to OmniPilot."}, status_code=401)

    # --- Services: status of every tool service, and live checks (see tools/status.py) ---

    @app.get("/api/services")
    async def services(request: Request):
        if not await allowed(request):
            return denied()
        return {"services": tools_status.table(), "localModel": await llm.local_status()}

    @app.post("/api/services/verify")
    async def services_verify(request: Request):
        if not await allowed(request):
            return denied()
        body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
        names = [n for n in (body.get("names") or []) if n in tools_status.EXPECTED] or None
        return {"services": await tools_status.verify(names)}

    # --- For the TypeScript engine only (internal secret): the local-first model and the tool router ---

    @app.post("/api/internal/llm")
    async def internal_llm(request: Request):
        if not internal(request):
            return JSONResponse({"error": "not_found"}, status_code=404)
        b = await request.json()
        run_token = llm.current_run.set(b.get("runId"))  # so this run's lessons apply
        try:
            out = await llm.chat(b["messages"], fmt=b.get("format"), temperature=float(b.get("temperature", 0.3)), max_tokens=int(b.get("maxTokens", 800)), hard=bool(b.get("hard")), effort=b.get("effort"), timeout=float(b.get("timeoutS", 120)))
        except llm.NoModel as err:
            return JSONResponse({"error": "no_model", "message": str(err)}, status_code=503)
        finally:
            llm.current_run.reset(run_token)
        return out

    @app.post("/api/internal/tools/{kind}")
    async def internal_tools(kind: str, request: Request):
        if not internal(request):
            return JSONResponse({"error": "not_found"}, status_code=404)
        b = await request.json()
        budget = Budget(**{k: v for k, v in (b.get("budget") or {}).items() if k in ("max_calls", "max_cost_usd", "deadline_s")})
        try:
            out = await tool_router.run(kind, b.get("args") or {}, budget, prefer=b.get("prefer"))
            return {**out, "budget": budget.log}
        except ToolError as err:
            return JSONResponse({"error": err.code, "message": str(err), "budget": budget.log}, status_code=422)

    # --- Optional E2B remote execution: one fixed smoke test, never a shell (see remote_exec.py) ---

    @app.get("/api/remote/e2b/status")
    async def e2b_status():
        return {
            "configured": remote_exec.configured(),
            "operation": "smoke test (fixed command)",
            "command": remote_exec.SMOKE_COMMAND,
            "limits": {"commandTimeoutS": remote_exec.COMMAND_TIMEOUT_S, "sandboxLifetimeS": remote_exec.SANDBOX_LIFETIME_S, "maxOutputChars": remote_exec.MAX_OUTPUT_CHARS, "internet": False},
        }

    @app.post("/api/remote/e2b/smoke-test")
    async def e2b_smoke_test(request: Request):
        if not await allowed(request):
            return denied()
        result = await remote_exec.run_smoke_test(audit, factory=e2b_factory)
        status = 200 if result["ok"] else {"not_configured": 503, "busy": 429}.get(result["error"], 502)
        return JSONResponse(result, status_code=status)

    # --- Speech to text on this computer (the mic button's fallback; see speech.py) ---

    @app.get("/api/speech/status")
    async def speech_status():
        from .tools.providers import speech_cloud

        return {"available": transcriber is not None or speech.available(), "model": speech.MODEL_NAME, "maxSeconds": speech.MAX_SECONDS, "cloudFallback": speech_cloud.allowed()}

    @app.post("/api/speech/transcribe")
    async def speech_transcribe(request: Request):
        if not await allowed(request):
            return denied()
        result = await speech.transcribe(await request.body(), request.headers.get("content-type", "audio/webm"), transcriber=transcriber)
        status = 200 if result["ok"] else {"empty": 422, "not_installed": 503, "busy": 429, "timeout": 504}.get(result["error"], 500)
        return JSONResponse(result, status_code=status)

    # --- Approvals, connectors, MCP servers, skills: answered here now (see api_stage2.py) ---
    api_stage2.register(app, allowed, denied)
    if brain_api.enabled():
        brain_api.register(app, allowed, denied, settings, internal)
        api_code.register(app, allowed, denied)
        api_projects.register(app, allowed, denied)

    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def pass_through(path: str, request: Request):
        # Internal endpoints are for this service only, never forwarded for a client (checked on the
        # normalised path, so "./internal", "//internal" or "x/../internal" don't slip through).
        normalised = posixpath.normpath("/" + unquote(path)).lstrip("/").lower()
        if normalised == "internal" or normalised.startswith("internal/"):
            return JSONResponse({"error": "not_found"}, status_code=404)
        client = node()
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP}
        headers[INTERNAL_HEADER] = settings.internal_token
        # Forward the path exactly as the client sent it (still %-encoded): decoding it here would turn
        # an encoded "/" into a real one and could change which endpoint the engine sees.
        raw_path = request.scope.get("raw_path") or f"/api/{path}".encode()
        raw_query = request.scope.get("query_string", b"")
        target = httpx.URL(raw_path=raw_path + (b"?" + raw_query if raw_query else b""))
        upstream_request = client.build_request(request.method, target, headers=headers, content=await request.body())
        try:
            upstream = await client.send(upstream_request, stream=True)
        except httpx.HTTPError:
            return JSONResponse({"error": "engine_unavailable", "message": "OmniPilot's engine isn't responding. Restart OmniPilot."}, status_code=502)
        response_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in HOP_BY_HOP}
        return StreamingResponse(_relay(upstream), status_code=upstream.status_code, headers=response_headers, background=BackgroundTask(upstream.aclose))

    # The project workspace (NiceGUI, Python), mounted before the web app's catch-all below.
    from . import ui as workspace_ui

    workspace_ui.mount(app, allowed)

    dist: Path = settings.web_dist

    @app.get("/{path:path}")
    async def web(path: str):
        if not (dist / "index.html").exists():
            return Response("The web UI isn't built yet. Run: npm run build", status_code=404, media_type="text/plain")
        candidate = (dist / path).resolve()
        # Real files under web/dist only (no path traversal); every other path is the single-page app.
        if path and candidate.is_file() and dist.resolve() in candidate.parents:
            return FileResponse(candidate, headers={"cache-control": "public, max-age=3600"})
        return FileResponse(dist / "index.html")

    return FrontDoor(app, settings)


app = create_app()
