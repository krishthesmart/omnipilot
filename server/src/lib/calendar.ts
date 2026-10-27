import { checkUrl } from "./web/webTools.js";

// Read-only calendar from an iCal (.ics) link, such as Google Calendar's "Secret address in iCal
// format" (Settings -> your calendar -> Integrate calendar). The link works like a password: it's
// stored locally as the connector's secret and only ever fetched over HTTPS from a public host.
// Handles one-off events, all-day events and the common repeating rules (daily/weekly/monthly
// with COUNT/UNTIL/BYDAY/INTERVAL).

export interface CalendarEvent {
  title: string;
  start: Date;
  end: Date | null;
  allDay: boolean;
  location: string | null;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 5_000_000;

/** Fetches the .ics text, or throws a plain-words error. */
export async function fetchIcs(url: string): Promise<string> {
  const u = checkUrl(url.trim());
  if (u.protocol !== "https:") throw new Error("The calendar link must start with https://");
  const res = await fetch(u.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow", headers: { Accept: "text/calendar" } });
  if (!res.ok) throw new Error(`The calendar link answered ${res.status}${res.status === 404 ? " (check you copied the whole secret address)" : ""}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error("That calendar is too large to read");
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("That link isn't an iCal calendar (it should end in .ics)");
  return text;
}

/** Joins folded lines (RFC 5545: a line starting with a space continues the previous one). */
const unfold = (ics: string) => ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);

const unescape = (v: string) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

/** 20261017T090000Z (UTC), 20261017T090000 (local), 20261017 (all-day). */
function parseIcsDate(value: string): { date: Date; allDay: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { date: new Date(Number(y), Number(mo) - 1, Number(d)), allDay: true };
  const args = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)] as const;
  return { date: z ? new Date(Date.UTC(...args)) : new Date(...args), allDay: false };
}

interface RawEvent {
  title: string;
  start: Date;
  end: Date | null;
  allDay: boolean;
  location: string | null;
  rrule: Record<string, string> | null;
  exdates: Set<number>;
}

export function parseIcs(ics: string): RawEvent[] {
  const events: RawEvent[] = [];
  let cur: Partial<RawEvent> & { exdates?: Set<number> } | null = null;
  for (const line of unfold(ics)) {
    if (line === "BEGIN:VEVENT") cur = { exdates: new Set() };
    else if (line === "END:VEVENT") {
      if (cur?.start) events.push({ title: cur.title ?? "(no title)", start: cur.start, end: cur.end ?? null, allDay: cur.allDay ?? false, location: cur.location ?? null, rrule: cur.rrule ?? null, exdates: cur.exdates ?? new Set() });
      cur = null;
    } else if (cur) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const key = line.slice(0, i).split(";")[0].toUpperCase();
      const value = line.slice(i + 1);
      if (key === "SUMMARY") cur.title = unescape(value).slice(0, 200);
      else if (key === "LOCATION") cur.location = unescape(value).slice(0, 200) || null;
      else if (key === "DTSTART") {
        const p = parseIcsDate(value);
        if (p) (cur.start = p.date), (cur.allDay = p.allDay);
      } else if (key === "DTEND") cur.end = parseIcsDate(value)?.date ?? null;
      else if (key === "RRULE") cur.rrule = Object.fromEntries(value.split(";").map((kv) => kv.split("=") as [string, string]));
      else if (key === "EXDATE") for (const v of value.split(",")) { const p = parseIcsDate(v); if (p) cur.exdates!.add(p.date.getTime()); }
    }
  }
  return events;
}

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** Every occurrence of the event that starts within [from, to). */
function occurrences(e: RawEvent, from: Date, to: Date): Date[] {
  if (!e.rrule) return e.start >= from && e.start < to ? [e.start] : [];
  const freq = e.rrule.FREQ;
  const interval = Math.max(1, Number(e.rrule.INTERVAL ?? 1));
  const until = e.rrule.UNTIL ? parseIcsDate(e.rrule.UNTIL)?.date ?? null : null;
  const count = e.rrule.COUNT ? Number(e.rrule.COUNT) : Infinity;
  const byDay = e.rrule.BYDAY ? e.rrule.BYDAY.split(",").map((d) => DAY_CODES.indexOf(d.replace(/^[+-]?\d+/, ""))).filter((d) => d >= 0) : null;
  const out: Date[] = [];
  let n = 0;
  const step = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes(), d.getSeconds());
  // Walk day by day (bounded): enough for the short windows OmniPilot asks about.
  for (let day = new Date(e.start), i = 0; i < 3700 && day < to; day = step(day, 1), i++) {
    if (until && day > until) break;
    const daysSince = Math.round((new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() - new Date(e.start.getFullYear(), e.start.getMonth(), e.start.getDate()).getTime()) / 86_400_000);
    let hit = false;
    if (freq === "DAILY") hit = daysSince % interval === 0;
    else if (freq === "WEEKLY") hit = Math.floor(daysSince / 7) % interval === 0 && (byDay ? byDay.includes(day.getDay()) : day.getDay() === e.start.getDay());
    else if (freq === "MONTHLY") hit = day.getDate() === e.start.getDate() && ((day.getFullYear() - e.start.getFullYear()) * 12 + day.getMonth() - e.start.getMonth()) % interval === 0;
    else if (freq === "YEARLY") hit = day.getDate() === e.start.getDate() && day.getMonth() === e.start.getMonth();
    if (!hit) continue;
    if (++n > count) break;
    if (day >= from && !e.exdates.has(day.getTime())) out.push(day);
  }
  return out;
}

/** Events starting between `from` and `from + days`, in order. */
export function eventsBetween(ics: string, from: Date, days: number): CalendarEvent[] {
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  const out: CalendarEvent[] = [];
  for (const e of parseIcs(ics)) {
    const length = e.end ? e.end.getTime() - e.start.getTime() : null;
    for (const start of occurrences(e, from, to)) out.push({ title: e.title, start, end: length !== null ? new Date(start.getTime() + length) : null, allDay: e.allDay, location: e.location });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime()).slice(0, 100);
}

/** The calendar's own name, for the connector card (X-WR-CALNAME), or null. */
export const calendarName = (ics: string) => /^X-WR-CALNAME:(.+)$/m.exec(ics)?.[1]?.trim().slice(0, 80) ?? null;

export function eventLine(e: CalendarEvent): string {
  const day = e.start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const time = e.allDay ? "all day" : e.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `- **${day}, ${time}**: ${e.title}${e.location ? ` (${e.location})` : ""}`;
}
