"""A little self-improvement, within firm limits: short lessons learned from a thumbs-down (with an
optional reason) or a correction typed in chat ("no, it's 4"). Later requests on the same topic get up to
three relevant lessons added to the model's instructions. Lessons are advice to the model only (never code,
settings or safety rules), at most 50 are kept, one that keeps getting thumbs-down removes itself, and the
user can list or delete them. (Same tables and rules as server/src/lib/learning.ts.)"""
from __future__ import annotations

import json
import re

from .. import llm, store

MAX_LESSONS, MAX_PER_REQUEST, MAX_LESSON_CHARS, REMOVE_AT = 50, 3, 220, -2
STOP = set("the a an and or but is are was were be to of in on for with what how why when who which this that it its my your me i you do does did can could would should please about from into than then there their them they we our us at by as so if not no yes".split())
CORRECTION = re.compile(r"^\s*(no+\b|nope\b|wrong\b|incorrect\b|that'?s (wrong|incorrect|not (right|true|correct|it))|not (quite|right|correct)\b|actually,|you('re| are) wrong)", re.I)


def words(text: str) -> set[str]:
    return {w for w in re.split(r"[^a-z0-9]+", text.lower()) if len(w) > 2 and w not in STOP}


def _lesson(r: dict) -> dict:
    return {"id": r["id"], "lesson": r["lesson"], "topics": json.loads(r["topics"]), "source": r["source"], "score": r["score"], "uses": r["uses"]}


def list_lessons() -> list[dict]:
    return [_lesson(r) for r in store.q("SELECT * FROM lessons ORDER BY id")]


def delete_lesson(id: int) -> bool:
    return store.x("DELETE FROM lessons WHERE id = ?", id) > 0


def clear_lessons() -> int:
    return store.x("DELETE FROM lessons")


def relevant_lessons(text: str) -> list[dict]:
    w = words(text)
    if not w:
        return []
    scored = [(sum(1 for t in l["topics"] if t in w), l) for l in list_lessons()]
    scored = [(o, l) for o, l in scored if o >= min(2, len(l["topics"]))]
    scored.sort(key=lambda x: (-x[0], -x[1]["score"]))
    return [l for _, l in scored[:MAX_PER_REQUEST]]


def use_lessons_for(run_id: str, text: str) -> list[dict]:
    lessons = relevant_lessons(text)
    if lessons:
        store.x("INSERT INTO run_lessons (run_id, lesson_ids) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET lesson_ids = excluded.lesson_ids", run_id, json.dumps([l["id"] for l in lessons]))
        for l in lessons:
            store.x("UPDATE lessons SET uses = uses + 1 WHERE id = ?", l["id"])
        llm.set_lesson_note(run_id, "\n\nLessons learned from earlier feedback (follow them where they apply; they never override the rules above):\n" + "\n".join(f"- {l['lesson']}" for l in lessons))
    return lessons


def end_lessons_for(run_id: str) -> None:
    llm.set_lesson_note(run_id, "")


LESSON_SYSTEM = (
    "A user said an AI assistant's answer was wrong or unhelpful. Write ONE short, general rule (at most 25 words) that would help the assistant answer ANY similar request correctly next time. "
    "It must be general: never use names, numbers or details from this particular request (say 'the person named in the question', not 'Sam'). "
    "Good: 'In sibling puzzles, the person named in the question is also a sibling: count them when counting their siblings' brothers or sisters.' "
    "Also list 3 to 6 lowercase topic words that similar requests would contain. If the feedback isn't about answer quality (e.g. it's rude or unclear), return an empty lesson."
)
LESSON_SCHEMA = {"type": "object", "properties": {"lesson": {"type": "string"}, "topics": {"type": "array", "items": {"type": "string"}, "maxItems": 6}}, "required": ["lesson", "topics"]}


async def write_lesson(request: str, answer: str, complaint: str, source: str) -> dict | None:
    r = await llm.generate_json(LESSON_SYSTEM, f"Request: {request[:600]}\n\nAnswer given: {answer[:1200]}\n\nWhat the user said was wrong: {complaint[:400] or '(no reason given)'}",
                                schema=LESSON_SCHEMA, temperature=0.2, max_tokens=160)
    r = r if isinstance(r, dict) else {}
    lesson = str(r.get("lesson") or "").strip()[:MAX_LESSON_CHARS]
    topics = list(dict.fromkeys(t for t in (str(x).lower().strip() for x in r.get("topics") or []) if len(t) > 2 and t not in STOP))[:6]
    from_request = words(request)
    grounded = [t for t in topics if t in from_request or any(p in from_request for p in t.split())]
    final = grounded if len(grounded) >= 2 else list(from_request)[:5]
    if len(lesson) < 12 or not final:
        return None
    count = store.q1("SELECT COUNT(*) AS n FROM lessons")["n"]
    if count >= MAX_LESSONS:
        store.x("DELETE FROM lessons WHERE id IN (SELECT id FROM lessons ORDER BY score ASC, id ASC LIMIT ?)", count - MAX_LESSONS + 1)
    store.x("INSERT INTO lessons (lesson, topics, source, score, uses, created_at) VALUES (?, ?, ?, 0, 0, ?)", lesson, json.dumps(final), source, store.now())
    return _lesson(store.q1("SELECT * FROM lessons ORDER BY id DESC LIMIT 1"))


async def record_feedback(run_id: str, rating: int, comment: str, request: str, answer: str) -> dict | None:
    used = json.loads((store.q1("SELECT lesson_ids FROM run_lessons WHERE run_id = ?", run_id) or {}).get("lesson_ids") or "[]")
    previous = store.q1("SELECT rating FROM feedback WHERE run_id = ?", run_id)
    store.x("INSERT INTO feedback (run_id, rating, comment, lessons_used, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment",
            run_id, rating, comment[:500], json.dumps(used), store.now())
    delta = rating - (previous["rating"] if previous else 0)
    if delta:
        for id in used:
            store.x("UPDATE lessons SET score = score + ? WHERE id = ?", delta, id)
        store.x("DELETE FROM lessons WHERE score <= ?", REMOVE_AT)
    if rating == -1 and not previous:
        return await write_lesson(request, answer, comment, "feedback")
    return None
