import { randomUUID as uuid } from "node:crypto";
import type { AgentInput, AgentName, AgentResult, AgentStatus, Evidence, PriorResult, ProposedAction, RiskLevel } from "../types.js";
import { logAudit } from "../lib/audit.js";
import type { WebTools } from "../lib/web/webTools.js";

export interface AgentContext {
  signal: AbortSignal;
  workspaceRoot: string;
  /** Read-only web tools (Browserbase), limited and logged per attempt; absent when not configured. */
  web?: WebTools | null;
}

export type AgentFn = (
  input: AgentInput,
  ctx: AgentContext
) => Promise<Omit<AgentResult, "startedAt" | "completedAt" | "elapsedMs" | "retries" | "agent" | "task" | "usedResultsFrom" | "coveringFor">>;

/** Results from agents this one depends on, as passed by the Coordinator. */
export function priorResults(input: AgentInput): PriorResult[] {
  return Array.isArray(input.context.priorResults) ? (input.context.priorResults as PriorResult[]) : [];
}

/** Prior agents' findings as plain text for a prompt, capped so a small model's context isn't flooded. */
export function priorResultsText(prior: PriorResult[], maxChars = 2500): string {
  return prior
    .map((p) => `[${p.agent}${p.task ? ` -- ${p.task}` : ""}]\n${p.findings.join("\n")}`)
    .join("\n\n")
    .slice(0, maxChars);
}

export function proposedAction(description: string, riskLevel: RiskLevel, requiresApproval = riskLevel !== "low"): ProposedAction {
  return { id: uuid(), description, riskLevel, requiresApproval };
}

export function evidence(source: string, detail: string): Evidence {
  return { source, detail };
}

export function assertNotAborted(ctx: AgentContext) {
  if (ctx.signal.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }
}

export function logAgentAction(runId: string, agent: AgentName | "Router" | "Synthesizer" | "System", action: string, parameters: Record<string, unknown>, outcome: string) {
  logAudit({ runId, agent, action, parameters, outcome });
}

export const emptyResultShape = (status: AgentStatus, findings: string[] = [], limitations: string[] = []) => ({
  status,
  findings,
  evidence: [] as Evidence[],
  confidence: 0,
  limitations,
  proposedActions: [] as ProposedAction[],
});

/** The previous exchange in this conversation, formatted to append to a model prompt ("" when there is none). */
export function previousTurnText(input: AgentInput): string {
  const prev = input.context.previousTurn as { request?: string; answer?: string } | undefined;
  if (!prev?.request) return "";
  return `\n\nEarlier in this conversation (use it if the request refers to it):\nUser asked: ${prev.request}\nYou answered:\n${prev.answer ?? ""}`;
}
