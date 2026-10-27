import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// Node's built-in SQLite (Node 22+): no native module to compile, so install
// works the same on every OS and Node version. Node still labels it
// experimental and warns once on load; that one warning is filtered out.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: any[]) => {
  const text = typeof warning === "string" ? warning : warning?.message;
  if (/SQLite is an experimental feature/.test(text ?? "")) return;
  return (emitWarning as any)(warning, ...rest);
}) as typeof process.emitWarning;
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  console.error(
    `\n  OmniPilot needs Node.js 22.13 or newer (you have ${process.versions.node}).\n  Install the current LTS from https://nodejs.org, or with nvm: nvm install 22 && nvm use 22\n`
  );
  process.exit(1);
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.OMNIPILOT_DATA_DIR ?? path.join(__dirname, "..", "data");

// Tests set OMNIPILOT_DB_PATH=":memory:" so runs don't pollute the dev database.
const dbPath = process.env.OMNIPILOT_DB_PATH ?? path.join(dataDir, "omnipilot.sqlite");
if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });

export const db: DatabaseSyncType = new DatabaseSync(dbPath);
if (dbPath !== ":memory:") {
  db.exec("PRAGMA journal_mode = WAL");
  // Only this user may read the database (it holds connected accounts' tokens and the session secret).
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.chmodSync(f, 0o600);
    } catch {
      // not created yet
    }
  }
}
db.exec("PRAGMA busy_timeout = 3000");

db.exec(`
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  agent TEXT NOT NULL,
  action TEXT NOT NULL,
  parameters TEXT NOT NULL,
  outcome TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connectors (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  verification TEXT NOT NULL,   -- 'token' (a token/password verified with the provider) | 'oauth' (signed in with the provider)
  status TEXT NOT NULL,         -- 'connected' | 'not_connected'
  account_label TEXT,           -- public info to display (e.g. "@you" / "Acme workspace") -- never the token itself
  secret_token TEXT,            -- stored locally only; never returned by the API or written to logs
  connected_at TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  description TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
`);

const SEED_CONNECTORS: { name: string; kind: string; verification: "token" | "oauth" }[] = [
  { name: "Slack", kind: "messaging", verification: "token" },
  { name: "GitHub", kind: "code_hosting", verification: "token" },
  { name: "Notion", kind: "docs", verification: "token" },
  // The "token" is the calendar's secret iCal address (read-only).
  { name: "Google Calendar", kind: "calendar", verification: "token" },
  // Read-only Gmail over IMAP: the token is a Google app password (with the Gmail address).
  { name: "Gmail", kind: "email", verification: "token" },
  // Google's own sign-in (OAuth, with the user's free client ID): read files, create docs on approval.
  { name: "Google Drive", kind: "storage", verification: "oauth" },
];
// Every integration is real now: an older database's simulated Drive connection is reset.
db.prepare(`UPDATE connectors SET verification = 'oauth', status = CASE WHEN secret_token IS NULL THEN 'not_connected' ELSE status END WHERE name = 'Google Drive' AND verification <> 'oauth'`).run();
// MCP servers are real connections now (see lib/mcp.ts); the old placeholder card goes.
db.prepare(`DELETE FROM connectors WHERE name = 'Generic MCP Server'`).run();
for (const c of SEED_CONNECTORS) {
  db.prepare(`INSERT OR IGNORE INTO connectors (name, kind, verification, status) VALUES (?, ?, ?, 'not_connected')`).run(
    c.name,
    c.kind,
    c.verification
  );
}

/** Public-safe view: never includes the stored secret_token. */
export function listConnectors(): any[] {
  return db
    .prepare(`SELECT name, kind, verification, status, account_label, connected_at FROM connectors ORDER BY name ASC`)
    .all();
}

export function getConnectorPublic(name: string): any {
  return db
    .prepare(`SELECT name, kind, verification, status, account_label, connected_at FROM connectors WHERE name = ?`)
    .get(name);
}

/** Internal only (includes secret_token) -- never return this object directly from a route. */
export function getConnectorInternal(name: string): any {
  return db.prepare(`SELECT * FROM connectors WHERE name = ?`).get(name);
}

export function setConnectorStatus(name: string, status: "connected" | "not_connected") {
  db.prepare(`UPDATE connectors SET status = ?, connected_at = ?, account_label = NULL, secret_token = NULL WHERE name = ?`).run(
    status,
    status === "connected" ? new Date().toISOString() : null,
    name
  );
}

/** Records a real, provider-verified connection (token-based integrations only). */
export function setConnectorVerified(name: string, accountLabel: string, secretToken: string) {
  db.prepare(`UPDATE connectors SET status = 'connected', account_label = ?, secret_token = ?, connected_at = ? WHERE name = ?`).run(
    accountLabel,
    secretToken,
    new Date().toISOString(),
    name
  );
}

export function saveRun(run: { id: string; request: string; createdAt: string; status: string; data: unknown }) {
  db.prepare(
    `INSERT INTO runs (id, request, created_at, status, data) VALUES (@id, @request, @createdAt, @status, @data)
     ON CONFLICT(id) DO UPDATE SET status=@status, data=@data`
  ).run({ ...run, data: JSON.stringify(run.data) });
}

export function getRun(id: string): any | undefined {
  const row = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as any;
  if (!row) return undefined;
  return { ...row, data: JSON.parse(row.data) };
}

export function listRuns(limit = 50): any[] {
  const rows = db.prepare(`SELECT id, request, created_at, status FROM runs ORDER BY created_at DESC LIMIT ?`).all(limit);
  return rows;
}

export function insertAudit(entry: {
  id: string;
  runId: string;
  timestamp: string;
  agent: string;
  action: string;
  parameters: Record<string, unknown>;
  outcome: string;
}) {
  db.prepare(
    `INSERT INTO audit_log (id, run_id, timestamp, agent, action, parameters, outcome)
     VALUES (@id, @runId, @timestamp, @agent, @action, @parameters, @outcome)`
  ).run({ ...entry, parameters: JSON.stringify(entry.parameters) });
}

export function listAudit(runId?: string, limit = 200): any[] {
  const rows = runId
    ? db.prepare(`SELECT * FROM audit_log WHERE run_id = ? ORDER BY timestamp ASC LIMIT ?`).all(runId, limit)
    : db.prepare(`SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?`).all(limit);
  return (rows as any[]).map((r) => ({ ...r, parameters: JSON.parse(r.parameters) }));
}

export function createApproval(a: {
  id: string;
  runId: string;
  agent: string;
  description: string;
  riskLevel: string;
  createdAt: string;
}) {
  db.prepare(
    `INSERT OR IGNORE INTO approvals (id, run_id, agent, description, risk_level, status, created_at)
     VALUES (@id, @runId, @agent, @description, @riskLevel, 'pending', @createdAt)`
  ).run(a);
}

export function decideApproval(id: string, status: "approved" | "denied") {
  db.prepare(`UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?`).run(status, new Date().toISOString(), id);
}

export function getApproval(id: string): any {
  return db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id);
}

export function listApprovals(runId?: string): any[] {
  return runId
    ? (db.prepare(`SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at DESC`).all(runId) as any[])
    : (db.prepare(`SELECT * FROM approvals ORDER BY created_at DESC`).all() as any[]);
}

// --- WatcherPilot: the parent's focus policy (single row) and blocked-attempt log ---
db.exec(`
CREATE TABLE IF NOT EXISTS watcher_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  pin_hash TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watcher_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL
);
`);

export function getWatcherRow(): { data: string; pin_hash: string | null; updated_at: string } | undefined {
  return db.prepare(`SELECT data, pin_hash, updated_at FROM watcher_policy WHERE id = 1`).get() as any;
}

export function saveWatcherRow(data: unknown, pinHash: string | null) {
  db.prepare(
    `INSERT INTO watcher_policy (id, data, pin_hash, updated_at) VALUES (1, @data, @pinHash, @at)
     ON CONFLICT(id) DO UPDATE SET data=@data, pin_hash=@pinHash, updated_at=@at`
  ).run({ data: JSON.stringify(data), pinHash, at: new Date().toISOString() });
}

export function logWatcherEvent(e: { url: string; title?: string; decision: string; reason: string }) {
  db.prepare(`INSERT INTO watcher_events (at, url, title, decision, reason) VALUES (?, ?, ?, ?, ?)`).run(
    new Date().toISOString(),
    e.url.slice(0, 500),
    (e.title ?? "").slice(0, 200),
    e.decision,
    e.reason
  );
  // Keep the log bounded.
  db.prepare(`DELETE FROM watcher_events WHERE id <= (SELECT MAX(id) - 1000 FROM watcher_events)`).run();
}

export function listWatcherEvents(limit = 50): any[] {
  return db.prepare(`SELECT at, url, title, decision, reason FROM watcher_events ORDER BY id DESC LIMIT ?`).all(limit);
}

// --- Conversation memory (so follow-ups survive a restart) ---
db.exec(`
CREATE TABLE IF NOT EXISTS conversation_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_conversation ON conversation_turns (conversation_id, id);
`);

export function insertTurn(conversationId: string, turn: unknown, keep: number) {
  db.prepare(`INSERT INTO conversation_turns (conversation_id, at, data) VALUES (?, ?, ?)`).run(conversationId, new Date().toISOString(), JSON.stringify(turn));
  db.prepare(
    `DELETE FROM conversation_turns WHERE conversation_id = ? AND id NOT IN (SELECT id FROM conversation_turns WHERE conversation_id = ? ORDER BY id DESC LIMIT ?)`
  ).run(conversationId, conversationId, keep);
}

export function selectTurns(conversationId: string): any[] {
  return (db.prepare(`SELECT data FROM conversation_turns WHERE conversation_id = ? ORDER BY id ASC`).all(conversationId) as { data: string }[]).map((r) => JSON.parse(r.data));
}

/** Old conversations are dropped after 30 days. */
export function pruneTurns(maxAgeDays = 30) {
  db.prepare(`DELETE FROM conversation_turns WHERE at < ?`).run(new Date(Date.now() - maxAgeDays * 86_400_000).toISOString());
}

// --- MathPilot: the always-on identity search (resumable) and what it found ---
db.exec(`
CREATE TABLE IF NOT EXISTS math_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS math_discoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  constant TEXT NOT NULL,
  a_coeffs TEXT NOT NULL,
  b_coeffs TEXT NOT NULL,
  relation TEXT NOT NULL,
  value TEXT NOT NULL,
  digits INTEGER NOT NULL,
  variants INTEGER NOT NULL DEFAULT 1,
  text TEXT NOT NULL
);
`);

export interface DiscoveryRow {
  id: number;
  at: string;
  constant: string;
  a: number[];
  b: number[];
  relation: [number, number, number, number];
  value: string;
  digits: number;
  variants: number;
  text: string;
}

const toDiscovery = (r: any): DiscoveryRow => ({
  id: r.id,
  at: r.at,
  constant: r.constant,
  a: JSON.parse(r.a_coeffs),
  b: JSON.parse(r.b_coeffs),
  relation: JSON.parse(r.relation),
  value: r.value,
  digits: r.digits,
  variants: r.variants,
  text: r.text,
});

export function getMathState(): any | undefined {
  const row = db.prepare(`SELECT data FROM math_state WHERE id = 1`).get() as { data: string } | undefined;
  return row ? JSON.parse(row.data) : undefined;
}

export function saveMathState(data: unknown) {
  db.prepare(`INSERT INTO math_state (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(JSON.stringify(data));
}

export function insertDiscovery(d: { constant: string; a: number[]; b: number[]; relation: number[]; value: string; digits: number; text: string }): DiscoveryRow {
  const at = new Date().toISOString();
  const info = db
    .prepare(`INSERT INTO math_discoveries (at, constant, a_coeffs, b_coeffs, relation, value, digits, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(at, d.constant, JSON.stringify(d.a), JSON.stringify(d.b), JSON.stringify(d.relation), d.value, d.digits, d.text);
  return toDiscovery(db.prepare(`SELECT * FROM math_discoveries WHERE id = ?`).get(Number(info.lastInsertRowid)));
}

/** Another formula for a value already found. */
export function bumpDiscoveryVariants(value: string) {
  db.prepare(`UPDATE math_discoveries SET variants = variants + 1 WHERE substr(value, 1, 22) = substr(?, 1, 22)`).run(value);
}

export function listDiscoveries(limit = 50, afterId = 0): DiscoveryRow[] {
  return (db.prepare(`SELECT * FROM math_discoveries WHERE id > ? ORDER BY id DESC LIMIT ?`).all(afterId, limit) as any[]).map(toDiscovery);
}

export function countDiscoveries(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM math_discoveries`).get() as { n: number }).n;
}

// --- Settings changed from the app (e.g. which AI model answers) ---
db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

export function getSetting(key: string): string | undefined {
  return (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
}

export function setSetting(key: string, value: string | null) {
  if (value === null) db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  else db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

// --- Chat history: which runs belong to which conversation (for the sidebar) ---
db.exec(`
CREATE TABLE IF NOT EXISTS conversation_runs (
  run_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  request TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_runs ON conversation_runs (conversation_id, at);
`);

export function addConversationRun(conversationId: string, runId: string, request: string) {
  db.prepare(`INSERT OR IGNORE INTO conversation_runs (run_id, conversation_id, request, at) VALUES (?, ?, ?, ?)`).run(runId, conversationId, request.slice(0, 4000), new Date().toISOString());
}

/** Newest conversations first, titled by their first message. */
export function listConversations(limit = 100): { id: string; title: string; turns: number; updatedAt: string }[] {
  return db
    .prepare(
      `SELECT conversation_id AS id,
              (SELECT request FROM conversation_runs f WHERE f.conversation_id = c.conversation_id ORDER BY at ASC LIMIT 1) AS title,
              COUNT(*) AS turns, MAX(at) AS updatedAt
       FROM conversation_runs c GROUP BY conversation_id ORDER BY updatedAt DESC LIMIT ?`
    )
    .all(limit) as any[];
}

export function conversationRuns(conversationId: string): { runId: string; request: string; at: string }[] {
  return db.prepare(`SELECT run_id AS runId, request, at FROM conversation_runs WHERE conversation_id = ? ORDER BY at ASC`).all(conversationId) as any[];
}

export function deleteConversation(conversationId: string): number {
  const runs = conversationRuns(conversationId);
  for (const r of runs) db.prepare(`DELETE FROM runs WHERE id = ?`).run(r.runId);
  db.prepare(`DELETE FROM conversation_runs WHERE conversation_id = ?`).run(conversationId);
  db.prepare(`DELETE FROM conversation_turns WHERE conversation_id = ?`).run(conversationId);
  return runs.length;
}

// --- Run keys: an SDK client may read only the runs it started (see routes/chat.ts) ---
db.exec(`CREATE TABLE IF NOT EXISTS run_access (run_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, created_at TEXT NOT NULL)`);

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** Creates the key that lets the SDK client that started a run read it later. Returns the key (shown once). */
export function grantRunKey(runId: string): string {
  const key = randomBytes(24).toString("base64url");
  db.prepare(`INSERT OR REPLACE INTO run_access (run_id, key_hash, created_at) VALUES (?, ?, ?)`).run(runId, sha256(key).toString("hex"), new Date().toISOString());
  return key;
}

export function runKeyMatches(runId: string, key: unknown): boolean {
  if (typeof key !== "string" || !key) return false;
  const row = db.prepare(`SELECT key_hash FROM run_access WHERE run_id = ?`).get(runId) as { key_hash: string } | undefined;
  if (!row) return false;
  return timingSafeEqual(Buffer.from(row.key_hash, "hex"), sha256(key));
}
