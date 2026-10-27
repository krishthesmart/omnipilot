"""Signing in, for when OmniPilot is reached from another device (hosted, or shared with a tunnel).
Requests from this computer never need a password. With OMNIPILOT_PASSWORD set (12+ characters),
other devices sign in once and keep a 30-day session cookie.

Sessions are compatible with the TypeScript engine's (same cookie, same signature), so either can check
them during the move to Python:
  token   = "<expiry ms>.<random>.<HMAC-SHA256(key, "<expiry ms>.<random>") as base64url>"
  key     = SHA-256("<authSecret from the settings table>:<OMNIPILOT_PASSWORD>")
Changing the password therefore signs every device out. The cookie is HttpOnly, SameSite=Lax, and
Secure over https; changes must come from OmniPilot's own address; wrong passwords are slowed down."""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time
from urllib.parse import urlparse

from fastapi import Request

from . import security, store

COOKIE = "omnipilot_session"
SESSION_DAYS = 30


def password() -> str | None:
    p = os.environ.get("OMNIPILOT_PASSWORD", "")
    return p if len(p) >= 12 else None


def public_origin() -> str | None:
    raw = (os.environ.get("OMNIPILOT_PUBLIC_URL") or "").strip()
    if not raw:
        return None
    u = urlparse(raw)
    return f"{u.scheme}://{u.netloc}" if u.scheme in ("http", "https") and u.netloc else None


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _key() -> bytes:
    secret = store.get_setting("authSecret")
    if not secret:
        secret = secrets.token_hex(32)
        store.set_setting("authSecret", secret)
    return hashlib.sha256(f"{secret}:{password() or ''}".encode()).digest()


def _sign(payload: str) -> str:
    return _b64(hmac.new(_key(), payload.encode(), hashlib.sha256).digest())


def issue_session() -> str:
    payload = f"{int(time.time() * 1000) + SESSION_DAYS * 86_400_000}.{_b64(secrets.token_bytes(9))}"
    return f"{payload}.{_sign(payload)}"


def valid_session(token: str | None) -> bool:
    if not password() or not token or "." not in token:
        return False
    payload, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(sig.encode(), _sign(payload).encode()):
        return False
    try:
        return int(payload.split(".")[0]) > time.time() * 1000
    except ValueError:
        return False


def check_password(given: str) -> bool:
    expected = password()
    if not expected:
        return False
    return hmac.compare_digest(hashlib.sha256(given.encode()).digest(), hashlib.sha256(expected.encode()).digest())


def visitor_host(request: Request) -> str:
    h = request.headers
    return h.get("x-omnipilot-forwarded-host") or h.get("x-forwarded-host") or h.get("host") or ""


def secure(request: Request) -> bool:
    pub = public_origin() or ""
    return pub.startswith("https://") or request.headers.get("x-forwarded-proto") == "https" or request.url.scheme == "https"


def cookie_header(request: Request, token: str | None) -> str:
    attrs = f"Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_DAYS * 86_400 if token else 0}" + ("; Secure" if secure(request) else "")
    return f"{COOKIE}={token or ''}; {attrs}"


def address_ok(request: Request) -> str | None:
    """For visitors from other devices: None if the address checks pass, else the error code."""
    pub = public_origin()
    host = visitor_host(request)
    if pub and host.split(":")[0] != urlparse(pub).hostname:
        return "forbidden_host"
    origin = request.headers.get("origin")
    if origin and origin != pub and urlparse(origin).netloc != host and not security.LOCAL_ORIGIN.match(origin):  # exact, not a prefix
        return "forbidden_origin"
    if request.method not in ("GET", "HEAD") and not origin and request.headers.get("cookie") and request.url.path != "/api/login":
        return "forbidden_origin"  # browsers always send Origin on changes; a missing one isn't our page
    return None


def signed_in(request: Request) -> bool:
    return valid_session(request.cookies.get(COOKIE))


# Wrong-password slowdown. Per client address (10 tries per 15 minutes), plus an overall cap, because the
# address comes from headers a visitor can fake to get a fresh allowance for every guess.
WINDOW_S, PER_ADDRESS, OVERALL = 15 * 60, 10, 50
_attempts: dict[str, list[float]] = {}
_all_failures: list[float] = []


def login_allowed(ip: str) -> bool:
    now = time.monotonic()
    recent = [t for t in _attempts.get(ip, []) if now - t < WINDOW_S]
    if recent:
        _attempts[ip] = recent
    else:
        _attempts.pop(ip, None)  # forget addresses with no recent failures (the table can't grow without end)
    _all_failures[:] = [t for t in _all_failures if now - t < WINDOW_S]
    return len(recent) < PER_ADDRESS and len(_all_failures) < OVERALL


def note_failed_login(ip: str) -> None:
    now = time.monotonic()
    _attempts.setdefault(ip, []).append(now)
    _all_failures.append(now)
