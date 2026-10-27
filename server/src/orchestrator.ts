import { fileURLToPath } from "node:url";
import type { AgentInput, AgentName, AgentResult, AgentStatus } from "./types.js";
import { AGENTS, AGENT_BUDGETS } from "./agents/index.js";
import { logAgentAction } from "./agents/base.js";
import { runEventBus } from "./lib/eventBus.js";
import { createApproval } from "./db.js";
import { runSignal } from "./lib/runControl.js";
import { createWebTools } from "./lib/web/webTools.js";
import { researchMinutes } from "./agents/research.js";
import { EDIT_PROJECT, isProjectRequest } from "./agents/projectBuilder.js";

/** The folder agents may read (and, with approval, CodePilot may fix files in). OMNIPILOT_WORKSPACE overrides it. */
import { WORKSPACE_ROOT } from "./lib/workspace.js";
export { WORKSPACE_ROOT };

function isRetryableStatus(status: AgentStatus): boolean {
  return status === "timeout" || status === "unreachable";
}

async function runSingleAttempt(agent: AgentName, input: AgentInput, timeoutMs: number): Promise<Omit<AgentResult, "retries">> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The Stop button aborts the whole run, including this agent.
  const run = runSignal(input.runId);
  const onStop = () => controller.abort();
  if (run?.aborted) controller.abort();
  run?.addEventListener("abort", onStop);

  try {
    const fn = AGENTS[agent];
    const raw = await Promise.race([
      fn(input, { signal: controller.signal, workspaceRoot: WORKSPACE_ROOT, web: createWebTools(input.runId, agent, controller.signal) }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
      }),
    ]);
    const completedAt = new Date().toISOString();
    return { agent, ...raw, startedAt, completedAt, elapsedMs: Date.now() - started };
  } catch (err: any) {
    const completedAt = new Date().toISOString();
    const status: AgentStatus = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "unreachable";
    if (run?.aborted) {
      return { agent, status: "timeout", stopped: true, findings: [`${agent} was stopped.`], evidence: [], confidence: 0, limitations: [], proposedActions: [], startedAt, completedAt, elapsedMs: Date.now() - started };
    }
    logAgentAction(input.runId, agent, "agent_execution", {}, `error: ${status} (${err?.message ?? "unknown"})`);
    return {
      agent,
      status,
      findings: [status === "timeout" ? `${agent} did not complete within its time budget.` : `${agent} raised an unexpected error and could not complete.`],
      evidence: [],
      confidence: 0,
      limitations: ["This agent's result is unavailable; other agents' results are unaffected."],
      proposedActions: [],
      startedAt,
      completedAt,
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    run?.removeEventListener("abort", onStop);
  }
}

/**
 * Runs one agent with its own timeout + a single retry on timeout/unreachable failures.
 * Never throws -- always resolves with a terminal AgentResult, so Promise.all over many
 * agents can't have one agent's failure take down the others.
 */
export async function runAgentIsolated(
  agent: AgentName,
  input: AgentInput,
  annotations: Pick<AgentResult, "task" | "usedResultsFrom" | "coveringFor"> = {}
): Promise<AgentResult> {
  const base = AGENT_BUDGETS[agent];
  // Deep research runs as long as the user asked, plus time to write the report.
  const minutes = agent === "Helper" ? researchMinutes(input.requestText) : null;
  // Building or changing a whole project takes minutes (many files, checks, repairs).
  const bigCode = agent === "CodePilot" && (isProjectRequest(input.requestText) || EDIT_PROJECT.test(input.requestText));
  const budget = minutes
    ? { ...base, timeoutMs: Math.max(base.timeoutMs, minutes * 60_000 + 75_000) }
    : bigCode
      ? { ...base, timeoutMs: Math.max(base.timeoutMs, 360_000) }
      : base;
  runEventBus.publish({ type: "agent_start", runId: input.runId, agent });
  logAgentAction(input.runId, agent, "agent_start", {}, "started");

  let attempt = await runSingleAttempt(agent, input, budget.timeoutMs);
  let retries = 0;

  while (isRetryableStatus(attempt.status) && retries < budget.maxRetries && !runSignal(input.runId)?.aborted) {
    retries += 1;
    runEventBus.publish({ type: "agent_retry", runId: input.runId, agent, attempt: retries });
    logAgentAction(input.runId, agent, "agent_retry", { attempt: retries }, "retrying");
    attempt = await runSingleAttempt(agent, input, budget.timeoutMs);
  }

  const result: AgentResult = { ...attempt, retries, ...annotations };
  logAgentAction(input.runId, agent, "agent_complete", { status: result.status, confidence: result.confidence }, result.status);
  // Record actions awaiting approval before the app hears about them, so an approval card is never
  // clickable before its approval exists.
  for (const a of result.proposedActions.filter((x) => x.requiresApproval)) {
    createApproval({ id: a.id, runId: input.runId, agent, description: a.description, riskLevel: a.riskLevel, createdAt: new Date().toISOString() });
  }
  runEventBus.publish({ type: "agent_complete", runId: input.runId, result });
  return result;
}

/**
 * Default execution mode: launch every selected agent simultaneously. Each is fully
 * isolated (own timeout/retry/terminal status) so a slow or failing agent can never
 * block the others from completing.
 */
export async function runAgentsInParallel(selected: AgentName[], input: Omit<AgentInput, "runId"> & { runId: string }): Promise<AgentResult[]> {
  return Promise.all(selected.map((agent) => runAgentIsolated(agent, input)));
}
