"""Token-verified services: Slack, GitHub, Notion, Google Calendar (its secret iCal address), and the
write actions approved for them (post a Slack message, open a GitHub issue, add to a Notion page)."""
from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urlparse

import httpx

from .. import store

TIMEOUT = 10


class VerifyFailed(Exception):
    pass


async def _json(method: str, url: str, **kw) -> tuple[int, dict]:
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        try:
            r = await c.request(method, url, **kw)
        except httpx.TimeoutException:
            raise VerifyFailed("the service didn't answer in time")
        except httpx.HTTPError:
            raise VerifyFailed("couldn't reach the service")
        try:
            return r.status_code, r.json()
        except ValueError:
            return r.status_code, {}


async def verify_slack(token: str) -> str:
    _, d = await _json("POST", "https://slack.com/api/auth.test", headers={"Authorization": f"Bearer {token}"})
    if d.get("ok"):
        return f"{d.get('team', 'Slack')} workspace (@{d.get('user', 'unknown')})"
    raise VerifyFailed(d.get("error", "invalid_auth"))


async def verify_github(token: str) -> str:
    s, d = await _json("GET", "https://api.github.com/user", headers={"Authorization": f"Bearer {token}", "User-Agent": "OmniPilot", "Accept": "application/vnd.github+json"})
    if s == 200 and d.get("login"):
        return f"@{d['login']}"
    raise VerifyFailed(d.get("message", f"http_{s}"))


async def verify_notion(token: str) -> str:
    s, d = await _json("GET", "https://api.notion.com/v1/users/me", headers={"Authorization": f"Bearer {token}", "Notion-Version": "2022-06-28"})
    if s == 200:
        return d.get("name") or ((d.get("bot") or {}).get("owner") or {}).get("user", {}).get("name") or "Notion integration"
    raise VerifyFailed(d.get("message", f"http_{s}"))


def _check_public_https(url: str) -> None:
    """Calendar links: https only, and never an address on this computer or the local network."""
    u = urlparse(url.replace("webcal://", "https://", 1))
    if u.scheme != "https" or not u.hostname:
        raise VerifyFailed("use the calendar's https:// (or webcal://) secret address")
    for info in socket.getaddrinfo(u.hostname, 443):
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise VerifyFailed("that address points to a private network")


async def fetch_ics(url: str) -> str:
    _check_public_https(url)
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as c:
        r = await c.get(url.replace("webcal://", "https://", 1))
    if r.status_code != 200 or "BEGIN:VCALENDAR" not in r.text[:2000]:
        raise VerifyFailed("that address didn't return a calendar")
    return r.text[:5_000_000]


async def verify_calendar(link: str) -> str:
    ics = await fetch_ics(link)
    m = re.search(r"^X-WR-CALNAME:(.+)$", ics, re.M)
    return m.group(1).strip() if m else "your calendar"


VERIFIERS = {"Slack": verify_slack, "GitHub": verify_github, "Notion": verify_notion, "Google Calendar": verify_calendar}


# --- approved write actions ---


def _token(name: str) -> str:
    c = store.connector_internal(name)
    if not c or c["status"] != "connected" or not c["secret_token"]:
        raise RuntimeError(f"{name} isn't connected any more. Connect it again, then approve.")
    return c["secret_token"]


async def post_slack_message(p: dict) -> dict:
    _, d = await _json("POST", "https://slack.com/api/chat.postMessage", headers={"Authorization": f"Bearer {_token('Slack')}"}, json={"channel": p["channel"], "text": p["text"]})
    if not d.get("ok"):
        hint = " Invite the OmniPilot app to that channel first (/invite in Slack)." if d.get("error") == "not_in_channel" else " Check the channel name." if d.get("error") == "channel_not_found" else ""
        return {"ok": False, "message": f"Slack said: {d.get('error', 'unknown error')}.{hint}"}
    return {"ok": True, "message": f"Posted to {p['channel']} in Slack."}


async def create_github_issue(p: dict) -> dict:
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", p.get("repo", "")):
        return {"ok": False, "message": f'"{p.get("repo")}" isn\'t a repository name (it should look like owner/repo).'}
    s, d = await _json("POST", f"https://api.github.com/repos/{p['repo']}/issues", headers={"Authorization": f"Bearer {_token('GitHub')}", "User-Agent": "OmniPilot", "Accept": "application/vnd.github+json"}, json={"title": p["title"], "body": p.get("body", "")})
    if s != 201:
        return {"ok": False, "message": f"GitHub said: {d.get('message', f'HTTP {s}')}{' (check the repository name, and that your token can open issues there)' if s == 404 else ''}."}
    return {"ok": True, "message": f"Opened issue #{d.get('number')} in {p['repo']}.", "url": d.get("html_url")}


async def append_to_notion(p: dict) -> dict:
    paragraphs = [t for t in re.split(r"\n{2,}", p["text"]) if t][:50]
    s, d = await _json(
        "PATCH", f"https://api.notion.com/v1/blocks/{p['pageId']}/children",
        headers={"Authorization": f"Bearer {_token('Notion')}", "Notion-Version": "2022-06-28"},
        json={"children": [{"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"type": "text", "text": {"content": t[:2000]}}]}} for t in paragraphs]},
    )
    if s != 200:
        return {"ok": False, "message": f"Notion said: {d.get('message', f'HTTP {s}')}{' (share the page with your OmniPilot integration first)' if s == 404 else ''}."}
    return {"ok": True, "message": f"Added {len(paragraphs)} paragraph{'' if len(paragraphs) == 1 else 's'} to the Notion page.", "url": f"https://www.notion.so/{p['pageId'].replace('-', '')}"}
