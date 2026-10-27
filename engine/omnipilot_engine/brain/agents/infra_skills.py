"""InfraPilot's skills, custom agents, routines and calendar, managed in chat:
  "create a skill called start_my_day that checks my calendar for today", "create an agent called SpanishTutor
  that helps me practise Spanish", "run start_my_day every day at 7am", "stop the start_my_day routine",
  "list my skills", "delete the skill start_my_day", "what's on my calendar tomorrow?"
(Ported from server/src/agents/infraSkills.ts.)"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta

from ... import store
from ...api_stage2 import get_skill, parse_time, save_skill, slug
from .. import calendar as cal
from .base import evidence

F = re.I | re.A
CREATE = re.compile(r"\b(create|make|add|save|set up|setup|build|teach you)\b[^.?!]*\b(skill|command|shortcut|agent|routine)\b", F)
LIST = re.compile(r"\b(list|show|what are|which)\b[^.?!]*\b(skills|agents|routines|commands)\b|\bmy (skills|agents|routines)\b", F)
DELETE = re.compile(r"\b(delete|remove|forget)\b[^.?!]*\b(skill|agent|routine|command)\b", F)
STOP_ROUTINE = re.compile(r"\b(stop|pause|turn off|cancel)\b[^.?!]*\broutine\b|\bstop running\b", F)
DAILY = re.compile(r"\b(every ?day|daily|each day|every (morning|evening|night)|each (morning|evening))\b|\broutine\b", F)
CALENDAR = re.compile(r"\b(calendar|agenda|events?|meetings?|appointments?)\b", F)


def name_in(text: str) -> str | None:
    m = re.search(r"\b(?:called|named)\s+[\"“']?\/?([A-Za-z0-9][A-Za-z0-9_ -]{0,38}?)[\"”']?(?=\s+(?:that|to|which|who|for|every|daily|at|and)\b|[.,!?:]|$)", text, F) \
        or re.search(r"(?:^|\s)\/([a-z0-9_-]{2,40})\b", text, F)
    return m.group(1).strip() if m else None


def instructions_in(text: str, name: str | None) -> str | None:
    after = text[text.lower().index(name.lower()) + len(name):] if name else text
    m = re.search(r"\b(?:that|which|who|to)\s+([\s\S]{4,})$", after, F)
    if not m:
        return None
    out = re.sub(r"\b(every ?day|daily|each day|every (morning|evening|night))\b.*$", "", m.group(1), count=1, flags=F | re.S)
    out = re.sub(r"\bat \d{1,2}(:\d{2})?\s*(am|pm)?\b.*$", "", out, count=1, flags=F | re.S).strip()
    return re.sub(r"[.!]+$", "", out) or None


def list_skills() -> list[dict]:
    from ...api_stage2 import _skill

    return [_skill(r) for r in store.q("SELECT * FROM skills ORDER BY kind, name")]


def existing_skill_in(text: str) -> dict | None:
    named = name_in(text)
    if named and get_skill(named):
        return get_skill(named)
    return next((s for s in list_skills() if re.search(rf"\b{s['name'].replace('_', '[ _]')}\b", text, re.I) or re.search(rf"\b{re.escape(s['label'])}\b", text, re.I)), None)


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def schedule_daily(s: dict, time: str) -> None:
    store.x("UPDATE skills SET daily_at = ? WHERE name = ?", time, s["name"])
    if time <= datetime.now().strftime("%H:%M"):
        store.x("UPDATE skills SET last_run_date = ? WHERE name = ?", _today(), s["name"])


def ok(findings: list[str], **extra) -> dict:
    return {"status": "success", "findings": findings, "evidence": [evidence("omnipilot:skills", "skills, agents and routines saved on this computer")], "confidence": 0.95, "limitations": [], "proposedActions": [], **extra}


def describe(s: dict) -> str:
    if s["kind"] == "agent":
        return f"- **{s['label']}** (agent): {s['instructions']} — talk to it with `/{s['name']} …`"
    return f"- **/{s['name']}** (skill): {s['instructions']}" + (f" — runs every day at {s['dailyAt']}" if s["dailyAt"] else "")


async def calendar(input: dict) -> dict:
    conn = store.connector_internal("Google Calendar")
    if not conn or conn["status"] != "connected" or not conn["secret_token"]:
        return {"status": "needs_connection",
                "findings": ["Your calendar is not connected yet. In Google Calendar, open Settings → your calendar → Integrate calendar, copy the **Secret address in iCal format**, and paste it into the **Connect** button on the Google Calendar card above. It's read-only, and the link stays on this computer."],
                "evidence": [evidence("connector:Google Calendar", json.dumps({"name": "Google Calendar", "status": "not_connected", "kind": "calendar", "verification": "token"}, separators=(",", ":")))],
                "confidence": 0.9, "limitations": ["Nothing can read your calendar until you connect it."], "proposedActions": []}
    t = input["requestText"].lower()
    start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    days, label = 1, "today"
    n_days = re.search(r"\bnext (\d{1,2}) days\b", t)
    if re.search(r"\btomorrow\b", t):
        start, label = start + timedelta(days=1), "tomorrow"
    elif n_days:
        days = min(60, int(n_days.group(1)))
        label = f"in the next {days} days"
    elif re.search(r"\b(this|next) month\b|\bmonth\b|\bupcoming\b|\bcoming up\b", t):
        days, label = 30, "in the next 30 days"
    elif re.search(r"\b(this|next) week\b|\bweek\b", t):
        days, label = 7, "in the next 7 days"
    nxt = None
    try:
        ics = await cal.fetch_ics(conn["secret_token"])
        events = cal.events_between(ics, start, days)
        if not events:
            later = cal.events_between(ics, start + timedelta(days=days), 90)
            if later:
                nxt = re.sub(r"^- ", "", cal.event_line(later[0]))
    except Exception as err:  # noqa: BLE001 -- shown to the user
        store.audit(input["runId"], "InfraPilot", "read_calendar", {}, f"failed: {err}")
        return {"status": "unreachable", "findings": [f"I couldn't read your calendar: {err}."], "evidence": [], "confidence": 0.2, "limitations": [], "proposedActions": []}
    store.audit(input["runId"], "InfraPilot", "read_calendar", {"window": label, "events": len(events)}, "completed")
    text = (f"**Your calendar {label}**\n" + "\n".join(cal.event_line(e) for e in events)) if events else f"Nothing on your calendar {label}." + (f" The next thing is {nxt}." if nxt else "")
    return ok([text], evidence=[evidence("connector:Google Calendar", json.dumps({"name": "Google Calendar", "status": "connected", "kind": "calendar", "verification": "token", "accountLabel": conn["account_label"]}, separators=(",", ":"), ensure_ascii=False))])


async def infra_skills(input: dict) -> dict | None:
    original = (input.get("context") or {}).get("originalRequest")
    text = original if isinstance(original, str) and original and CREATE.search(original) else input["requestText"]
    run_id = input["runId"]
    if LIST.search(text):
        all_ = list_skills()
        store.audit(run_id, "InfraPilot", "list_skills", {"count": len(all_)}, "completed")
        return ok([("**Your skills and agents**\n" + "\n".join(describe(s) for s in all_)) if all_ else 'You have no skills or agents yet. Try: "create a skill called start_my_day that checks my calendar for today and what homework is due".'])
    if STOP_ROUTINE.search(text):
        s = existing_skill_in(text)
        if s:
            store.x("UPDATE skills SET daily_at = NULL WHERE name = ?", s["name"])
            store.audit(run_id, "InfraPilot", "stop_routine", {"name": s["name"]}, "completed")
            return ok([f"Stopped the daily routine for **/{s['name']}**. The skill is still there; run it any time with `/{s['name']}`."])
    if DELETE.search(text):
        s = existing_skill_in(text)
        if s:
            store.x("DELETE FROM skills WHERE name = ?", s["name"])
            store.audit(run_id, "InfraPilot", "delete_skill", {"name": s["name"]}, "completed")
            return ok([f"Deleted **{s['label'] if s['kind'] == 'agent' else '/' + s['name']}**."])
        return ok(["I couldn't find that one. Say \"list my skills\" to see them."], status="partial_success", confidence=0.6)
    existing = existing_skill_in(text)
    time = parse_time(text)
    if existing and DAILY.search(text) and not CREATE.search(re.sub(r"\broutine\b", "", text, count=1, flags=re.I)):
        if not time:
            return ok([f"What time should **/{existing['name']}** run each day? For example: \"run {existing['name']} every day at 7am\"."], status="partial_success", confidence=0.6)
        if existing["kind"] == "agent":
            return ok(["Only skills can run as routines; agents answer when you talk to them."], status="partial_success", confidence=0.7)
        schedule_daily(existing, time)
        store.audit(run_id, "InfraPilot", "schedule_routine", {"name": existing["name"], "time": time}, "completed")
        return ok([f"Done: **/{existing['name']}** will run every day at **{time}** while OmniPilot is running. The results appear in your chat history as \"{existing['instructions'][:50]}…\". Say \"stop the {existing['name']} routine\" to turn it off."])
    if CREATE.search(text):
        is_agent = bool(re.search(r"\bagent\b", text, re.I)) and not re.search(r"\bskill\b", text, re.I)
        name = name_in(text)
        instructions = instructions_in(text, name)
        if not name or not instructions:
            return ok(['Tell me its name and what it should do, like: "create an agent called SpanishTutor that helps me practise Spanish conversation and corrects my mistakes".' if is_agent
                       else 'Tell me its name and what it should do, like: "create a skill called start_my_day that checks my calendar for today and what homework is due".'], status="partial_success", confidence=0.6)
        try:
            skill = save_skill(name, name.replace("_", " "), "agent" if is_agent else "skill", instructions)
        except ValueError as err:
            return ok([str(err)], status="partial_success", confidence=0.6)
        daily = time if not is_agent and DAILY.search(text) and time else None
        if daily:
            schedule_daily(skill, daily)
        store.audit(run_id, "InfraPilot", "create_agent" if is_agent else "create_skill", {"name": skill["name"], "daily": daily}, "completed")
        if is_agent:
            return ok([f"Created the agent **{skill['label']}**. Talk to it any time: `/{skill['name']} …` or \"ask {skill['label']} …\"."])
        tail = f"; it also runs every day at **{daily}**" if daily else f" (or say \"run {skill['name']} every day at 7am\" to make it a routine)"
        return ok([f"Created the skill **/{skill['name']}**: \"{skill['instructions']}\". Run it any time by typing `/{skill['name']}`{tail}."])
    if CALENDAR.search(text):
        return await calendar(input)
    return None


__all__ = ["infra_skills", "slug"]
