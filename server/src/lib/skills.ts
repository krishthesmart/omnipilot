import { db } from "../db.js";

// InfraPilot's skills, custom agents and routines (stored locally):
//   - a skill is a saved request, run with "/start_my_day" (or "run start_my_day");
//   - a custom agent is a saved role with instructions, talked to with "/spanishtutor hola" or
//     "ask SpanishTutor ...";
//   - a routine is a skill with a daily time: it runs by itself and the result appears in the chat
//     history under the skill's name.
// Skills only ever run through OmniPilot's normal pipeline, with the same agents, approvals and
// limits as a typed request: saving one grants no extra permissions.

db.exec(`
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  instructions TEXT NOT NULL,
  daily_at TEXT,
  last_run_date TEXT,
  created_at TEXT NOT NULL
)`);

export type SkillKind = "skill" | "agent";

export interface Skill {
  name: string;
  label: string;
  kind: SkillKind;
  instructions: string;
  /** "07:30" for a routine that runs every day at that time, else null. */
  dailyAt: string | null;
  lastRunDate: string | null;
}

export const MAX_SKILLS = 50;

/** "Start My Day" -> "start_my_day". */
export const slug = (name: string) => name.toLowerCase().replace(/^\//, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

const rowToSkill = (r: any): Skill => ({ name: r.name, label: r.label, kind: r.kind, instructions: r.instructions, dailyAt: r.daily_at, lastRunDate: r.last_run_date });

export const listSkills = (): Skill[] => (db.prepare(`SELECT * FROM skills ORDER BY kind, name`).all() as any[]).map(rowToSkill);
export const getSkill = (name: string): Skill | null => {
  const r = db.prepare(`SELECT * FROM skills WHERE name = ?`).get(slug(name));
  return r ? rowToSkill(r) : null;
};

export function saveSkill(s: { name: string; label: string; kind: SkillKind; instructions: string }): Skill {
  const name = slug(s.name);
  if (!name) throw new Error("A skill needs a name with letters or numbers.");
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM skills`).get() as { n: number }).n;
  if (!getSkill(name) && count >= MAX_SKILLS) throw new Error(`You already have ${MAX_SKILLS} skills and agents; delete one first.`);
  db.prepare(
    `INSERT INTO skills (name, label, kind, instructions, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET label = excluded.label, kind = excluded.kind, instructions = excluded.instructions`
  ).run(name, s.label.slice(0, 60), s.kind, s.instructions.slice(0, 2000), new Date().toISOString());
  return getSkill(name)!;
}

export const deleteSkill = (name: string) => db.prepare(`DELETE FROM skills WHERE name = ?`).run(slug(name)).changes > 0;

export function setDailyAt(name: string, time: string | null) {
  db.prepare(`UPDATE skills SET daily_at = ? WHERE name = ?`).run(time, slug(name));
}

export const markRan = (name: string, date: string) => db.prepare(`UPDATE skills SET last_run_date = ? WHERE name = ?`).run(date, slug(name));

/** "7am", "7:30 am", "19:05", "noon" -> "07:00" / "07:30" / "19:05" / "12:00", or null. */
export function parseTime(text: string): string | null {
  const t = text.toLowerCase();
  if (/\bnoon\b/.test(t)) return "12:00";
  if (/\bmidnight\b/.test(t)) return "00:00";
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/.exec(t.replace(/\bat\b/g, " "));
  if (!m || (!m[2] && !m[3])) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = m[3]?.replace(/\./g, "");
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * A message that runs a skill or talks to a custom agent: "/start_my_day", "run start_my_day",
 * "/spanishtutor how do I say hello", "ask SpanishTutor how do I say hello".
 */
export function matchInvocation(message: string): { skill: Skill; extra: string } | null {
  const m = /^\s*\/([a-z0-9_-]{2,40})\b\s*([\s\S]*)$/i.exec(message) ?? /^\s*(?:run|start|use)\s+(?:my\s+)?(?:skill\s+)?([a-z0-9_-]{2,40})\b\s*([\s\S]*)$/i.exec(message) ?? /^\s*(?:ask|tell)\s+([a-z0-9_-]{2,40})\b[,:]?\s*([\s\S]*)$/i.exec(message);
  if (!m) return null;
  // "run start_my_day every day at 7am" schedules the skill (InfraPilot), it doesn't run it now.
  if (/\b(every ?day|daily|each day|every (morning|evening|night|week)|routine|stop running)\b/i.test(m[2])) return null;
  const skill = getSkill(m[1]);
  return skill ? { skill, extra: m[2].trim() } : null;
}

/** The request a skill runs (its saved request plus anything typed after the command). */
export const skillRequest = (s: Skill, extra: string) => (extra ? `${s.instructions}\n\nAlso: ${extra}` : s.instructions);

/** Routines due now: a daily time that has passed today and hasn't run yet today. */
export function dueRoutines(now = new Date()): Skill[] {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return listSkills().filter((s) => s.dailyAt && s.dailyAt <= hhmm && s.lastRunDate !== today);
}
