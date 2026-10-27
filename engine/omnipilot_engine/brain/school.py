"""SchoolPilot's memory: assignments, projects and tests with due dates, in the local database (same table
as the TypeScript engine). Dates are worked out here, never by the model: "Friday", "tomorrow", "next
Thursday", "in 3 days", "Oct 30", "10/30", "2026-10-30". (Ported from server/src/lib/school.ts, including
JavaScript's Date rules, e.g. "Feb 31" rolls over into March.)"""
from __future__ import annotations

import json
import re
from datetime import date, timedelta

from .. import store
from .agents.jsfmt import js_round

DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]


def today() -> date:
    return date.today()


def iso(d: date) -> str:
    return d.isoformat()


def from_iso(s: str) -> date:
    y, m, d = (int(x) for x in s.split("-"))
    return js_date(y, m - 1, d)


def js_date(y: int, month0: int, day: int) -> date:
    """new Date(y, month0, day): months and days overflow into the next ones, like JavaScript."""
    y += month0 // 12
    month0 %= 12
    return date(y, month0 + 1, 1) + timedelta(days=day - 1)


def _js_weekday(d: date) -> int:
    return (d.weekday() + 1) % 7  # Sunday = 0


def label(d: date) -> str:
    """toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })."""
    return f"{d:%a}, {d:%b} {d.day}"


def parse_due_date(text: str, now: date | None = None) -> str | None:
    t, td = text.lower(), now or today()
    if re.search(r"\b(today|tonight)\b", t):
        return iso(td)
    if re.search(r"\bday after tomorrow\b", t):
        return iso(td + timedelta(days=2))
    if re.search(r"\btomorrow\b", t):
        return iso(td + timedelta(days=1))
    if m := re.search(r"\bin (\d{1,3}|a|one|two|three|four|five|six|seven) (day|week)s?\b", t):
        n = int({"a": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7}.get(m.group(1), m.group(1)))
        return iso(td + timedelta(days=n * 7 if m.group(2) == "week" else n))
    if re.search(r"\bnext week\b", t):
        return iso(td + timedelta(days=7))
    if m := re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", t):
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    months = "|".join(MONTHS)
    mf = re.search(rf"\b({months})[a-z]*\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?\b", t)
    df = re.search(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?({months})[a-z]*\b", t)
    md = (MONTHS.index(mf.group(1)), int(mf.group(2))) if mf else (MONTHS.index(df.group(2)), int(df.group(1))) if df else None
    slash = re.search(r"\b(\d{1,2})\/(\d{1,2})\b", t)
    md2 = md or ((int(slash.group(1)) - 1, int(slash.group(2))) if slash and int(slash.group(1)) <= 12 else None)
    if md2 and 1 <= md2[1] <= 31 and md2[0] >= 0:
        d = js_date(td.year, md2[0], md2[1])
        if d < td:
            d = js_date(td.year + 1, md2[0], md2[1])
        return iso(d)
    if m := re.search(rf"\b(next |this |on )?({'|'.join(DAYS)})\b", t):
        diff = (DAYS.index(m.group(2)) - _js_weekday(td) + 7) % 7 or 7
        return iso(td + timedelta(days=diff))
    return None


def days_until(due: str, now: date | None = None) -> int:
    return (from_iso(due) - (now or today())).days


def when_text(due: str, now: date | None = None) -> str:
    n = days_until(due, now)
    lab = label(from_iso(due))
    if n < 0:
        return f"{-n} day{'' if n == -1 else 's'} overdue ({lab})"
    if n == 0:
        return f"today ({lab})"
    if n == 1:
        return f"tomorrow ({lab})"
    return f"in {n} days ({lab})"


def schedule_steps(steps: list[str], due: str, now: date | None = None) -> list[dict]:
    td = now or today()
    total = max(0, days_until(due, td))
    if not steps:
        return []
    last = max(0, total - 1)
    return [{"date": iso(td + timedelta(days=last if len(steps) == 1 else js_round(i * last / (len(steps) - 1)))), "text": s} for i, s in enumerate(steps)]


def study_days(due: str, now: date | None = None) -> list[str]:
    td = now or today()
    total = days_until(due, td)
    if total <= 0:
        return [iso(td)]
    offsets = sorted({o for o in (total - 1, total - 2, total - 4, total - 7, total - 11) if o >= 0})
    return [iso(td + timedelta(days=o)) for o in offsets]


def _task(r: dict) -> dict:
    return {"id": r["id"], "title": r["title"], "subject": r["subject"], "kind": r["kind"], "due": r["due"], "steps": json.loads(r["steps"]), "done": bool(r["done"])}


def add_task(title: str, subject: str | None, kind: str, due: str, steps: list[dict]) -> dict:
    store.x("INSERT INTO school_tasks (title, subject, kind, due, steps, done, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)", title, subject, kind, due, json.dumps(steps, ensure_ascii=False), store.now())
    return _task(store.q1("SELECT * FROM school_tasks ORDER BY id DESC LIMIT 1"))


def list_tasks(include_done: bool = False) -> list[dict]:
    return [_task(r) for r in store.q(f"SELECT * FROM school_tasks {'' if include_done else 'WHERE done = 0'} ORDER BY due, id")]


def set_done(id: int, done: bool = True) -> None:
    store.x("UPDATE school_tasks SET done = ? WHERE id = ?", 1 if done else 0, id)


def delete_task(id: int) -> None:
    store.x("DELETE FROM school_tasks WHERE id = ?", id)


IGNORE = {"the", "and", "for", "with", "done", "finished", "mark", "completed", "turned", "submitted", "my", "homework", "delete", "remove"}


def find_task(text: str) -> dict | None:
    words = {w for w in re.split(r"[^a-z0-9]+", text.lower()) if len(w) > 2 and w not in IGNORE}
    best = None
    for task in list_tasks():
        score = sum(1 for w in re.split(r"[^a-z0-9]+", f"{task['title']} {task['subject'] or ''}".lower()) if w in words)
        if score > 0 and (not best or score > best[1]):
            best = (task, score)
    return best[0] if best else None
