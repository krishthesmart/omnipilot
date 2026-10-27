"""Multi-turn memory: "make it faster", "now in JavaScript" or "why?" refer back to the previous answer.
The last 10 turns per conversation are kept (same table as the TypeScript engine), older than 30 days are
pruned, and a follow-up is rewritten to stand alone before routing."""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

from .. import llm, store
from .specs import rx

MAX_TURNS = 10

FOLLOW_UP = rx(r"^(and|also|now|then|but|so|ok|okay|what about|how about|why|how come|can you|could you|make|do|try|again|instead|same)\b|\b(it|that|this|these|those|them|its|the (code|function|answer|above|last|previous|one)|(first|second|third|last|other|next) (one|issue|step|part)|instead|again|more|less|shorter|longer|simpler|faster)\b")


def ensure_tables() -> None:
    store.conn()  # tables are created with the connection (store.SCHEMA)


def get_turns(conversation_id: str) -> list[dict]:
    ensure_tables()
    return [json.loads(r["data"]) for r in store.q("SELECT data FROM conversation_turns WHERE conversation_id = ? ORDER BY id ASC", conversation_id)]


def append_turn(conversation_id: str, turn: dict) -> None:
    ensure_tables()
    store.x("INSERT INTO conversation_turns (conversation_id, at, data) VALUES (?, ?, ?)", conversation_id, store.now(), json.dumps({k: v for k, v in turn.items() if v is not None}))
    store.x("DELETE FROM conversation_turns WHERE conversation_id = ? AND id NOT IN (SELECT id FROM conversation_turns WHERE conversation_id = ? ORDER BY id DESC LIMIT ?)", conversation_id, conversation_id, MAX_TURNS)


def prune(max_age_days: int = 30) -> None:
    ensure_tables()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=max_age_days)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    store.x("DELETE FROM conversation_turns WHERE at < ?", cutoff)


def looks_like_follow_up(message: str, previous: dict | None) -> bool:
    if not previous:
        return False
    if previous.get("status") == "needs_clarification":
        return True
    return len(message.strip().split()) <= 14 and bool(FOLLOW_UP.search(message))


REWRITE_SYSTEM = ("Rewrite the user's latest message as ONE standalone request that makes sense without the conversation, "
                  "by filling in what 'it/that/this' refers to from the previous turn. Keep the user's intent and wording; do not answer it. "
                  "If the latest message already stands alone, return it unchanged.")
REWRITE_SCHEMA = {"type": "object", "properties": {"request": {"type": "string"}}, "required": ["request"]}
REWRITE_EXAMPLES = [
    {"user": 'Previous request: "Write a python function that returns the nth prime number"\nLatest message: "now do it in javascript"', "assistant": json.dumps({"request": "Write a javascript function that returns the nth prime number"})},
    {"user": 'Previous request: "Explain photosynthesis for a 5th grader"\nLatest message: "make a harder quiz on that"', "assistant": json.dumps({"request": "Make a harder quiz on photosynthesis for a 5th grader"})},
    {"user": 'Previous request: "Check my code for security bugs"\nPrevious answer (start): "- [CRITICAL] SQL injection at login.js:9 ...\n- [HIGH] Hardcoded API key at config.js:3 ..."\nLatest message: "how do I fix the first one?"', "assistant": json.dumps({"request": "How do I fix the SQL injection at login.js:9?"})},
    {"user": 'Previous request: "Check my code for security bugs"\nOmniPilot asked: "Which file should I check?"\nLatest message: "the login handler"', "assistant": json.dumps({"request": "Check the login handler code for security bugs"})},
]
STOP = set("the and you how can one for are was not but its now why did get our out use who what when that this with have them then make does into about tell please could would should also again instead".split())


def _content_words(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) > 2 and w not in STOP]


def _keeps_words(message: str, candidate: str) -> bool:
    ws = _content_words(message)
    if not ws:
        return True
    lower = candidate.lower()
    return sum(1 for w in ws if w[:5] in lower) / len(ws) >= 0.6


async def resolve_follow_up(message: str, turns: list[dict]) -> str:
    previous = turns[-1] if turns else None
    if not looks_like_follow_up(message, previous):
        return message
    asked = f'\nOmniPilot asked: "{previous["clarifyingQuestion"]}"' if previous.get("clarifyingQuestion") else ""
    answer = f'\nPrevious answer (start): "{previous["answer"][:700]}"' if previous.get("answer") else ""
    out = await llm.generate_json(REWRITE_SYSTEM, f'Previous request: "{previous["standalone"]}"{asked}{answer}\nLatest message: "{message}"',
                                  schema=REWRITE_SCHEMA, examples=REWRITE_EXAMPLES, temperature=0, max_tokens=120)
    candidate = (out or {}).get("request", "").strip() if isinstance(out, dict) else ""
    if candidate and len(candidate) <= 600 and _keeps_words(message, candidate):
        return candidate
    if len(_content_words(message)) >= 3 and previous.get("status") != "needs_clarification":
        return message
    return f'{message} (following up on: "{previous["standalone"]}")'


def previous_turn_context(turns: list[dict]) -> dict | None:
    if not turns:
        return None
    p = turns[-1]
    return {"request": p["standalone"], "answer": (p.get("answer") or "")[:2500]}


def history_context(turns: list[dict], n: int = 6) -> list[dict]:
    """The last few turns, for questions about the conversation itself ("what's my name?", "what did I ask?")."""
    return [{"request": t["request"], "answer": (t.get("answer") or "")[:600]} for t in turns[-n:]]


# --- chat history for the sidebar (conversation_runs) ---


def add_conversation_run(conversation_id: str, run_id: str, request: str) -> None:
    store.x("INSERT OR IGNORE INTO conversation_runs (run_id, conversation_id, request, at) VALUES (?, ?, ?, ?)", run_id, conversation_id, request[:4000], store.now())


def list_conversations(limit: int = 100) -> list[dict]:
    return store.q("""SELECT conversation_id AS id,
        (SELECT request FROM conversation_runs f WHERE f.conversation_id = c.conversation_id ORDER BY at ASC LIMIT 1) AS title,
        COUNT(*) AS turns, MAX(at) AS updatedAt
        FROM conversation_runs c GROUP BY conversation_id ORDER BY updatedAt DESC LIMIT ?""", limit)


def conversation_runs(conversation_id: str) -> list[dict]:
    return store.q("SELECT run_id AS runId, request, at FROM conversation_runs WHERE conversation_id = ? ORDER BY at ASC", conversation_id)


def delete_conversation(conversation_id: str) -> int:
    runs = conversation_runs(conversation_id)
    for r in runs:
        store.x("DELETE FROM runs WHERE id = ?", r["runId"])
    store.x("DELETE FROM conversation_runs WHERE conversation_id = ?", conversation_id)
    ensure_tables()
    store.x("DELETE FROM conversation_turns WHERE conversation_id = ?", conversation_id)
    return len(runs)
