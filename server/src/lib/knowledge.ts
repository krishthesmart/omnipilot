import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// OmniPilot's offline encyclopedia (built once with `npm run knowledge`): the
// opening paragraphs of every Simple English Wikipedia article, in a full-text
// index. A small (3 GB or less) model can't hold much world knowledge, so for factual
// questions Helper looks the facts up here and the model answers from them,
// citing the article. Nothing goes online at question time.

const DEFAULT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "knowledge.sqlite");
const knowledgePath = () => process.env.OMNIPILOT_KNOWLEDGE ?? DEFAULT_PATH;

let db: DatabaseSyncType | null | undefined;

function open(): DatabaseSyncType | null {
  if (db !== undefined) return db;
  const file = knowledgePath();
  if (!fs.existsSync(file)) return null; // not built yet; checked again on the next question
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  db = new DatabaseSync(file, { readOnly: true });
  return db;
}

export const knowledgeAvailable = () => open() !== null;

export interface Passage {
  title: string;
  text: string;
}

const STOP = new Set(
  ("a an the of in on at to for from by with about into over under and or but is are was were be been being do does did " +
    "what who whom whose which when where why how many much tell me explain describe give please can could would should " +
    "you your i my we our it its this that these those there their they he she his her as than then so if not no yes " +
    "know find out called name named kind type sort mean means meaning define definition fact facts").split(" ")
);

/** The searchable words of a question: lowercase, no stopwords, letters and digits only. */
export function searchTerms(question: string): string[] {
  return [
    ...new Set(
      question
        .toLowerCase()
        .replace(/['’]s\b/g, "")
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1 && !STOP.has(w))
    ),
  ].slice(0, 12);
}

/**
 * The most relevant articles for a question. An article only counts if its title
 * is about the question (shares a search word), so an unrelated question gets no
 * passages rather than misleading ones.
 */
export function lookUp(question: string, limit = 3): Passage[] {
  const kb = open();
  if (!kb) return [];
  const terms = searchTerms(question);
  if (terms.length === 0) return [];
  const match = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
  let rows: { title: string; body: string; score: number }[];
  try {
    // Title matches weigh 8x more than body matches.
    rows = kb.prepare(`SELECT title, body, bm25(kb, 8.0, 1.0) AS score FROM kb WHERE kb MATCH ? ORDER BY score LIMIT 25`).all(match) as any[];
  } catch {
    return [];
  }
  // Plural-insensitive word match: vaccines/vaccine, cities/city.
  const stem = (w: string) => w.replace(/ies$/, "y").replace(/(?<!s)s$/, "");
  const termStems = new Set(terms.map(stem));
  const ranked = rows
    .map((r) => {
      // Every word of the title counts ("C&P Telephone" isn't just "Telephone"); a disambiguated
      // title ("Romeo and Juliet (1908 movie)") ranks below the main article.
      const parenthetical = /\(.*\)/.test(r.title);
      const titleWords = r.title.replace(/\(.*?\)/g, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP.has(w));
      const overlap = titleWords.filter((w) => termStems.has(stem(w))).length;
      const extra = titleWords.length - overlap;
      // A title made only of the question's words ("Australia", "Mona Lisa") is what the question is about;
      // titles with other words ("Liberal Party of Australia") are side topics.
      const covered = titleWords.length > 0 && extra === 0;
      return { ...r, overlap, covered, rank: overlap * 3 - extra * 2 + (covered ? 10 : 0) - (parenthetical ? 4 : 0) - r.score * 0.5 };
    })
    .filter((r) => r.overlap > 0)
    .sort((a, b) => b.rank - a.rank);
  // One slot goes to the best text match whatever its title: "the longest river in Africa"
  // is answered in the "Nile" article, whose title shares no word with the question.
  const bodyHit = rows.find((r) => !ranked.slice(0, limit - 1).some((x) => x.title === r.title) && terms.filter((t) => r.body.toLowerCase().includes(t)).length >= Math.min(3, terms.length));
  const picked = bodyHit ? [...ranked.slice(0, limit - 1), bodyHit] : ranked.slice(0, limit);
  return picked.map((r) => ({ title: r.title, text: r.body }));
}

/** Where the passages come from, for citations. */
export const KNOWLEDGE_SOURCE = "Simple English Wikipedia (CC BY-SA 4.0)";
