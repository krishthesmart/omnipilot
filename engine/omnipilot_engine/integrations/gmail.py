"""Gmail, read-only, for free: IMAP with a Google app password. Reading never marks mail as read (the
inbox is opened read-only); the only write is saving a draft, and only when the user approves it."""
from __future__ import annotations

import asyncio
import base64
import imaplib
import json
import re
from datetime import datetime, timezone
from email.header import Header

from .. import store

ADDRESS = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _login(address: str, app_password: str) -> imaplib.IMAP4_SSL:
    m = imaplib.IMAP4_SSL("imap.gmail.com", 993, timeout=15)
    try:
        m.login(address, re.sub(r"\s+", "", app_password))
    except imaplib.IMAP4.error:
        m.logout()
        raise ValueError("Gmail didn't accept that address and app password. Use an app password (not your normal password); see the steps on the Gmail card.")
    return m


async def verify(address: str, app_password: str) -> str:
    if not ADDRESS.match(address):
        raise ValueError("Enter your Gmail address.")

    def run():
        m = _login(address, app_password)
        try:
            typ, data = m.select("INBOX", readonly=True)
            count = int(data[0]) if typ == "OK" else 0
        finally:
            m.logout()
        return f"{address} ({count:,} messages in the inbox)"

    return await asyncio.to_thread(run)


def draft_message(sender: str, to: str, subject: str, body: str) -> bytes:
    lines = [
        f"From: {sender}", f"To: {to}", f"Subject: {Header(subject, 'utf-8').encode()}",
        f"Date: {datetime.now(timezone.utc).strftime('%a, %d %b %Y %H:%M:%S +0000')}", "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
        base64.encodebytes(body.encode()).decode(),
    ]
    return "\r\n".join(lines).encode()


async def save_draft(p: dict) -> dict:
    c = store.connector_internal("Gmail")
    if not c or c["status"] != "connected" or not c["secret_token"]:
        raise RuntimeError("Gmail isn't connected.")
    creds = json.loads(c["secret_token"])

    def run():
        m = _login(creds["address"], creds["password"])
        try:
            typ, _ = m.append('"[Gmail]/Drafts"', r"(\Draft \Seen)", None, draft_message(creds["address"], p["to"], p["subject"], p["body"]))
            if typ != "OK":
                raise RuntimeError("Couldn't save the draft.")
        finally:
            m.logout()

    await asyncio.to_thread(run)
    return {"ok": True, "message": f"Saved a draft to {p['to']} in Gmail. Open Gmail's Drafts to review and send it.", "url": "https://mail.google.com/mail/u/0/#drafts"}


# --- Reading (read-only: the inbox is opened read-only and messages are fetched with BODY.PEEK) ---

import email as _email
import email.policy as _policy
from email.header import decode_header as _decode_header, make_header as _make_header

_HTML = [(r"(?is)<(style|script)[\s\S]*?</\1>", " "), (r"(?i)<br\s*/?>|</p>|</div>", "\n"), (r"<[^>]+>", " "), (r"&nbsp;", " "), (r"&amp;", "&"), (r"&lt;", "<"), (r"&gt;", ">"), (r"&#39;|&apos;", "'"), (r"&quot;", '"')]


def _strip_html(s: str) -> str:
    for a, b in _HTML:
        s = re.sub(a, b, s)
    return s


def _words(v: str) -> str:
    try:
        return str(_make_header(_decode_header(v or "")))
    except Exception:  # noqa: BLE001 -- a malformed header stays as it is
        return v or ""


def _body_text(msg) -> str:
    part = msg.get_body(preferencelist=("plain", "html")) if msg.is_multipart() else msg
    if part is None:
        return ""
    try:
        text = part.get_content()
    except Exception:  # noqa: BLE001 -- odd charsets: best effort
        payload = part.get_payload(decode=True) or b""
        text = payload.decode("utf-8", errors="replace")
    if not isinstance(text, str):
        return ""
    return _strip_html(text) if part.get_content_type() == "text/html" else text


def connected() -> bool:
    c = store.connector_internal("Gmail")
    return bool(c and c["status"] == "connected")


def credentials() -> tuple[str, str]:
    c = store.connector_internal("Gmail")
    if not c or c["status"] != "connected" or not c["secret_token"]:
        raise RuntimeError("Gmail isn't connected.")
    d = json.loads(c["secret_token"])
    return d["address"], d["password"]


async def read_mail(query: str, limit: int = 12) -> list[dict]:
    """The newest `limit` messages matching a Gmail search ("is:unread newer_than:1d"), read-only."""
    address, password = credentials()

    def run():
        m = _login(address, password)
        try:
            m.select("INBOX", readonly=True)
            typ, data = m.uid("SEARCH", "X-GM-RAW", '"' + query.replace("\\", "\\\\").replace('"', '\\"') + '"')
            if typ != "OK":
                typ, data = m.uid("SEARCH", None, "UNSEEN")
            uids = sorted((int(x) for x in (data[0] or b"").split()), reverse=True)[:limit]
            out = []
            for uid in uids:
                typ, parts = m.uid("FETCH", str(uid), "(UID FLAGS BODY.PEEK[])")
                if typ != "OK" or not parts or not isinstance(parts[0], tuple):
                    continue
                meta, raw = parts[0]
                msg = _email.message_from_bytes(raw, policy=_policy.default)
                text = re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", _body_text(msg).replace("\r", ""))).strip()
                out.append({"uid": uid, "from": _words(msg.get("From", "")), "to": _words(msg.get("To", "")), "subject": _words(msg.get("Subject", "(no subject)")),
                            "date": msg.get("Date", ""), "unread": b"\\Seen" not in meta, "text": text[:2500]})
            return out
        finally:
            m.logout()

    return await asyncio.to_thread(run)
