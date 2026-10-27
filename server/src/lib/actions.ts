import { db } from "../db.js";

// Actions an agent proposes that change something outside OmniPilot: post to Slack, open a GitHub
// issue, add to a Notion page, save a Gmail draft, call an MCP tool, add an MCP server. The exact
// parameters are stored here, on the server, when the action is proposed -- the app only sends back
// "approved" or "denied" -- so what runs is exactly what the user saw in the preview. Nothing runs
// until the user approves it, and each action runs at most once.
// (Code changes are stored as patch sets in patches.ts.)

db.exec(`
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
)`);

export type ActionKind = "slack_message" | "github_issue" | "notion_append" | "gmail_draft" | "drive_create_doc" | "mcp_tool" | "mcp_add_server";

export interface ActionOutcome {
  ok: boolean;
  /** What happened, for the user ("Posted to #general"). */
  message: string;
  /** A link to the result, if there is one (the new GitHub issue). */
  url?: string;
}

type Executor = (params: any) => Promise<ActionOutcome>;
const executors = new Map<ActionKind, Executor>();

/** Each integration registers how to carry out its actions (kept separate to avoid import cycles). */
export function registerExecutor(kind: ActionKind, run: Executor) {
  executors.set(kind, run);
}

export function saveAction(id: string, kind: ActionKind, params: Record<string, unknown>) {
  db.prepare(`INSERT OR REPLACE INTO pending_actions (id, kind, params, status, created_at) VALUES (?, ?, ?, 'pending', ?)`).run(id, kind, JSON.stringify(params), new Date().toISOString());
}

export function getAction(id: string): { id: string; kind: ActionKind; params: any; status: string; result: ActionOutcome | null } | null {
  const r = db.prepare(`SELECT * FROM pending_actions WHERE id = ?`).get(id) as any;
  return r ? { id: r.id, kind: r.kind, params: JSON.parse(r.params), status: r.status, result: r.result ? JSON.parse(r.result) : null } : null;
}

/** Runs an approved action once. If it fails it stays pending, so the user can fix the cause and try again. */
export async function executeAction(id: string): Promise<ActionOutcome> {
  const a = getAction(id);
  if (!a) return { ok: false, message: "There's nothing to run for this approval." };
  // Claim it first, so two quick clicks can't run it twice.
  const claimed = db.prepare(`UPDATE pending_actions SET status = 'running' WHERE id = ? AND status = 'pending'`).run(id);
  if (!claimed.changes) return { ok: false, message: `This action was already ${a.status}.` };
  const run = executors.get(a.kind);
  let outcome: ActionOutcome;
  try {
    outcome = run ? await run(a.params) : { ok: false, message: `OmniPilot doesn't know how to run "${a.kind}".` };
  } catch (e: any) {
    outcome = { ok: false, message: e?.message ? String(e.message).slice(0, 300) : "It failed." };
  }
  db.prepare(`UPDATE pending_actions SET status = ?, result = ?, done_at = ? WHERE id = ?`).run(outcome.ok ? "done" : "pending", JSON.stringify(outcome), new Date().toISOString(), id);
  return outcome;
}

export function rejectAction(id: string) {
  db.prepare(`UPDATE pending_actions SET status = 'rejected' WHERE id = ? AND status = 'pending'`).run(id);
}
