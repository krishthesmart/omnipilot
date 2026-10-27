"""OmniPilot's offline encyclopedia (built once with `npm run knowledge`): the opening paragraphs of every Simple
English Wikipedia article in a full-text index. For factual questions Helper looks the facts up here and the
model answers from them, citing the article; nothing goes online. (Ported from server/src/lib/knowledge.ts.)"""
from __future__ import annotations

import os
import re
import sqlite3

from .. import envfiles

SOURCE = "Simple English Wikipedia (CC BY-SA 4.0)"
STOP = set(("a an the of in on at to for from by with about into over under and or but is are was were be been being do does did "
            "what who whom whose which when where why how many much tell me explain describe give please can could would should "
            "you your i my we our it its this that these those there their they he she his her as than then so if not no yes "
            "know find out called name named kind type sort mean means meaning define definition fact facts").split())
_db: sqlite3.Connection | None = None


def _open() -> sqlite3.Connection | None:
    global _db
    if _db is not None:
        return _db
    path = os.environ.get("OMNIPILOT_KNOWLEDGE") or str(envfiles.ROOT / "server" / "data" / "knowledge.sqlite")
    if not os.path.exists(path):
        return None
    _db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
    return _db


def search_terms(q: str) -> list[str]:
    words = re.split(r"[\W_]+", re.sub(r"['’]s\b", "", q.lower()))
    return list(dict.fromkeys(w for w in words if len(w) > 1 and w not in STOP))[:12]


def _stem(w: str) -> str:
    return re.sub(r"(?<!s)s$", "", re.sub(r"ies$", "y", w))


def look_up(question: str, limit: int = 3) -> list[dict]:
    kb = _open()
    terms = search_terms(question)
    if not kb or not terms:
        return []
    match = " OR ".join('"' + t.replace('"', "") + '"' for t in terms)
    try:
        rows = kb.execute("SELECT title, body, bm25(kb, 8.0, 1.0) AS score FROM kb WHERE kb MATCH ? ORDER BY score LIMIT 25", (match,)).fetchall()
    except sqlite3.Error:
        return []
    stems = {_stem(t) for t in terms}
    ranked = []
    for title, body, score in rows:
        words = [w for w in re.split(r"[\W_]+", re.sub(r"\(.*?\)", "", title).lower()) if w and w not in STOP]
        overlap = sum(1 for w in words if _stem(w) in stems)
        extra = len(words) - overlap
        covered = bool(words) and extra == 0
        if overlap > 0:
            ranked.append({"title": title, "body": body, "rank": overlap * 3 - extra * 2 + (10 if covered else 0) - (4 if re.search(r"\(.*\)", title) else 0) - score * 0.5})
    ranked.sort(key=lambda r: -r["rank"])
    top = ranked[:limit - 1]
    body_hit = next(({"title": t, "body": b} for t, b, _ in rows if not any(x["title"] == t for x in top) and sum(1 for term in terms if term in b.lower()) >= min(3, len(terms))), None)
    picked = top + [body_hit] if body_hit else ranked[:limit]
    return [{"title": r["title"], "text": r["body"]} for r in picked]
