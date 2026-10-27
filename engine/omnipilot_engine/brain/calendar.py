"""Read-only calendar from an iCal (.ics) link, such as Google Calendar's "Secret address in iCal format". The
link works like a password: kept locally as the connector's secret and fetched only over HTTPS from a public
host. One-off, all-day and the common repeating events (daily/weekly/monthly/yearly with COUNT, UNTIL, BYDAY,
INTERVAL). (Ported from server/src/lib/calendar.ts; times are local, like JavaScript's Date.)"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from ..integrations.services import fetch_ics  # noqa: F401  (HTTPS-only, public hosts, size-limited)

DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]


def unfold(ics: str) -> list[str]:
    return re.split(r"\r?\n", re.sub(r"\r?\n[ \t]", "", ics))


def _unescape(v: str) -> str:
    return re.sub(r"\\([,;\\])", r"\1", re.sub(r"\\n", " ", v, flags=re.I)).strip()


def parse_ics_date(value: str) -> tuple[datetime, bool] | None:
    m = re.match(r"^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$", value.strip())
    if not m:
        return None
    y, mo, d, h, mi, s, z = m.groups()
    if not h:
        return datetime(int(y), int(mo), int(d)), True
    dt = datetime(int(y), int(mo), int(d), int(h), int(mi), int(s or 0))
    if z:
        dt = dt.replace(tzinfo=timezone.utc).astimezone().replace(tzinfo=None)  # shown in local time
    return dt, False


def parse_ics(ics: str) -> list[dict]:
    events, cur = [], None
    for line in unfold(ics):
        if line == "BEGIN:VEVENT":
            cur = {"exdates": set()}
        elif line == "END:VEVENT":
            if cur and cur.get("start"):
                events.append({"title": cur.get("title", "(no title)"), "start": cur["start"], "end": cur.get("end"), "allDay": cur.get("allDay", False),
                               "location": cur.get("location"), "rrule": cur.get("rrule"), "exdates": cur["exdates"]})
            cur = None
        elif cur is not None:
            i = line.find(":")
            if i < 0:
                continue
            key, value = line[:i].split(";")[0].upper(), line[i + 1:]
            if key == "SUMMARY":
                cur["title"] = _unescape(value)[:200]
            elif key == "LOCATION":
                cur["location"] = _unescape(value)[:200] or None
            elif key == "DTSTART":
                if p := parse_ics_date(value):
                    cur["start"], cur["allDay"] = p
            elif key == "DTEND":
                p = parse_ics_date(value)
                cur["end"] = p[0] if p else None
            elif key == "RRULE":
                cur["rrule"] = dict(kv.split("=", 1) if "=" in kv else (kv, None) for kv in value.split(";"))
            elif key == "EXDATE":
                for v in value.split(","):
                    if p := parse_ics_date(v):
                        cur["exdates"].add(p[0])
    return events


def _js_weekday(d: datetime) -> int:
    return (d.weekday() + 1) % 7


def occurrences(e: dict, frm: datetime, to: datetime) -> list[datetime]:
    if not e["rrule"]:
        return [e["start"]] if frm <= e["start"] < to else []
    r = e["rrule"]
    freq = r.get("FREQ")
    try:
        interval = max(1, int(r.get("INTERVAL") or 1))
    except ValueError:
        interval = 1
    until = parse_ics_date(r["UNTIL"])[0] if r.get("UNTIL") and parse_ics_date(r["UNTIL"]) else None
    count = int(r["COUNT"]) if r.get("COUNT") and r["COUNT"].isdigit() else float("inf")
    by_day = [DAY_CODES.index(d) for d in (re.sub(r"^[+-]?\d+", "", x) for x in r["BYDAY"].split(",")) if d in DAY_CODES] if r.get("BYDAY") else None
    out, n = [], 0
    start_day = e["start"].replace(hour=0, minute=0, second=0, microsecond=0)
    day, i = e["start"], 0
    while i < 3700 and day < to:
        if until and day > until:
            break
        since = (day.replace(hour=0, minute=0, second=0, microsecond=0) - start_day).days
        if freq == "DAILY":
            hit = since % interval == 0
        elif freq == "WEEKLY":
            hit = (since // 7) % interval == 0 and (_js_weekday(day) in by_day if by_day else _js_weekday(day) == _js_weekday(e["start"]))
        elif freq == "MONTHLY":
            hit = day.day == e["start"].day and ((day.year - e["start"].year) * 12 + day.month - e["start"].month) % interval == 0
        elif freq == "YEARLY":
            hit = day.day == e["start"].day and day.month == e["start"].month
        else:
            hit = False
        if hit:
            n += 1
            if n > count:
                break
            if day >= frm and day not in e["exdates"]:
                out.append(day)
        day, i = day + timedelta(days=1), i + 1
    return out


def events_between(ics: str, frm: datetime, days: int) -> list[dict]:
    to = frm.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=days)
    out = []
    for e in parse_ics(ics):
        length = e["end"] - e["start"] if e["end"] else None
        for start in occurrences(e, frm, to):
            out.append({"title": e["title"], "start": start, "end": start + length if length is not None else None, "allDay": e["allDay"], "location": e["location"]})
    return sorted(out, key=lambda x: x["start"])[:100]


def calendar_name(ics: str) -> str | None:
    m = re.search(r"^X-WR-CALNAME:(.+)$", ics, re.M)
    return m.group(1).strip()[:80] if m else None


def event_line(e: dict) -> str:
    d = e["start"]
    day = f"{d:%a}, {d:%b} {d.day}"
    time = "all day" if e["allDay"] else f"{d.hour % 12 or 12}:{d.minute:02d} {'AM' if d.hour < 12 else 'PM'}"
    return f"- **{day}, {time}**: {e['title']}" + (f" ({e['location']})" if e.get("location") else "")
