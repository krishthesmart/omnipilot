"""Google Drive with Google's own sign-in (OAuth 2.0 for desktop apps, with PKCE), using the user's free
client ID. Scopes: drive.readonly (search and read) and drive.file (create new docs, on approval).
Tokens stay in OmniPilot's database (connector "Google Drive"); compatible with the TypeScript engine."""
from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import time
from urllib.parse import urlencode

import httpx

from .. import auth, store

SCOPES = ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file", "openid", "email"]
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/drive/v3"
UPLOAD = "https://www.googleapis.com/upload/drive/v3"
LOCAL_ORIGIN = re.compile(r"^http://(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$")

_pending: dict[str, dict] = {}  # sign-ins started in the last 10 minutes, by state


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def start(client_id: str, client_secret: str, origin: str) -> str:
    if not LOCAL_ORIGIN.match(origin) and origin != auth.public_origin():
        raise ValueError("Sign-in must be started from OmniPilot itself.")
    if not client_id.strip().endswith(".apps.googleusercontent.com"):
        raise ValueError('That isn\'t a Google OAuth client ID (it ends with ".apps.googleusercontent.com").')
    for k in [k for k, v in _pending.items() if time.time() - v["at"] > 600]:
        _pending.pop(k, None)
    state, verifier = _b64(secrets.token_bytes(24)), _b64(secrets.token_bytes(48))
    redirect = f"{origin}/api/oauth/google/callback"
    _pending[state] = {"verifier": verifier, "client_id": client_id.strip(), "client_secret": client_secret.strip(), "redirect": redirect, "at": time.time()}
    return AUTH_URL + "?" + urlencode({
        "client_id": client_id.strip(), "redirect_uri": redirect, "response_type": "code", "scope": " ".join(SCOPES),
        "access_type": "offline", "prompt": "consent", "include_granted_scopes": "true", "state": state,
        "code_challenge": _b64(hashlib.sha256(verifier.encode()).digest()), "code_challenge_method": "S256",
    })


async def _token_request(body: dict) -> dict:
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(TOKEN_URL, data=body)
    d = r.json() if r.content else {}
    if r.status_code >= 400:
        raise RuntimeError(d.get("error_description") or d.get("error") or f"Google answered HTTP {r.status_code}")
    return d


async def finish(code: str, state: str) -> str:
    p = _pending.pop(state, None)
    if not p or time.time() - p["at"] > 600:
        raise RuntimeError("This sign-in link expired or wasn't started here. Start again from the Google Drive card.")
    t = await _token_request({"code": code, "client_id": p["client_id"], "client_secret": p["client_secret"], "redirect_uri": p["redirect"], "grant_type": "authorization_code", "code_verifier": p["verifier"]})
    if not t.get("refresh_token"):
        raise RuntimeError("Google didn't grant offline access. Remove OmniPilot's access in your Google Account and sign in again.")
    tokens = {"clientId": p["client_id"], "clientSecret": p["client_secret"], "refreshToken": t["refresh_token"], "accessToken": t["access_token"], "expiresAt": int((time.time() + int(t.get("expires_in", 3600))) * 1000)}
    async with httpx.AsyncClient(timeout=15) as c:
        about = (await c.get(f"{API}/about", params={"fields": "user(emailAddress,displayName)"}, headers={"Authorization": f"Bearer {tokens['accessToken']}"})).json()
    account = (about.get("user") or {}).get("emailAddress") or (about.get("user") or {}).get("displayName") or "your Google account"
    store.set_connector_verified("Google Drive", account, json.dumps(tokens))
    return account


def _stored() -> dict:
    c = store.connector_internal("Google Drive")
    if not c or c["status"] != "connected" or not c["secret_token"]:
        raise RuntimeError("Google Drive isn't connected.")
    return json.loads(c["secret_token"])


async def access_token() -> str:
    t = _stored()
    if t.get("accessToken") and t.get("expiresAt", 0) - time.time() * 1000 > 60_000:
        return t["accessToken"]
    try:
        r = await _token_request({"client_id": t["clientId"], "client_secret": t["clientSecret"], "refresh_token": t["refreshToken"], "grant_type": "refresh_token"})
    except RuntimeError as err:
        raise RuntimeError(f"Google Drive needs you to sign in again ({err}).")
    t.update(accessToken=r["access_token"], expiresAt=int((time.time() + int(r.get("expires_in", 3600))) * 1000))
    c = store.connector_internal("Google Drive")
    store.set_connector_verified("Google Drive", (c or {}).get("account_label") or "Google Drive", json.dumps(t))
    return t["accessToken"]


async def create_doc(p: dict) -> dict:
    boundary = f"omnipilot-{secrets.token_hex(8)}"
    body = "\r\n".join([f"--{boundary}", "Content-Type: application/json; charset=UTF-8", "", json.dumps({"name": p["title"], "mimeType": "application/vnd.google-apps.document"}), f"--{boundary}", "Content-Type: text/plain; charset=UTF-8", "", p["text"], f"--{boundary}--"])
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{UPLOAD}/files", params={"uploadType": "multipart", "fields": "id,webViewLink"}, content=body.encode(), headers={"Authorization": f"Bearer {await access_token()}", "Content-Type": f"multipart/related; boundary={boundary}"})
    d = r.json() if r.content else {}
    if r.status_code >= 400:
        return {"ok": False, "message": (d.get("error") or {}).get("message") or f"Couldn't create the doc (HTTP {r.status_code})."}
    return {"ok": True, "message": f'Created the Google Doc "{p["title"]}" in your Drive.', "url": d.get("webViewLink") or f"https://docs.google.com/document/d/{d.get('id')}/edit"}


async def revoke() -> None:
    try:
        t = _stored()
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post("https://oauth2.googleapis.com/revoke", params={"token": t["refreshToken"]})
    except Exception:
        pass


# --- Search and read (drive.readonly) ---

KIND = {"application/vnd.google-apps.document": "Google Doc", "application/vnd.google-apps.spreadsheet": "Google Sheet", "application/vnd.google-apps.presentation": "Google Slides",
        "application/vnd.google-apps.folder": "folder", "application/pdf": "PDF"}
EXPORT_AS = {"application/vnd.google-apps.document": "text/plain", "application/vnd.google-apps.presentation": "text/plain", "application/vnd.google-apps.spreadsheet": "text/csv"}
FIELDS = "id,name,mimeType,modifiedTime,webViewLink,size"


def connected() -> bool:
    c = store.connector_internal("Google Drive")
    return bool(c and c["status"] == "connected")


def kind_of(mime: str) -> str:
    return KIND.get(mime) or ("text file" if mime.startswith("text/") else mime.split("/")[-1] or "file")


async def _api(url: str, params: dict | None = None) -> httpx.Response:
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(url, params=params, headers={"Authorization": f"Bearer {await access_token()}"})
    if r.status_code == 401:
        raise RuntimeError("Google Drive needs you to sign in again.")
    if r.status_code == 403:
        raise RuntimeError(f"Google Drive refused: {((r.json() if r.content else {}).get('error') or {}).get('message') or 'permission denied'}")
    return r


def _q(s: str) -> str:
    return s.replace("\\", "\\\\").replace("'", "\\'")


async def search(text: str, limit: int = 10) -> list[dict]:
    words = text.strip()
    query = f"trashed = false and (name contains '{_q(words)}' or fullText contains '{_q(words)}')" if words else "trashed = false and mimeType != 'application/vnd.google-apps.folder'"
    params = {"q": query, "pageSize": str(limit), "fields": f"files({FIELDS})", "supportsAllDrives": "true", "includeItemsFromAllDrives": "true", **({} if words else {"orderBy": "modifiedTime desc"})}
    r = await _api(f"{API}/files", params)
    d = r.json() if r.content else {}
    if r.status_code >= 400:
        raise RuntimeError((d.get("error") or {}).get("message") or f"Drive search failed (HTTP {r.status_code})")
    lw = words.lower()
    return sorted(d.get("files") or [], key=lambda f: -int(lw in f["name"].lower()))


def id_from_link(text: str) -> str | None:
    m = re.search(r"(?:docs|drive|sheets|slides)\.google\.com\/(?:a\/[^/]+\/)?(?:document|spreadsheets|presentation|file|forms)\/(?:u\/\d+\/)?d\/(?:e\/)?([\w-]{20,})", text) \
        or re.search(r"drive\.google\.com\/(?:open|uc)\?(?:[^ ]*&)?id=([\w-]{20,})", text)
    return m.group(1) if m else None


async def get_file(id: str) -> dict:
    from urllib.parse import quote

    r = await _api(f"{API}/files/{quote(id, safe='')}", {"fields": FIELDS, "supportsAllDrives": "true"})
    if r.status_code == 404:
        raise RuntimeError("That file isn't in your Drive or shared with your Google account.")
    if r.status_code >= 400:
        raise RuntimeError(f"Couldn't open the file (HTTP {r.status_code}).")
    return r.json()


async def read_file(f: dict, max_chars: int = 60_000) -> str:
    if f["mimeType"] in EXPORT_AS:
        r = await _api(f"{API}/files/{f['id']}/export", {"mimeType": EXPORT_AS[f["mimeType"]]})
    elif f["mimeType"].startswith("text/") or re.search(r"json|xml|javascript|x-python|csv|markdown", f["mimeType"]):
        r = await _api(f"{API}/files/{f['id']}", {"alt": "media"})
    else:
        raise RuntimeError(f"{f['name']} is a {kind_of(f['mimeType'])}, which OmniPilot can't read as text yet (it reads Google Docs, Sheets, Slides and text files).")
    if r.status_code >= 400:
        raise RuntimeError(f"Couldn't read {f['name']} (HTTP {r.status_code}).")
    return r.text.replace("\r", "")[:max_chars]
