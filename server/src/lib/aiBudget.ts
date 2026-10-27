import crypto from "node:crypto";
import { db } from "../db.js";

// Making Groq's free tier go further, and never running out by surprise (for example in the middle
// of a demo):
//   - Usage: every answer's token count is recorded per model, so OmniPilot knows roughly how much
//     of each model's daily allowance (GROQ_DAILY_TOKENS, default 200,000) the last 24 hours used,
//     and can warn before it runs out.
//   - Cache: the same question with the same instructions gets the same answer for 24 hours,
//     without spending tokens again (only for steady, low-temperature jobs; creative ones always
//     ask afresh). OMNIPILOT_AI_CACHE=off turns it off.

db.exec(`
CREATE TABLE IF NOT EXISTS ai_usage (model TEXT NOT NULL, at INTEGER NOT NULL, tokens INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ai_usage_at ON ai_usage (at);
CREATE TABLE IF NOT EXISTS ai_cache (key TEXT PRIMARY KEY, text TEXT NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0);
`);

const DAY = 24 * 3600_000;
export const dailyTokenLimit = () => Number(process.env.GROQ_DAILY_TOKENS ?? 200_000) || 200_000;

export function recordUsage(model: string, tokens: number) {
  if (!(tokens > 0)) return;
  db.prepare(`INSERT INTO ai_usage (model, at, tokens) VALUES (?, ?, ?)`).run(model, Date.now(), Math.round(tokens));
  if (Math.random() < 0.02) db.prepare(`DELETE FROM ai_usage WHERE at < ?`).run(Date.now() - 2 * DAY);
}

/** Tokens each model used in the last 24 hours. */
export function usageToday(models: string[]): { model: string; used: number; limit: number; share: number }[] {
  const limit = dailyTokenLimit();
  return models.map((model) => {
    const used = (db.prepare(`SELECT COALESCE(SUM(tokens), 0) AS n FROM ai_usage WHERE model = ? AND at > ?`).get(model, Date.now() - DAY) as { n: number }).n;
    return { model, used, limit, share: Math.min(1, used / limit) };
  });
}

/** A warning when the daily allowance is running low (most of every model's budget used). */
export function budgetWarning(models: string[]): string | null {
  const u = usageToday(models);
  const left = u.reduce((n, m) => n + Math.max(0, m.limit - m.used), 0);
  const total = u.reduce((n, m) => n + m.limit, 0);
  if (!total || left / total > 0.2) return null;
  return `About ${Math.round((left / total) * 100)}% of today's free Groq allowance is left (roughly ${Math.round(left / 1000)}k tokens across all models). Big jobs like building a project or a detailed 3D model may not finish until it resets over the next 24 hours.`;
}

// --- cache ---

export const cacheEnabled = () => process.env.OMNIPILOT_AI_CACHE !== "off";
const MAX_ROWS = 3000;

export const cacheKey = (parts: unknown) => crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export function cacheGet(key: string): { text: string; model: string } | null {
  if (!cacheEnabled()) return null;
  const r = db.prepare(`SELECT text, model, at FROM ai_cache WHERE key = ?`).get(key) as { text: string; model: string; at: number } | undefined;
  if (!r || Date.now() - r.at > DAY) return null;
  db.prepare(`UPDATE ai_cache SET hits = hits + 1 WHERE key = ?`).run(key);
  return { text: r.text, model: r.model };
}

export function cachePut(key: string, text: string, model: string) {
  if (!cacheEnabled()) return;
  db.prepare(`INSERT OR REPLACE INTO ai_cache (key, text, model, at, hits) VALUES (?, ?, ?, ?, 0)`).run(key, text, model, Date.now());
  if (Math.random() < 0.02) {
    db.prepare(`DELETE FROM ai_cache WHERE at < ?`).run(Date.now() - DAY);
    db.prepare(`DELETE FROM ai_cache WHERE key IN (SELECT key FROM ai_cache ORDER BY at DESC LIMIT -1 OFFSET ?)`).run(MAX_ROWS);
  }
}

export function cacheStats(): { entries: number; hits: number } {
  const r = db.prepare(`SELECT COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS hits FROM ai_cache WHERE at > ?`).get(Date.now() - DAY) as { entries: number; hits: number };
  return r;
}
