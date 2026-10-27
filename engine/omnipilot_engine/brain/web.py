"""Read-only web tools for one agent attempt: search and page reading through OmniPilot's tool router (one
service per call, cached, retried), with limits on calls, time and how much is read, and public pages only
(never localhost, private networks or cloud metadata). Page text is untrusted data. (Ported from
server/src/lib/web/webTools.ts.)"""
from __future__ import annotations

import ipaddress
import re
import time
from urllib.parse import urlsplit

from .. import store
from ..tools import router
from ..tools.base import Budget, ToolError

DEFAULT_LIMITS = {"maxCalls": 10, "deadlineS": 90, "maxCharsPerPage": 12_000, "maxTotalChars": 60_000}


class WebToolError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code  # not_configured | budget | blocked_url | timeout | failed | stopped


def check_url(raw: str) -> str:
    try:
        u = urlsplit(raw)
    except ValueError:
        raise WebToolError("blocked_url", "not a valid URL")
    if u.scheme not in ("http", "https") or not u.hostname:
        raise WebToolError("blocked_url", "only http(s) pages")
    if u.username or u.password:
        raise WebToolError("blocked_url", "URLs with credentials aren't allowed")
    try:
        port = u.port
    except ValueError:
        raise WebToolError("blocked_url", "not a valid URL")
    if port and port not in (80, 443):
        raise WebToolError("blocked_url", "only standard ports")
    host = u.hostname.lower().strip("[]")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".lan")) or ("." not in host and ip is None):
        raise WebToolError("blocked_url", "local and internal hosts aren't allowed")
    if ip and (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_reserved or (ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10"))):
        raise WebToolError("blocked_url", "private network addresses aren't allowed")
    if host in ("metadata.google.internal", "169.254.169.254"):
        raise WebToolError("blocked_url", "cloud metadata addresses aren't allowed")
    return raw


def clean_text(text: str) -> str:
    kept = re.sub(r"!\[The ([^\],]{2,40}?) logo\b[^\]]*\]\([^)]*\)", r"\1", re.sub(r"<!--[\s\S]*?-->", "", text), flags=re.I)
    lines = [l.rstrip() for l in kept.split("\n")]
    lines = [l for l in lines if l.strip() and not re.match(r"^\s*(!?\[[^\]]*\]\([^)]*\)\s*)+$", l) and not re.match(r"^\s*[-*]\s*!?\[[^\]]*\]\([^)]*\)\s*$", l)]
    out = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", re.sub(r"!\[[^\]]*\]\([^)]*\)", "", "\n".join(lines)))
    lines = [re.sub(r"\s*\\$", "", l).rstrip() for l in out.split("\n")]
    lines = [l for l in lines if l.strip() and not re.match(r"^(Play|Pause) silent looping video", l.strip(), re.I)]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines))


NAV_WORDS = set("filter by resources resource more about us support help menu contact overview outreach initiatives research technology careers blog news products product home and our see all explore discover learn sign in search new ways follow privacy terms cookies skip to content main navigation".split())


def is_nav_label(label: str) -> bool:
    return all(w in NAV_WORDS for w in re.split(r"[^a-z]+", label.lower()) if w)


def headings(text: str, max_n: int = 60) -> list[str]:
    out: dict[str, None] = {}
    for m in re.finditer(r"^#{1,6}\s+(.+)$", text, re.M):
        h = re.sub(r"[*_`]", "", m.group(1)).strip()
        if len(h) >= 2 and len(h.split()) <= 4 and not is_nav_label(h):
            out.setdefault(h)
    return list(out)[:max_n]


def available() -> bool:
    return any(router.PROVIDERS[p].configured() for p in router.ROUTES["web_search"])


class WebTools:
    def __init__(self, run_id: str, agent: str, stop=None, limits: dict | None = None):
        self.run_id, self.agent, self.stop = run_id, agent, stop
        self.limits = {**DEFAULT_LIMITS, **(limits or {})}
        self.calls = self.chars = 0
        self.started = time.monotonic()

    def _take(self) -> float:
        if self.stop is not None and self.stop.is_set():
            raise WebToolError("stopped", "the run was stopped")
        if self.calls >= self.limits["maxCalls"]:
            raise WebToolError("budget", f"web tool limit reached ({self.limits['maxCalls']} calls)")
        left = self.limits["deadlineS"] - (time.monotonic() - self.started)
        if left <= 1:
            raise WebToolError("budget", "web tool time limit reached")
        if self.chars >= self.limits["maxTotalChars"]:
            raise WebToolError("budget", "web tool reading limit reached")
        self.calls += 1
        return left

    def _bound(self, text: str) -> tuple[str, bool]:
        room = max(0, min(self.limits["maxCharsPerPage"], self.limits["maxTotalChars"] - self.chars))
        out = text[:room]
        self.chars += len(out)
        return out, len(out) < len(text)

    @staticmethod
    def _error(err: Exception) -> WebToolError:
        if isinstance(err, WebToolError):
            return err
        code = getattr(err, "code", "failed")
        return WebToolError("timeout" if code == "timeout" else "not_configured" if code == "unavailable" else "failed", str(err)[:160])

    async def search(self, query: str, num: int = 5) -> list[dict]:
        q = query.strip()[:200]
        left = self._take()
        t0 = time.monotonic()
        try:
            out = await router.run("web_search", {"query": q, "count": min(num, 10)}, Budget(max_calls=2, deadline_s=min(20, left)))
        except (ToolError, Exception) as err:  # noqa: BLE001
            e = self._error(err)
            store.audit(self.run_id, self.agent, "web_search", {"query": q, "ms": int((time.monotonic() - t0) * 1000)}, f"failed: {e.code}")
            raise e
        results = []
        for r in out.get("results") or []:
            try:
                check_url(r["url"])
                results.append(r)
            except WebToolError:
                pass
        store.audit(self.run_id, self.agent, "web_search", {"query": q, "results": len(results), "provider": out.get("provider"), "ms": int((time.monotonic() - t0) * 1000)}, "completed")
        return results

    async def read_page(self, raw_url: str) -> dict:
        url = check_url(raw_url)
        left = self._take()
        t0 = time.monotonic()
        host = urlsplit(url).hostname
        try:
            out = await router.run("read_page", {"url": url}, Budget(max_calls=2, deadline_s=min(40, left)))
        except (ToolError, Exception) as err:  # noqa: BLE001
            e = self._error(err)
            store.audit(self.run_id, self.agent, "web_fetch", {"url": f"{host}{urlsplit(url).path}"[:200]}, f"failed: {e.code}")
            raise e
        cleaned = clean_text(out.get("markdown") or "")
        m = re.search(r"^#\s+(.+)$", cleaned, re.M)
        title = m.group(1).strip()[:200] if m else host
        text, truncated = self._bound(cleaned)
        store.audit(self.run_id, self.agent, "web_fetch", {"url": f"{host}{urlsplit(url).path}"[:200], "chars": len(text), "provider": out.get("provider"), "ms": int((time.monotonic() - t0) * 1000)}, "completed")
        return {"url": out.get("url") or url, "title": title, "text": text, "via": "fetch", "truncated": truncated}
