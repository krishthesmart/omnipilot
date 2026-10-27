"""The front door's protections, enforced in application code before any request
reaches the engines. A port of server/src/lib/security.ts with the same rules:

- only this computer may connect (Host check, a DNS-rebinding defence), unless an
  SDK token is presented;
- web pages may only call the API from OmniPilot's own origin; the Watcher browser
  extension may call only the two Watcher endpoints it needs;
- an SDK token (OMNIPILOT_API_TOKEN, 16+ characters) opens question-answering only,
  and never for a browser (a request with an Origin);
- security headers on every response, a rate limit on chat, a 256 KB body limit.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from collections import defaultdict, deque
from typing import Awaitable, Callable

from .config import Settings

LOCAL_HOST = re.compile(r"^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$", re.I)
LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$", re.I)
EXTENSION_ORIGIN = re.compile(r"^(chrome|moz)-extension://[a-z0-9-]+$", re.I)
EXTENSION_PATHS = re.compile(r"^/api/watcher/(policy|check)$")
# No run list for tokens: an SDK client reads only runs it started (ID plus that run's key; the engine checks the key).
SDK_PATHS = re.compile(r"^/api/(ask|chat|runs/[\w-]+(/events(\.json)?)?|status|health|math/(status|discoveries|check))$")
RATE_LIMITED = re.compile(r"^/api/(chat|ask)$")
# A page CodePilot wrote, for the chat's preview frame: the TypeScript engine sends it with its own
# sandboxing CSP (scripts run in an opaque origin, no network, framed only by OmniPilot), kept as-is here.
PREVIEW_PATH = re.compile(r"^/api/runs/[\w-]+/preview/\d+$")
# The NiceGUI workspace needs inline scripts and runtime-compiled templates (Vue); everything still comes from
# this server only, it can't be framed, and model output it shows is sanitized (ui.markdown).
WORKSPACE_PATH = re.compile(r"^/app(/|$)")
WORKSPACE_CSP = (b"default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
                 b"font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
LOOPBACK_ADDRESS = re.compile(r"^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$")
# A reverse proxy adds these: such a request may come from anywhere, even when it arrives over loopback.
# Cloudflare's own headers count too: a Cloudflare Tunnel connects from this computer, but its visitors are on the internet.
PROXY_HEADERS = ("x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host", "cf-connecting-ip", "cf-ray")
# Tells the TypeScript engine this front door saw a local client (trusted only with the internal secret).
CLIENT_LOCAL_HEADER = "x-omnipilot-client-local"


def is_local_client(scope: dict, headers: dict[str, str]) -> bool:
    """Decided by the connection's address, never by the Host header (which any client can set)."""
    if any(h in headers for h in PROXY_HEADERS):
        return False
    client = scope.get("client")
    return bool(client) and bool(LOOPBACK_ADDRESS.match(client[0]))
MAX_BODY = 256 * 1024
# Endpoints that receive files get their own limits (everything else keeps the small one).
UPLOAD_LIMITS = [
    (re.compile(r"^/api/projects/[0-9a-f-]{36}/files$"), 5 * 1024 * 1024 + 4096),
    (re.compile(r"^/api/attachments/parse$"), 10 * 1024 * 1024),
    (re.compile(r"^/app/_nicegui/client/[^/]+/upload/"), 5 * 1024 * 1024 + 65536),  # the workspace's file upload
]


def body_limit(path: str) -> int:
    return next((limit for rx, limit in UPLOAD_LIMITS if rx.match(path)), MAX_BODY)

SECURITY_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (
        b"content-security-policy",
        b"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; "
        b"frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    ),
]

ASGIApp = Callable[[dict, Callable[[], Awaitable[dict]], Callable[[dict], Awaitable[None]]], Awaitable[None]]


def _digest(s: str) -> bytes:
    return hashlib.sha256(s.encode()).digest()


def token_matches(authorization: str | None, expected: str | None) -> bool | None:
    """None: no bearer token sent. True/False: a token was sent and does/doesn't match (constant time)."""
    m = re.match(r"^Bearer\s+(.+)$", authorization or "", re.I)
    if not m:
        return None
    if not expected:
        return False
    return hmac.compare_digest(_digest(m.group(1).strip()), _digest(expected))


class RateLimiter:
    """Per-client sliding window: plenty for one person, stops runaway loops."""

    def __init__(self, window_s: float = 60.0, limit: int = 30):
        self.window_s, self.limit = window_s, limit
        self.hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        q = self.hits[key]
        while q and now - q[0] >= self.window_s:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        return True


class FrontDoor:
    """ASGI middleware: every request passes these checks first; every response gets the security headers."""

    def __init__(self, app: ASGIApp, settings: Settings):
        self.app, self.settings = app, settings
        self.limiter = RateLimiter()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
        path, method = scope["path"], scope["method"]
        origin = headers.get("origin")

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                if PREVIEW_PATH.match(path):
                    extra = [h for h in SECURITY_HEADERS if h[0] not in (b"x-frame-options", b"content-security-policy")]
                elif WORKSPACE_PATH.match(path):
                    extra = [h for h in SECURITY_HEADERS if h[0] != b"content-security-policy"] + [(b"content-security-policy", WORKSPACE_CSP)]
                else:
                    extra = list(SECURITY_HEADERS)
                if origin:
                    extra += [
                        (b"access-control-allow-origin", origin.encode()),
                        (b"vary", b"Origin"),
                        (b"access-control-allow-headers", b"Content-Type"),
                        (b"access-control-allow-methods", b"GET, POST, OPTIONS"),
                    ]
                names = {k for k, _ in extra}
                message = {**message, "headers": [h for h in message.get("headers", []) if h[0].lower() not in names] + extra}
            await send(message)

        async def reply(status: int, body: dict | None, extra: list[tuple[bytes, bytes]] = ()):
            data = json.dumps(body).encode() if body is not None else b""
            await send_with_headers(
                {"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(data)).encode()), *extra]}
            )
            await send_with_headers({"type": "http.response.body", "body": data})

        token = token_matches(headers.get("authorization"), self.settings.api_token)
        if token is False:
            return await reply(401, {"error": "invalid_token"})
        local = False
        if token is True:
            if origin or not SDK_PATHS.match(path):
                return await reply(403, {"error": "forbidden_for_token"})
        else:
            local = is_local_client(scope, headers)
            if not local and self.settings.owner_password_set:
                # Hosted or shared (a Cloudflare Tunnel): the TypeScript engine makes the visitor sign in
                # and checks the address; this door still applies its size and rate limits below.
                pass
            elif not local:
                return await reply(401, {"error": "token_required", "message": "Requests from other devices need the API token."})
            # A DNS-rebinding defence; OMNIPILOT_ALLOW_ANY_HOST relaxes only this, never the checks above.
            if local and not LOCAL_HOST.match(headers.get("host", "")) and not self.settings.allow_any_host:
                return await reply(403, {"error": "forbidden_host"})
            if local and origin and not LOCAL_ORIGIN.match(origin) and origin not in self.settings.allowed_origins:
                extension_ok = EXTENSION_ORIGIN.match(origin) and EXTENSION_PATHS.match(path) and (method == "GET" or path.endswith("/check"))
                if not extension_ok:
                    return await reply(403, {"error": "forbidden_origin"})
        if method == "OPTIONS":
            return await reply(204, None)

        if RATE_LIMITED.match(path):
            client = (scope.get("client") or ("local", 0))[0]
            if not self.limiter.allow(f"{client}:{path}"):
                return await reply(429, {"error": "rate_limited"}, [(b"retry-after", b"60")])

        # Body size limit: refuse early on Content-Length, and while streaming the body in.
        length = headers.get("content-length")
        limit = body_limit(path)
        if length and length.isdigit() and int(length) > limit:
            return await reply(413, {"error": "too_large"})
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise BodyTooLarge()
            return message

        # The engine behind this door trusts our verdict about the client, never the client's own claim.
        forwarded_headers = [(k, v) for k, v in scope["headers"] if k.decode().lower() != CLIENT_LOCAL_HEADER]
        if local:
            forwarded_headers.append((CLIENT_LOCAL_HEADER.encode(), b"1"))
        scope = {**scope, "headers": forwarded_headers}
        try:
            await self.app(scope, limited_receive, send_with_headers)
        except BodyTooLarge:
            await reply(413, {"error": "too_large"})


class BodyTooLarge(Exception):
    pass
