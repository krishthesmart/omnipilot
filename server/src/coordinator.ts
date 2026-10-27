import type { AgentInput, AgentName, AgentResult, CoordinatorStep, PriorResult } from "./types.js";
import { keywordScores } from "./router/decisionModel.js";
import { AGENT_SPECS, REVIEW_INTENT } from "./agents/registry.js";
import { generateJson, majorityVote } from "./lib/llm.js";
import { AGENT_NAMES } from "./types.js";
import { splitClauses } from "./agents/promptPilot.js";
import { runAgentIsolated } from "./orchestrator.js";
import { runEventBus } from "./lib/eventBus.js";
import { logAgentAction } from "./agents/base.js";
import { isCancelled } from "./lib/runControl.js";

/**
 * The Coordinator sits between the Router's agent selection and the
 * Synthesizer. Where the Router decides *who* is needed, the Coordinator
 * decides *what each one does and in what order*:
 *   1. plan    -- split the request into clauses and give each agent only its part;
 *   2. order   -- agents that build on another's output wait for it (e.g. LearnPilot
 *                 teaches what CodePilot found, CodePilot scans what Helper found);
 *   3. execute -- run in waves: everything whose inputs are ready runs in parallel,
 *                 with upstream results passed in as context.priorResults;
 *   4. reflect -- look at what came back and decide whether a next step is needed
 *                 (e.g. Helper found code you asked to have checked -> CodePilot), the
 *                 way a lead re-plans after each round of results;
 *   5. cover   -- if an agent couldn't handle its part, hand that part to Helper.
 */


/** Clauses that ask for the combined answer itself -- the Synthesizer handles these. */
export const SYNTHESIS_CLAUSE = /^(and\s+)?(then\s+)?(summari[sz]e|combine|wrap up|give me (a|the) summary)\b/i;

/** A clause that starts a new instruction or question, rather than continuing a description. */
export const NEW_INSTRUCTION =
  /^(and\s+)?(then\s+)?(also\s+)?(what|how|why|when|where|who|which|is|are|can|could|would|do|does|explain|tell|write|give|list|find|show me how|teach|help|make|create|check|compare|summari[sz]e|translate|solve|calculate)\b/i;

/** "Not implemented" / "needs the AI model" -- the agent ran but couldn't do the work. */
export const CANNOT_HANDLE = /^(Not implemented|Code generation needs the AI model)/i;
export const FAILED_STATUSES = new Set(["timeout", "unreachable"]);

export function planSteps(requestText: string, selected: AgentName[]): CoordinatorStep[] {
  const workers: AgentName[] = selected.filter((a) => a !== "PromptPilot");

  // Short fragments ("... photosynthesis and respiration") belong to the previous clause.
  const clauses: string[] = [];
  for (const clause of splitClauses(requestText)) {
    if (clauses.length && clause.split(/\s+/).length < 3) clauses[clauses.length - 1] += ` and ${clause}`;
    else clauses.push(clause);
  }

  const assigned = new Map<AgentName, string[]>();
  const orphans: string[] = [];
  let previousOwners: AgentName[] = [];
  // Helper alone: nothing to divide (it would cover every clause anyway), so it gets the request as written.
  // Another lone specialist still has its unclaimed clauses covered by Helper below.
  for (const clause of workers.length === 1 && workers[0] === "Helper" ? [] : clauses) {
    if (SYNTHESIS_CLAUSE.test(clause)) continue;
    const scores = keywordScores(clause);
    let owners = workers.filter((a) => scores[a] > 0);
    // An unclaimed clause that refers back ("...and tell me what's wrong with it") continues the one before it.
    if (owners.length === 0 && /\b(it|its|them|that|this|these|those)\b/i.test(clause)) owners = previousOwners;
    // "Draw a cat and a dog under a rainbow": the second half is more of the same picture.
    if (owners.length === 0 && previousOwners.some((a) => AGENT_SPECS[a].describesOneThing) && !NEW_INSTRUCTION.test(clause)) owners = previousOwners;
    // "Simulate population growth starting with 50 rabbits, growth rate of 20%, carrying capacity of 500":
    // a piece that doesn't start a new instruction is a detail of the one before it, not a new task.
    if (owners.length === 0 && previousOwners.length && !NEW_INSTRUCTION.test(clause)) owners = previousOwners;
    if (owners.length === 0) orphans.push(clause);
    for (const a of owners) assigned.set(a, [...(assigned.get(a) ?? []), clause]);
    previousOwners = owners;
  }

  const steps: CoordinatorStep[] = workers.map((agent) => {
    const parts = assigned.get(agent);
    const task = parts?.length ? parts.join(AGENT_SPECS[agent].describesOneThing ? " and " : "; ") : requestText.trim();
    // `when` looks at the whole request: splitting "find X and tell me what's wrong" mustn't hide the review intent.
    const deps = (AGENT_SPECS[agent].buildsOn ?? []).filter(
      (d) => workers.includes(d.agent) && (!d.when || d.when.test(task) || d.when.test(requestText))
    );
    return {
      agent,
      task,
      dependsOn: deps.map((d) => d.agent),
      reason: deps.length
        ? deps.map((d) => d.reason).join("; ")
        : parts?.length
          ? `handles: ${parts.join("; ")}`
          : "handles the whole request",
    };
  });

  // A clause no selected agent claims is still part of the request: Helper covers it last,
  // so a safety block on any other part of the request can veto it.
  if (orphans.length && assigned.size > 0) {
    const helper = steps.find((s) => s.agent === "Helper");
    const helperNeededFirst = steps.some((s) => s.dependsOn.includes("Helper"));
    if (helper && helperNeededFirst) {
      // Another step builds on Helper (e.g. CodePilot scans the files Helper finds), so Helper's own part
      // runs first; the unclaimed part is a separate, later Helper step, still subject to the safety veto.
      steps.push({ agent: "Helper", task: orphans.join("; "), dependsOn: [], reason: `covers the part no other specialist claimed: ${orphans.join("; ")}`, afterAll: true });
    } else if (helper) Object.assign(helper, { task: [helper.task, ...orphans].join("; "), afterAll: true });
    else steps.push({ agent: "Helper", task: orphans.join("; "), dependsOn: [], reason: `covers the part no other specialist claimed: ${orphans.join("; ")}`, afterAll: true });
  }

  // PromptPilot (when selected) runs first, in parallel: it documents the decomposition.
  if (selected.includes("PromptPilot")) {
    steps.unshift({ agent: "PromptPilot", task: requestText.trim(), dependsOn: [], reason: "decomposes the request into per-specialist prompts" });
  }
  return steps;
}

/** One agent's two parts of a run (its own task, then the unclaimed part) as a single result. */
export function mergeResults(a: AgentResult, b: AgentResult): AgentResult {
  const ok = (r: AgentResult) => r.status === "success" || r.status === "partial_success";
  return {
    ...a,
    status: a.status === "success" && b.status === "success" ? "success" : ok(a) || ok(b) ? "partial_success" : b.status,
    findings: [...a.findings, ...b.findings],
    evidence: [...a.evidence, ...b.evidence],
    confidence: Math.min(a.confidence, b.confidence),
    limitations: [...new Set([...a.limitations, ...b.limitations])],
    proposedActions: [...a.proposedActions, ...b.proposedActions],
    attachments: [...(a.attachments ?? []), ...(b.attachments ?? [])],
    task: [a.task, b.task].filter(Boolean).join("; "),
    completedAt: b.completedAt,
    elapsedMs: a.elapsedMs + b.elapsedMs,
    retries: Math.max(a.retries, b.retries),
  };
}

function toPrior(r: AgentResult): PriorResult {
  return { agent: r.agent, task: r.task, findings: r.findings, evidence: r.evidence };
}

function stepInput(base: AgentInput, step: CoordinatorStep, done: Map<AgentName, AgentResult>): AgentInput {
  const prior = step.dependsOn.map((a) => done.get(a)).filter((r): r is AgentResult => Boolean(r));
  return {
    ...base,
    requestText: step.task,
    context: { ...base.context, originalRequest: base.requestText, priorResults: prior.map(toPrior) },
  };
}

export async function coordinate(base: AgentInput, steps: CoordinatorStep[]): Promise<AgentResult[]> {
  const done = new Map<AgentName, AgentResult>();
  let pending = steps.filter((s) => !s.afterAll);

  while (pending.length && !isCancelled(base.runId)) {
    // A dependency outside the plan (or a cycle) never blocks: treat it as satisfied.
    const inPlan = new Set(pending.map((s) => s.agent));
    const ready = pending.filter((s) => s.dependsOn.every((d) => done.has(d) || !inPlan.has(d)));
    const wave = ready.length ? ready : pending;
    pending = pending.filter((s) => !wave.includes(s));

    logAgentAction(base.runId, "System", "coordinator_wave", { agents: wave.map((s) => s.agent) }, "started");
    const results = await Promise.all(
      wave.map((step) =>
        runAgentIsolated(step.agent, stepInput(base, step, done), {
          task: step.task,
          usedResultsFrom: step.dependsOn.filter((d) => done.has(d)),
        })
      )
    );
    for (const r of results) done.set(r.agent, r);
  }

  // Stopped by the user: no follow-up steps or gap cover.
  if (isCancelled(base.runId)) return Array.from(done.values());

  // A safety block anywhere stops the run here: no other agent may answer part of a blocked request.
  // (Some agents also use failed_safe for "Not implemented"; that's a gap to cover, not a block.)
  if (Array.from(done.values()).some((r) => r.status === "failed_safe" && !r.findings.some((f) => CANNOT_HANDLE.test(f)))) {
    logAgentAction(base.runId, "System", "coordinator_followup", {}, "skipped: a specialist blocked the request on safety grounds");
    return Array.from(done.values());
  }

  // Reflect: one extra round if the results so far point to a specialist that hasn't run.
  const next = await reflect(base, done);
  if (next) {
    runEventBus.publish({ type: "coordinator_followup", runId: base.runId, step: next });
    logAgentAction(base.runId, "System", "coordinator_reflect", { agent: next.agent, task: next.task, reason: next.reason }, "added_step");
    done.set(next.agent, await runAgentIsolated(next.agent, stepInput(base, next, done), { task: next.task, usedResultsFrom: next.dependsOn }));
  }

  for (const step of steps.filter((s) => s.afterAll)) {
    const result = await runAgentIsolated(step.agent, stepInput(base, step, done), { task: step.task });
    const earlier = done.get(step.agent);
    done.set(step.agent, earlier ? mergeResults(earlier, result) : result);
  }

  // Cover gaps: an agent that couldn't do its part hands it to Helper (if Helper isn't already busy with it).
  if (!done.has("Helper")) {
    const nobodyAnswered = Array.from(done.values()).every((r) => r.role === "support");
    if (nobodyAnswered) {
      const step: CoordinatorStep = { agent: "Helper", task: base.requestText, dependsOn: [], reason: "answers directly: no specialist had a task for this request" };
      runEventBus.publish({ type: "coordinator_followup", runId: base.runId, step });
      done.set("Helper", await runAgentIsolated("Helper", stepInput(base, step, done), { task: step.task }));
      return Array.from(done.values());
    }
    const gap = Array.from(done.values()).find(
      (r) => r.agent !== "PromptPilot" && (FAILED_STATUSES.has(r.status) || r.findings.some((f) => CANNOT_HANDLE.test(f)))
    );
    if (gap) {
      const step: CoordinatorStep = { agent: "Helper", task: gap.task ?? base.requestText, dependsOn: [], reason: `covers the part ${gap.agent} couldn't handle` };
      runEventBus.publish({ type: "coordinator_followup", runId: base.runId, step });
      logAgentAction(base.runId, "System", "coordinator_followup", { coveringFor: gap.agent, task: step.task }, "started");
      const cover = await runAgentIsolated("Helper", stepInput(base, step, done), { task: step.task, coveringFor: gap.agent });
      done.set("Helper", cover);
    }
  }

  return Array.from(done.values());
}

export const CODE_FILE = /\.(js|ts|jsx|tsx|py|go)(:\d+)?$/;

export const REFLECT_SYSTEM =
  "You are the lead of a team of specialists. Given the user's request and what each specialist returned, decide whether part of the request is still unanswered. " +
  "If it is, name the ONE specialist who should handle the missing part and give them a short task. If everything was answered, say complete. " +
  `Specialists: ${AGENT_NAMES.map((a) => `${a} (${AGENT_SPECS[a].description})`).join("; ")}`;

export const REFLECT_SCHEMA = {
  type: "object",
  properties: {
    complete: { type: "boolean" },
    next_agent: { type: "string", enum: [...AGENT_NAMES, "none"] },
    task: { type: "string" },
  },
  required: ["complete", "next_agent", "task"],
};

/**
 * Decides on at most one follow-up step after the planned work is done.
 * A deterministic rule covers the common hand-off (files found -> code review);
 * otherwise the AI model is asked once and its answer is
 * used, guarded so it can't re-run an agent, pick a narrow specialist off-topic,
 * or continue past a safety block.
 */
export async function reflect(base: AgentInput, done: Map<AgentName, AgentResult>): Promise<CoordinatorStep | null> {
  const results = Array.from(done.values());
  if (results.some((r) => r.status === "failed_safe" && !r.findings.some((f) => CANNOT_HANDLE.test(f)))) return null;

  // Rule: the user asked what's wrong / to check something, Helper found code, CodePilot hasn't looked.
  const helper = done.get("Helper");
  const codePilot = done.get("CodePilot");
  if (
    helper &&
    (!codePilot || codePilot.role === "support") &&
    REVIEW_INTENT.test(base.requestText) &&
    helper.evidence.some((e) => CODE_FILE.test(e.source))
  ) {
    return { agent: "CodePilot", task: base.requestText, dependsOn: ["Helper"], reason: "reviews the code files Helper found" };
  }

  if (done.size >= 4) return null; // already a broad run; don't keep expanding it
  // Answered from web pages just read: the request is covered (a small model otherwise tends to
  // suggest "write a scraper for that page", which nobody asked for).
  if (helper?.status === "success" && helper.evidence.some((e) => e.source.startsWith("web:"))) return null;
  const answered = results
    .filter((r) => r.role !== "support" && r.findings.length)
    .map((r) => `[${r.agent}${r.task ? ` -- ${r.task}` : ""}] ${r.findings.join(" ").slice(0, 600)}`)
    .join("\n");
  const prompt = `User request: ${base.requestText}\n\nWhat the specialists returned:\n${answered || "(nothing)"}`;

  const tasks = new Map<string, string>();
  const vote = await majorityVote(async () => {
    const r = await generateJson<{ complete: boolean; next_agent: string; task: string }>(REFLECT_SYSTEM, prompt, {
      schema: REFLECT_SCHEMA,
      temperature: 0.2,
      maxTokens: 120,
    });
    if (!r) return null;
    if (r.complete || r.next_agent === "none") return "none";
    if (r.task && !tasks.has(r.next_agent)) tasks.set(r.next_agent, r.task);
    return r.next_agent;
    // One careful look: a large model doesn't need the vote of three small ones did (and it saves tokens).
  }, 1);
  if (!vote || vote === "none") return null;

  const agent = vote as AgentName;
  const onTopic = keywordScores(base.requestText)[agent] > 0;
  // Writing code or prompts only when the request is about that.
  if (done.has(agent) || ((AGENT_SPECS[agent].narrow || agent === "PromptPilot" || agent === "CodePilot") && !onTopic)) return null;

  return {
    agent,
    task: tasks.get(agent)?.trim() || base.requestText,
    dependsOn: results.filter((r) => r.role !== "support").map((r) => r.agent),
    reason: "added after reviewing the first results: part of the request was still unanswered",
  };
}
