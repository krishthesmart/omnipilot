import { db } from "../db.js";

// SchoolPilot's memory: assignments, projects and tests with due dates, kept in the local
// database. Dates are worked out here (never by the model): "Friday", "tomorrow",
// "next Thursday", "in 3 days", "Oct 30", "10/30", "2026-10-30".

db.exec(`
CREATE TABLE IF NOT EXISTS school_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  subject TEXT,
  kind TEXT NOT NULL,
  due TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]',
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)`);

export type TaskKind = "homework" | "project" | "test" | "essay";

export interface PlanStep {
  date: string;
  text: string;
}

export interface SchoolTask {
  id: number;
  title: string;
  subject: string | null;
  kind: TaskKind;
  due: string;
  steps: PlanStep[];
  done: boolean;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** YYYY-MM-DD in local time. */
export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const atMidnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const fromIso = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** The due date written in `text`, or null. "Friday" means the next Friday (a week from today if today is Friday). */
export function parseDueDate(text: string, now = new Date()): string | null {
  const t = text.toLowerCase();
  const today = atMidnight(now);
  if (/\b(today|tonight)\b/.test(t)) return isoDate(today);
  if (/\bday after tomorrow\b/.test(t)) return isoDate(addDays(today, 2));
  if (/\btomorrow\b/.test(t)) return isoDate(addDays(today, 1));
  const inN = /\bin (\d{1,3}|a|one|two|three|four|five|six|seven) (day|week)s?\b/.exec(t);
  if (inN) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    const n = Number(words[inN[1]] ?? inN[1]);
    return isoDate(addDays(today, inN[2] === "week" ? n * 7 : n));
  }
  if (/\bnext week\b/.test(t)) return isoDate(addDays(today, 7));
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // "Oct 30", "October 30th", "30 October"
  const monthFirst = new RegExp(`\\b(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(t);
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.join("|")})[a-z]*\\b`).exec(t);
  const md = monthFirst ? { m: MONTHS.indexOf(monthFirst[1]), d: Number(monthFirst[2]) } : dayFirst ? { m: MONTHS.indexOf(dayFirst[2]), d: Number(dayFirst[1]) } : null;
  // "10/30" (US month/day)
  const slash = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t);
  const md2 = md ?? (slash && Number(slash[1]) <= 12 ? { m: Number(slash[1]) - 1, d: Number(slash[2]) } : null);
  if (md2 && md2.d >= 1 && md2.d <= 31) {
    let date = new Date(today.getFullYear(), md2.m, md2.d);
    if (date < today) date = new Date(today.getFullYear() + 1, md2.m, md2.d); // already past: next year
    return isoDate(date);
  }
  const weekday = new RegExp(`\\b(next |this |on )?(${DAYS.join("|")})\\b`).exec(t);
  if (weekday) {
    const target = DAYS.indexOf(weekday[2]);
    let diff = (target - today.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    return isoDate(addDays(today, diff));
  }
  return null;
}

/** Whole days from today until `due` (negative when overdue). */
export const daysUntil = (due: string, now = new Date()) => Math.round((fromIso(due).getTime() - atMidnight(now).getTime()) / 86_400_000);

/** "today", "tomorrow", "in 3 days (Thu, Oct 30)", "2 days overdue". */
export function whenText(due: string, now = new Date()): string {
  const n = daysUntil(due, now);
  const label = fromIso(due).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (n < 0) return `${-n} day${n === -1 ? "" : "s"} overdue (${label})`;
  if (n === 0) return `today (${label})`;
  if (n === 1) return `tomorrow (${label})`;
  return `in ${n} days (${label})`;
}

/**
 * Spreads work across the days before the due date: a step per working day, the last step the
 * day before it's due (or on the day, if it's due tomorrow or sooner).
 */
export function scheduleSteps(steps: string[], due: string, now = new Date()): PlanStep[] {
  const total = Math.max(0, daysUntil(due, now));
  if (steps.length === 0) return [];
  const lastDay = Math.max(0, total - 1);
  return steps.map((text, i) => {
    const offset = steps.length === 1 ? lastDay : Math.round((i * lastDay) / (steps.length - 1));
    return { date: isoDate(addDays(atMidnight(now), offset)), text };
  });
}

/** Study sessions before a test: spaced out, closer together near the day (spaced repetition). */
export function studyDays(due: string, now = new Date()): string[] {
  const total = daysUntil(due, now);
  if (total <= 0) return [isoDate(atMidnight(now))];
  const offsets = [total - 1, total - 2, total - 4, total - 7, total - 11].filter((o) => o >= 0);
  return Array.from(new Set(offsets)).sort((a, b) => a - b).map((o) => isoDate(addDays(atMidnight(now), o)));
}

const rowToTask = (r: any): SchoolTask => ({ id: r.id, title: r.title, subject: r.subject, kind: r.kind, due: r.due, steps: JSON.parse(r.steps), done: Boolean(r.done) });

export function addTask(t: { title: string; subject: string | null; kind: TaskKind; due: string; steps: PlanStep[] }): SchoolTask {
  const info = db
    .prepare(`INSERT INTO school_tasks (title, subject, kind, due, steps, done, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`)
    .run(t.title, t.subject, t.kind, t.due, JSON.stringify(t.steps), new Date().toISOString());
  return rowToTask(db.prepare(`SELECT * FROM school_tasks WHERE id = ?`).get(Number(info.lastInsertRowid)));
}

export const listTasks = (includeDone = false): SchoolTask[] =>
  (db.prepare(`SELECT * FROM school_tasks ${includeDone ? "" : "WHERE done = 0"} ORDER BY due, id`).all() as any[]).map(rowToTask);

export function setDone(id: number, done = true) {
  db.prepare(`UPDATE school_tasks SET done = ? WHERE id = ?`).run(done ? 1 : 0, id);
}

export function deleteTask(id: number) {
  db.prepare(`DELETE FROM school_tasks WHERE id = ?`).run(id);
}

/** The open task whose title best matches the words in `text` (at least one shared word), or null. */
export function findTask(text: string): SchoolTask | null {
  const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !["the", "and", "for", "with", "done", "finished", "mark", "completed", "turned", "submitted", "my", "homework", "delete", "remove"].includes(w)));
  let best: { task: SchoolTask; score: number } | null = null;
  for (const task of listTasks()) {
    const score = `${task.title} ${task.subject ?? ""}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => words.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { task, score };
  }
  return best?.task ?? null;
}
