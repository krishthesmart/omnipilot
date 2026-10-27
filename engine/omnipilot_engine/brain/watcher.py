"""WatcherPilot's rules engine: given the parent's focus policy ("learn math, no AI"), decides whether a page
may load. The browser extension asks for every navigation (and hard-blocks AI sites by itself, so blocking
keeps working if OmniPilot isn't running). Changes need the parent PIN (scrypt-hashed, compatible with the
TypeScript engine's); 5 wrong PINs lock changes for 5 minutes. (Ported from server/src/lib/watcher.ts.)"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import unquote, urlsplit

from .. import llm, store

F = re.I | re.A
SUBJECTS = ["math", "reading", "writing", "science", "coding", "history", "languages"]
DEFAULT_POLICY = {"active": False, "task": "", "subject": None, "blockAI": True, "blockAIExtensions": True, "onTaskOnly": True, "allow": [], "block": [], "until": None}
AI_DOMAINS = [
    "chatgpt.com", "chat.openai.com", "openai.com", "claude.ai", "gemini.google.com", "bard.google.com", "aistudio.google.com",
    "notebooklm.google.com", "copilot.microsoft.com", "perplexity.ai", "poe.com", "character.ai", "you.com", "phind.com",
    "deepseek.com", "chat.mistral.ai", "huggingface.co", "meta.ai", "grok.com", "x.ai", "chat.qwen.ai", "kimi.com", "pi.ai",
    "quillbot.com", "jasper.ai", "writesonic.com", "copy.ai", "rytr.me", "chatpdf.com", "humata.ai", "monica.im", "merlin.foyer.work",
    "photomath.com", "mathway.com", "symbolab.com", "gauthmath.com", "brainly.com", "chegg.com", "socratic.org", "wolframalpha.com",
    "mathgptpro.com", "studyx.ai", "answer.ai", "questionai.com", "homeworkify.net",
]
AI_PATHS = [("bing.com", re.compile(r"^\/(chat|copilot)")), ("google.com", re.compile(r"[?&]udm=50\b"))]
DISTRACTIONS = [
    "tiktok.com", "instagram.com", "snapchat.com", "facebook.com", "x.com", "twitter.com", "reddit.com", "discord.com", "twitch.tv",
    "netflix.com", "disneyplus.com", "hulu.com", "roblox.com", "fortnite.com", "epicgames.com", "steampowered.com", "minecraft.net",
    "poki.com", "crazygames.com", "coolmathgames.com", "friv.com", "miniclip.com", "pinterest.com", "9gag.com",
]
SUBJECT_SITES = {
    "math": ["khanacademy.org", "desmos.com", "geogebra.org", "mathsisfun.com", "ixl.com", "prodigygame.com", "mathplayground.com", "brilliant.org", "purplemath.com", "zearn.org"],
    "reading": ["khanacademy.org", "readworks.org", "commonlit.org", "newsela.com", "epic.com", "gutenberg.org", "storylineonline.net"],
    "writing": ["khanacademy.org", "docs.google.com", "readwritethink.org", "owl.purdue.edu", "merriam-webster.com", "thesaurus.com"],
    "science": ["khanacademy.org", "phet.colorado.edu", "nasa.gov", "ck12.org", "sciencebuddies.org", "nationalgeographic.com", "britannica.com"],
    "coding": ["code.org", "scratch.mit.edu", "khanacademy.org", "developer.mozilla.org", "w3schools.com", "freecodecamp.org", "replit.com"],
    "history": ["khanacademy.org", "britannica.com", "loc.gov", "history.com", "smithsonianmag.com", "nationalgeographic.com"],
    "languages": ["duolingo.com", "khanacademy.org", "wordreference.com", "spanishdict.com", "busuu.com"],
}
SUBJECT_WORDS = {
    "math": re.compile(r"\b(math|maths|algebra|geometry|fraction|decimal|multipl|divis|addition|subtract|equation|arithmetic|calculus|trigonometry|percent|graph|number|times table|integer|ratio|statistic|probability)", F),
    "reading": re.compile(r"\b(reading|read aloud|story|stories|book|novel|poem|poetry|comprehension|vocabulary|phonics)", F),
    "writing": re.compile(r"\b(writing|essay|grammar|paragraph|spelling|punctuation|dictionary|thesaurus)", F),
    "science": re.compile(r"\b(science|biology|chemistry|physics|experiment|planet|cell|atom|ecosystem|photosynthesis|energy|earth|weather)", F),
    "coding": re.compile(r"\b(coding|programming|code|javascript|python|scratch|html|css|algorithm)", F),
    "history": re.compile(r"\b(history|historical|ancient|war|revolution|civilization|president|empire|timeline)", F),
    "languages": re.compile(r"\b(spanish|french|german|chinese|japanese|language|vocabulary|grammar|conjugat)", F),
}
SEARCH_ENGINES = ["google.com", "bing.com", "duckduckgo.com", "search.yahoo.com", "kiddle.co"]
AI_EXTENSION_PATTERN = "\\b(chatgpt|gpt|openai|gemini|copilot|claude|perplexity|monica|merlin|sider|maxai|harpa|quillbot|grammarly|photomath|gauth|brainly|ai (assistant|writer|chat|tutor|helper|homework))\\b|\\bAI\\b"
PIN_FORMAT = re.compile(r"^\d{4,8}$")


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_focus_request(text: str, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    subject = next((s for s in SUBJECTS if re.search(rf"\b{s}", text, F) or SUBJECT_WORDS[s].search(text)), None)
    no_ai = bool(re.search(r"\bno (ai|a\.i\.|chatgpt|chat ?bots?)\b|\bblock (all )?ai\b|\bwithout ai\b", text, F))
    m = re.search(r"\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b", text, F)
    minutes = (float(m.group(1)) * 60 if m.group(2)[0].lower() == "h" else float(m.group(1))) if m else None
    task = re.search(r"\b(learn|study|practice|do|work on|focus on|read|write)\b[^,.;]*?(?=\s+(?:and|but|with|for)\s+(?:no|without|block|\d)|[,.;]|\Z)", text, F)
    return {"task": (task.group(0) if task else (f"learn {subject}" if subject else text)).strip()[:120], "subject": subject,
            "blockAI": no_ai or DEFAULT_POLICY["blockAI"], "onTaskOnly": True, "until": _iso(now + timedelta(minutes=minutes)) if minutes else None}


def _row() -> dict | None:
    return store.q1("SELECT data, pin_hash, updated_at FROM watcher_policy WHERE id = 1")


def get_policy() -> dict:
    row = _row()
    policy = {**DEFAULT_POLICY, **json.loads(row["data"])} if row else dict(DEFAULT_POLICY)
    if policy["active"] and policy["until"]:
        try:
            if datetime.fromisoformat(policy["until"].replace("Z", "+00:00")) <= datetime.now(timezone.utc):
                policy["active"] = False
        except ValueError:
            pass
    return policy


def has_pin() -> bool:
    return bool((_row() or {}).get("pin_hash"))


def _hash_pin(pin: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    return f"{salt}:{hashlib.scrypt(pin.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32).hex()}"


_failed: list[float] = []
LOCK_WINDOW_S = 300


def pin_locked() -> bool:
    global _failed
    _failed = [t for t in _failed if time.monotonic() - t < LOCK_WINDOW_S]
    return len(_failed) >= 5


def verify_pin(pin: str) -> bool:
    stored = (_row() or {}).get("pin_hash")
    if not stored or pin_locked():
        return False
    salt, want = stored.split(":", 1)
    ok = hmac.compare_digest(_hash_pin(pin, salt).split(":", 1)[1], want)
    if not ok:
        _failed.append(time.monotonic())
    return ok


_verdicts: dict[str, dict] = {}


def save_policy(policy: dict, pin: str, new_pin: str | None = None) -> dict:
    row = _row()
    if row and row["pin_hash"]:
        if pin_locked():
            return {"ok": False, "error": "locked"}
        if not verify_pin(pin):
            return {"ok": False, "error": "wrong_pin"}
    elif not PIN_FORMAT.match(pin):
        return {"ok": False, "error": "pin_required"}
    to_store = new_pin if new_pin and PIN_FORMAT.match(new_pin) else (None if row and row["pin_hash"] else pin)
    pin_hash = _hash_pin(to_store) if to_store else row["pin_hash"]
    store.x("INSERT INTO watcher_policy (id, data, pin_hash, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, pin_hash = excluded.pin_hash, updated_at = excluded.updated_at",
            json.dumps(policy), pin_hash, store.now())
    _verdicts.clear()
    return {"ok": True}


def log_event(url: str, title: str, decision: str, reason: str) -> None:
    store.x("INSERT INTO watcher_events (at, url, title, decision, reason) VALUES (?, ?, ?, ?, ?)", store.now(), url[:500], (title or "")[:200], decision, reason)
    store.x("DELETE FROM watcher_events WHERE id <= (SELECT MAX(id) - 1000 FROM watcher_events)")


def list_events(limit: int = 50) -> list[dict]:
    return store.q("SELECT at, url, title, decision, reason FROM watcher_events ORDER BY id DESC LIMIT ?", limit)


def _host_matches(host: str, domains: list[str]) -> str | None:
    return next((d for d in domains if host == d or host.endswith(f".{d}")), None)


SAFE_PROTOCOLS = re.compile(r"^(chrome-extension|moz-extension|edge-extension|about|data|blob|file):", re.I)
BROWSER_SETTINGS = re.compile(r"^(chrome|edge|brave|opera|vivaldi):\/\/(extensions|settings\/(reset|clearBrowserData))|^about:(addons|debugging|config)", re.I)
VERDICT_SCHEMA = {"type": "object", "properties": {"on_task": {"type": "boolean"}}, "required": ["on_task"]}


async def classify_page(policy: dict, raw_url: str, title: str = "") -> dict:
    if not policy["active"]:
        return {"decision": "allow", "reason": "No focus session is running.", "category": "inactive"}
    if BROWSER_SETTINGS.search(raw_url):
        return {"decision": "block", "reason": "Browser extension settings are locked during focus time. Ask a parent.", "category": "settings"}
    if SAFE_PROTOCOLS.search(raw_url) or re.search(r"^(chrome|edge|brave|opera|vivaldi):\/\/", raw_url, re.I):
        return {"decision": "allow", "reason": "Browser page.", "category": "safe"}
    try:
        u = urlsplit(raw_url)
        if not re.match(r"^[a-z][a-z0-9+.-]*$", u.scheme or "", re.I):  # like JavaScript's URL: any scheme, but not relative text
            raise ValueError
    except ValueError:
        return {"decision": "allow", "reason": "Not a web page.", "category": "safe"}
    host = re.sub(r"^www\.", "", (u.hostname or "").lower())
    path_search = (u.path or "/") + (f"?{u.query}" if u.query else "")
    if host in ("localhost", "127.0.0.1"):
        return {"decision": "allow", "reason": "OmniPilot.", "category": "safe"}
    if _host_matches(host, policy["block"]):
        return {"decision": "block", "reason": f"A parent blocked {host}.", "category": "parent_rule"}
    if _host_matches(host, policy["allow"]):
        return {"decision": "allow", "reason": f"A parent allowed {host}.", "category": "parent_rule"}
    if policy["blockAI"]:
        ai = _host_matches(host, AI_DOMAINS) or next((h for h, p in AI_PATHS if (host == h or host.endswith(f".{h}")) and p.search(path_search)), None)
        if ai:
            return {"decision": "block", "reason": f"AI tools and answer solvers are off for \"{policy['task']}\".", "category": "ai"}
    if not policy["onTaskOnly"]:
        return {"decision": "allow", "reason": "Only AI tools are blocked right now.", "category": "on_task"}
    if _host_matches(host, DISTRACTIONS):
        return {"decision": "block", "reason": f"{host} isn't part of \"{policy['task']}\".", "category": "distraction"}
    if policy["subject"] and _host_matches(host, SUBJECT_SITES[policy["subject"]]):
        return {"decision": "allow", "reason": f"{host} is a {policy['subject']} learning site.", "category": "on_task"}
    if _host_matches(host, SEARCH_ENGINES):
        return {"decision": "allow", "reason": "Search is allowed; the pages it leads to are checked.", "category": "safe"}
    text = f"{host} {re.sub(r'[/_+-]', ' ', unquote(path_search))} {title}"
    if policy["subject"] and SUBJECT_WORDS[policy["subject"]].search(text):
        return {"decision": "allow", "reason": f"This page looks like {policy['subject']}.", "category": "on_task"}
    key = f"{host}|{title}|{policy['task']}"
    if key in _verdicts:
        return _verdicts[key]
    verdict = await llm.generate_json(
        "You help a parent keep a child focused. Decide whether this web page is useful for the child's assigned task. "
        "Games, social media, entertainment and chatting are not on task. Answer on_task: true only if the page clearly helps with the task.",
        f"Assigned task: {policy['task']}\nPage: {host}\nTitle: {title or '(unknown)'}\nURL path: {u.path or '/'}", schema=VERDICT_SCHEMA, temperature=0, max_tokens=20)
    if isinstance(verdict, dict) and verdict.get("on_task"):
        decision = {"decision": "allow", "reason": f"This page looks useful for \"{policy['task']}\".", "category": "on_task"}
    else:
        decision = {"decision": "block", "reason": f"This page doesn't look like part of \"{policy['task']}\". A parent can allow it.", "category": "off_task"}
    if isinstance(verdict, dict):
        _verdicts[key] = decision
    return decision
