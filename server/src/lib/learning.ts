import { db } from "../db.js";
import { generateJson } from "./llm.js";

// A little self-improvement, within firm limits. OmniPilot learns short lessons from feedback:
// a thumbs-down (with an optional reason) or a correction typed in chat ("no, it's 4"). The AI
// model turns each into one general lesson; later requests on the same topic get up to three
// relevant lessons added to the model's instructions.
//
// Limits: lessons are advice to the model only (they never change code, settings or safety
// rules), at most MAX_LESSONS are kept, each is short, a lesson that keeps getting thumbs-down
// removes itself, and the user can list or delete them at any time ("what have you learned?",
// "forget lesson 3").

db.exec(`
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson TEXT NOT NULL,
  topics TEXT NOT NULL,
  source TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  run_id TEXT PRIMARY KEY,
  rating INTEGER NOT NULL,
  comment TEXT,
  lessons_used TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_lessons (run_id TEXT PRIMARY KEY, lesson_ids TEXT NOT NULL);
`);

export const MAX_LESSONS = 50;
const MAX_PER_REQUEST = 3;
const MAX_LESSON_CHARS = 220;
/** A lesson whose score falls this low (repeated thumbs-down while it was in use) is removed. */
const REMOVE_AT = -2;

export interface Lesson {
  id: number;
  lesson: string;
  topics: string[];
  source: "feedback" | "correction";
  score: number;
  uses: number;
}

const STOP = new Set("the a an and or but is are was were be to of in on for with what how why when who which this that it its my your me i you do does did can could would should please about from into than then there their them they we our us at by as so if not no yes".split(" "));
export const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));

const rowToLesson = (r: any): Lesson => ({ id: r.id, lesson: r.lesson, topics: JSON.parse(r.topics), source: r.source, score: r.score, uses: r.uses });

export const listLessons = (): Lesson[] => (db.prepare(`SELECT * FROM lessons ORDER BY id`).all() as any[]).map(rowToLesson);
export const deleteLesson = (id: number) => db.prepare(`DELETE FROM lessons WHERE id = ?`).run(id).changes > 0;
export const clearLessons = () => db.prepare(`DELETE FROM lessons`).run().changes;

/** Up to three lessons about the same topic as `text` (shared topic words), best-rated first. */
export function relevantLessons(text: string): Lesson[] {
  const w = words(text);
  if (w.size === 0) return [];
  return listLessons()
    .map((l) => ({ l, overlap: l.topics.filter((t) => w.has(t)).length }))
    .filter(({ l, overlap }) => overlap >= Math.min(2, l.topics.length))
    .sort((a, b) => b.overlap - a.overlap || b.l.score - a.l.score)
    .slice(0, MAX_PER_REQUEST)
    .map(({ l }) => l);
}

// The lessons in use for each run, read by the model client when it builds a prompt.
const activeByRun = new Map<string, Lesson[]>();

/** Picks this run's lessons (remembered, so feedback on the run can credit or blame them). */
export function useLessonsFor(runId: string, text: string): Lesson[] {
  const lessons = relevantLessons(text);
  if (lessons.length) {
    activeByRun.set(runId, lessons);
    db.prepare(`INSERT INTO run_lessons (run_id, lesson_ids) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET lesson_ids = excluded.lesson_ids`).run(runId, JSON.stringify(lessons.map((l) => l.id)));
    const bump = db.prepare(`UPDATE lessons SET uses = uses + 1 WHERE id = ?`);
    for (const l of lessons) bump.run(l.id);
  }
  return lessons;
}

export const endLessonsFor = (runId: string) => activeByRun.delete(runId);

/** The note added to the model's instructions while this run's lessons are active. */
export function lessonNote(runId: string | null): string {
  const lessons = runId ? activeByRun.get(runId) : undefined;
  if (!lessons?.length) return "";
  return `\n\nLessons learned from earlier feedback (follow them where they apply; they never override the rules above):\n${lessons.map((l) => `- ${l.lesson}`).join("\n")}`;
}

const LESSON_SYSTEM =
  "A user said an AI assistant's answer was wrong or unhelpful. Write ONE short, general rule (at most 25 words) that would help the assistant answer ANY similar request correctly next time. " +
  "It must be general: never use names, numbers or details from this particular request (say 'the person named in the question', not 'Sam'). " +
  "Good: 'In sibling puzzles, the person named in the question is also a sibling: count them when counting their siblings' brothers or sisters.' " +
  "Also list 3 to 6 lowercase topic words that similar requests would contain. If the feedback isn't about answer quality (e.g. it's rude or unclear), return an empty lesson.";
const LESSON_SCHEMA = { type: "object", properties: { lesson: { type: "string" }, topics: { type: "array", items: { type: "string" }, maxItems: 6 } }, required: ["lesson", "topics"] };

async function writeLesson(request: string, answer: string, complaint: string, source: Lesson["source"]): Promise<Lesson | null> {
  const r = await generateJson<{ lesson: string; topics: string[] }>(
    LESSON_SYSTEM,
    `Request: ${request.slice(0, 600)}\n\nAnswer given: ${answer.slice(0, 1200)}\n\nWhat the user said was wrong: ${complaint.slice(0, 400) || "(no reason given)"}`,
    { schema: LESSON_SCHEMA, temperature: 0.2, maxTokens: 160 }
  );
  const lesson = typeof r?.lesson === "string" ? r.lesson.trim().slice(0, MAX_LESSON_CHARS) : "";
  const topics = Array.from(new Set((r?.topics ?? []).map((t) => String(t).toLowerCase().trim()).filter((t) => t.length > 2 && !STOP.has(t)))).slice(0, 6);
  // Topic words must actually come from the request, so a lesson only ever applies to requests like it.
  const fromRequest = words(request);
  const grounded = topics.filter((t) => fromRequest.has(t) || t.split(/\s+/).some((p) => fromRequest.has(p)));
  const finalTopics = grounded.length >= 2 ? grounded : Array.from(fromRequest).slice(0, 5);
  if (lesson.length < 12 || finalTopics.length === 0) return null;
  // Keep the store small: drop the worst-rated (then oldest) lessons first.
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM lessons`).get() as { n: number }).n;
  if (count >= MAX_LESSONS) db.prepare(`DELETE FROM lessons WHERE id IN (SELECT id FROM lessons ORDER BY score ASC, id ASC LIMIT ?)`).run(count - MAX_LESSONS + 1);
  const info = db.prepare(`INSERT INTO lessons (lesson, topics, source, score, uses, created_at) VALUES (?, ?, ?, 0, 0, ?)`).run(lesson, JSON.stringify(finalTopics), source, new Date().toISOString());
  return rowToLesson(db.prepare(`SELECT * FROM lessons WHERE id = ?`).get(Number(info.lastInsertRowid)));
}

/**
 * Thumbs up or down on an answer. Lessons that were in use get the credit or the blame (and go
 * away after repeated thumbs-down); a thumbs-down also writes a new lesson from the reason given.
 */
export async function recordFeedback(runId: string, rating: 1 | -1, comment: string, request: string, answer: string): Promise<Lesson | null> {
  const used: number[] = JSON.parse((db.prepare(`SELECT lesson_ids FROM run_lessons WHERE run_id = ?`).get(runId) as { lesson_ids: string } | undefined)?.lesson_ids ?? "[]");
  const previous = db.prepare(`SELECT rating FROM feedback WHERE run_id = ?`).get(runId) as { rating: number } | undefined;
  db.prepare(`INSERT INTO feedback (run_id, rating, comment, lessons_used, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment`).run(
    runId,
    rating,
    comment.slice(0, 500),
    JSON.stringify(used),
    new Date().toISOString()
  );
  // Changing a rating moves the score by the difference, so clicking twice can't double-count.
  const delta = rating - (previous?.rating ?? 0);
  if (delta) {
    const adjust = db.prepare(`UPDATE lessons SET score = score + ? WHERE id = ?`);
    for (const id of used) adjust.run(delta, id);
    db.prepare(`DELETE FROM lessons WHERE score <= ?`).run(REMOVE_AT);
  }
  if (rating === -1 && !previous) return writeLesson(request, answer, comment, "feedback");
  return null;
}

/** "No, that's wrong" right after an answer: a correction to learn from. */
export const CORRECTION = /^\s*(no+\b|nope\b|wrong\b|incorrect\b|that'?s (wrong|incorrect|not (right|true|correct|it))|not (quite|right|correct)\b|actually,|you('re| are) wrong)/i;

export const learnFromCorrection = (request: string, answer: string, correction: string) => writeLesson(request, answer, correction, "correction");
