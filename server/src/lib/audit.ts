import { randomUUID as uuid } from "node:crypto";
import { insertAudit } from "../db.js";
import { runEventBus } from "./eventBus.js";
import type { AuditLogEntry } from "../types.js";

/**
 * Every tool call / agent action is logged here with timestamp, agent, action,
 * parameters, and outcome -- and broadcast to the run's SSE stream for the
 * Activity / Audit panel in the UI.
 */
export function logAudit(params: {
  runId: string;
  agent: string;
  action: string;
  parameters: Record<string, unknown>;
  outcome: string;
}): AuditLogEntry {
  const entry: AuditLogEntry = {
    id: uuid(),
    runId: params.runId,
    timestamp: new Date().toISOString(),
    agent: params.agent,
    action: params.action,
    parameters: redactSecrets(params.parameters),
    outcome: params.outcome,
  };
  insertAudit(entry);
  runEventBus.publish({ type: "audit", runId: entry.runId, entry });
  return entry;
}

const SECRET_KEY_PATTERN = /key|token|secret|password|authorization/i;

/** Defense in depth: never let an API key / token / password reach the log or UI. */
function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      out[k] = "[redacted]";
    } else if (typeof v === "string" && v.length > 500) {
      out[k] = v.slice(0, 500) + "…[truncated]";
    } else {
      out[k] = v;
    }
  }
  return out;
}
