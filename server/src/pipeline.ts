import { randomUUID as uuid } from "node:crypto";
import { aiUnavailableReason } from "./lib/groq.js";
import { governanceCheck, judgeOutcome, notPossibleText, verdictNote } from "./lib/governance.js";
import type { AgentInput, FinalResponse, RunRecord } from "./types.js";
import { routeRequest } from "./router/route.js";
import { coordinate, planSteps } from "./coordinator.js";
import { composeAnswer, synthesize } from "./synthesizer/synthesizer.js";
import { reviewDraft } from "./router/router.js";
import { runEventBus } from "./lib/eventBus.js";
import { logAgentAction } from "./agents/base.js";
import { addConversationRun, createApproval, saveRun } from "./db.js";
import { beginRun, endRun, isCancelled, RunCancelled, throwIfCancelled } from "./lib/runControl.js";
import { CORRECTION, endLessonsFor, learnFromCorrection, useLessonsFor } from "./lib/learning.js";
import { matchInvocation, skillRequest } from "./lib/skills.js";
import { decideAgents } from "./router/decisionModel.js";
import { withRunContext } from "./lib/recorder.js";
import { pythonOwnsRuns, runInPython } from "./lib/pythonBridge.js";
import { appendTurn, getTurns, previousTurnContext, resolveFollowUp } from "./lib/conversation.js";

export function executeRun(message: string, context: Record<string, unknown> = {}, runId: string = uuid(), conversationId?: string): Promise<RunRecord> {
  // Behind the Python front door, the Python engine owns runs (it calls back here for unported agents).
  if (pythonOwnsRuns()) return runInPython(message, context, runId, conversationId);
  return withRunContext(runId, () => runPipeline(message, context, runId, conversationId));
}

async function runPipeline(message: string, context: Record<string, unknown>, runId: string, conversationId?: string): Promise<RunRecord> {
  const createdAt = new Date().toISOString();

  const record: RunRecord = { id: runId, request: message, conversationId, createdAt, status: "running" };
  saveRun({ id: runId, request: message, createdAt, status: record.status, data: record });
  if (conversationId) addConversationRun(conversationId, runId, message);
  const signal = beginRun(runId);
  runEventBus.publish({ type: "run_started", runId, request: message });
  logAgentAction(runId, "System", "run_started", { request: message.slice(0, 300) }, "started");

  let requestText = message;
  const remember = (status: string, answer: string, clarifyingQuestion?: string) => {
    if (conversationId) appendTurn(conversationId, { request: message, standalone: requestText, answer, status, clarifyingQuestion });
  };

  try {
    // 0: a follow-up ("now in javascript", "why?") is rewritten to stand alone, and the
    // previous exchange is passed to every agent so they can build on it.
    const turns = conversationId ? getTurns(conversationId) : [];
    // "/start_my_day" runs a saved skill; "/spanishtutor hola" or "ask SpanishTutor ..." talks to a
    // custom agent (InfraPilot creates both; see lib/skills.ts).
    const invoked = matchInvocation(message);
    if (invoked) {
      logAgentAction(runId, "System", invoked.skill.kind === "agent" ? "custom_agent" : "run_skill", { name: invoked.skill.name }, "started");
      if (invoked.skill.kind === "agent") context = { ...context, customAgent: { name: invoked.skill.label, instructions: invoked.skill.instructions } };
    }
    requestText = invoked
      ? invoked.skill.kind === "skill"
        ? skillRequest(invoked.skill, invoked.extra)
        : invoked.extra || "Introduce yourself in one or two sentences and say what you can help with."
      : await resolveFollowUp(message, turns);
    if (requestText !== message) {
      record.standaloneRequest = requestText;
      runEventBus.publish({ type: "followup_resolved", runId, original: message, standalone: requestText });
      logAgentAction(runId, "System", "resolve_followup", { original: message, standalone: requestText }, "rewritten");
    }
    const previousTurn = previousTurnContext(turns);
    if (previousTurn) context = { ...context, previousTurn };
    // Agents that keep per-conversation state (ModelPilot's current 3D model) need to know which one.
    if (conversationId) context = { ...context, conversationId };

    // A little self-improvement: "no, that's wrong" after an answer becomes a lesson (in the
    // background), and lessons from earlier feedback on similar requests are used for this one.
    if (previousTurn && CORRECTION.test(message)) {
      learnFromCorrection(previousTurn.request, previousTurn.answer, message)
        .then((l) => l && logAgentAction(runId, "System", "learn_lesson", { id: l.id, source: "correction" }, l.lesson))
        .catch(() => {});
    }
    const lessons = useLessonsFor(runId, requestText);
    if (lessons.length) logAgentAction(runId, "System", "use_lessons", { ids: lessons.map((l) => l.id) }, `${lessons.length} lesson(s) from earlier feedback`);

    // Governance: if the whole request is something OmniPilot can't do, say so (with the reason and
    // what it can do instead) rather than sending agents off to produce a weak answer.
    const gate = governanceCheck(requestText);
    if (gate.hits.length) logAgentAction(runId, "System", "governance_check", { limits: gate.hits.map((h) => h.id), whole: gate.whole }, gate.whole ? "not possible" : "partly possible");
    if (gate.whole) {
      const finalResponse: FinalResponse = {
        summary: notPossibleText(gate),
        sources: [],
        limitations: [],
        confidence: 0.95,
        nextActions: [],
        agentResults: [],
        governance: { verdict: "not_possible", reasons: gate.hits.map((h) => h.reason) },
      };
      record.finalResponse = finalResponse;
      record.status = "completed";
      saveRun({ id: runId, request: message, createdAt, status: record.status, data: record });
      remember(record.status, finalResponse.summary);
      runEventBus.publish({ type: "final_response", runId, response: finalResponse });
      return record;
    }

    // 1-4: Router decision model selects specialists, Router launches them simultaneously.
    throwIfCancelled(runId);
    // A custom agent is answered by Helper in that agent's role; everything else is routed as usual.
    const routed = context.customAgent ? { ...decideAgents(requestText), selectedAgents: ["Helper" as const] } : await routeRequest(requestText);
    // An attached lesson file with "quiz me on my notes": LearnPilot teaches from the file itself, so
    // Helper isn't also sent off to search the user's files.
    const plan =
      context.attachedFile && routed.selectedAgents.includes("LearnPilot") && routed.selectedAgents.includes("Helper")
        ? { ...routed, selectedAgents: routed.selectedAgents.filter((a) => a !== "Helper") }
        : routed;
    record.plan = plan;
    runEventBus.publish({ type: "router_plan", runId, plan });
    logAgentAction(
      runId,
      "Router",
      "select_agents",
      { selected: plan.selectedAgents, scores: plan.scores, routingMode: plan.routingMode, modelUsed: plan.modelUsed },
      plan.routingMode === "model" ? `planned via ${plan.modelUsed} (AI model)` : "planned via keyword heuristic"
    );

    // 5-7: each agent gets its own timeout/retry/terminal status; failures are isolated.
    const input: AgentInput = { runId, requestText, context };
    // The Coordinator gives each agent its part of the request, orders agents that build on
    // each other's output, runs independent ones in parallel, and covers any gaps.
    const steps = planSteps(requestText, plan.selectedAgents);
    record.steps = steps;
    runEventBus.publish({ type: "coordinator_plan", runId, steps });
    logAgentAction(runId, "System", "coordinator_plan", { steps: steps.map((s) => ({ agent: s.agent, dependsOn: s.dependsOn })) }, "planned");
    const results = await coordinate(input, steps);
    record.agentResults = results;
    throwIfCancelled(runId);

    // 8: send completed + partial results to the Synthesizer.
    runEventBus.publish({ type: "synthesizer_start", runId });
    logAgentAction(runId, "Synthesizer", "synthesize_draft", { agents: results.map((r) => r.agent) }, "started");
    const draft = synthesize(runId, requestText, plan, results);
    const composed = await composeAnswer(
      runId,
      requestText,
      results,
      (delta) => runEventBus.publish({ type: "answer_delta", runId, delta }),
      signal
    );
    throwIfCancelled(runId);
    if (composed) draft.summary = composed;
    record.draft = draft;
    runEventBus.publish({ type: "synthesizer_draft", runId, draft });

    // 9: Router reviews the draft for correctness, gaps, contradictions, missing limitations.
    runEventBus.publish({ type: "router_review_start", runId });
    const review = reviewDraft(runId, requestText, plan, results, draft);
    record.review = review;
    runEventBus.publish({ type: "router_review", runId, review });

    if (!review.approved && review.clarifyingQuestion) {
      record.status = "needs_clarification";
      saveRun({ id: runId, request: message, createdAt, status: record.status, data: record });
      remember(record.status, "", review.clarifyingQuestion);
      runEventBus.publish({ type: "clarification_needed", runId, question: review.clarifyingQuestion });
      return record;
    }

    // Any action requiring approval is recorded and surfaced -- never auto-executed.
    const pendingActions = results.flatMap((r) => r.proposedActions.filter((a) => a.requiresApproval).map((a) => ({ ...a, agent: r.agent })));
    for (const a of pendingActions) {
      createApproval({ id: a.id, runId, agent: a.agent, description: a.description, riskLevel: a.riskLevel, createdAt: new Date().toISOString() });
    }

    // Governance, after the fact: say plainly what couldn't be done, and don't dress up nothing.
    const verdict = judgeOutcome(gate, results, aiUnavailableReason());
    const note = verdictNote(verdict, gate);
    if (note) logAgentAction(runId, "System", "governance_verdict", { verdict: verdict.verdict, reasons: verdict.reasons.length }, verdict.verdict);
    const finalResponse: FinalResponse = {
      summary: verdict.verdict === "not_possible" ? note! : note ? `${note}\n\n${review.finalSummary}` : review.finalSummary,
      governance: verdict,
      sources: draft.sources,
      limitations: review.finalLimitations,
      confidence: review.finalConfidence,
      nextActions: results.flatMap((r) => r.proposedActions),
      agentResults: results,
      attachments: results.flatMap((r) => r.attachments ?? []),
    };
    record.finalResponse = finalResponse;
    record.status = pendingActions.length > 0 ? "needs_approval" : "completed";
    saveRun({ id: runId, request: message, createdAt, status: record.status, data: record });
    remember(record.status, finalResponse.summary);

    logAgentAction(runId, "Router", "final_response", { pendingApprovals: pendingActions.length }, "completed");
    runEventBus.publish({ type: "final_response", runId, response: finalResponse });

    return record;
  } catch (err: any) {
    if (err instanceof RunCancelled || isCancelled(runId)) {
      record.status = "cancelled";
      saveRun({ id: runId, request: message, createdAt, status: record.status, data: record });
      logAgentAction(runId, "System", "run_cancelled", {}, "stopped by the user");
      runEventBus.publish({ type: "run_cancelled", runId });
      return record;
    }
    record.status = "failed";
    saveRun({ id: runId, request: message, createdAt, status: record.status, data: record });
    logAgentAction(runId, "System", "run_failed", {}, err?.message ?? "unknown error");
    runEventBus.publish({ type: "run_failed", runId, error: err?.message ?? "unknown error" });
    return record;
  } finally {
    endLessonsFor(runId);
    endRun(runId);
  }
}
