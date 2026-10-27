import type { AgentResult, RouterPlan, RouterReview, SynthesizerDraft } from "../types.js";
import { logAgentAction } from "../agents/base.js";

const USEFUL_STATUSES = new Set(["success", "partial_success", "needs_approval", "needs_connection"]);

/**
 * The Router's second pass: review the Synthesizer's draft for correctness,
 * missing evidence, contradictions, and unclear claims before it ever
 * reaches the user. The Router does no specialist work here -- only
 * verification and light editorial tightening of the draft it was given.
 */
export function reviewDraft(runId: string, originalRequest: string, plan: RouterPlan, results: AgentResult[], draft: SynthesizerDraft): RouterReview {
  const adjustments: string[] = [];

  const usefulResults = results.filter((r) => USEFUL_STATUSES.has(r.status));
  const allBlocked = usefulResults.length === 0;

  // A specialist refused on safety grounds: still one focused question (never a made-up answer),
  // but it leads with why, and with what can be done instead.
  const refusals = results.filter((r) => r.status === "failed_safe" && !r.findings.some((f) => /^Not implemented/i.test(f)));
  if (allBlocked && refusals.length > 0) {
    const reason = refusals.map((r) => r.findings[0]).filter(Boolean).join(" ");
    const question = `${reason}\n\nWhat would you like to do instead?`;
    logAgentAction(runId, "Router", "review_draft", { outcome: "refused", agents: refusals.map((r) => r.agent) }, "blocked on safety grounds");
    return {
      approved: false,
      clarifyingQuestion: question,
      adjustments: [`Blocked on safety grounds by ${refusals.map((r) => r.agent).join(", ")}.`],
      finalSummary: "",
      finalLimitations: draft.limitations,
      finalConfidence: 0,
    };
  }

  if (allBlocked) {
    const question = `None of the selected specialists (${plan.selectedAgents.join(", ")}) could produce a usable result for "${originalRequest.slice(0, 120)}". Could you clarify or narrow the request (e.g. point to a specific file, topic, or integration)?`;
    logAgentAction(runId, "Router", "review_draft", { outcome: "clarification_needed" }, question);
    return {
      approved: false,
      clarifyingQuestion: question,
      adjustments: ["All selected agents returned a blocked/failed/unusable status; cannot safely synthesize a response."],
      finalSummary: "",
      finalLimitations: draft.limitations,
      finalConfidence: 0,
    };
  }

  // 1. Did the response answer the request? -- check every top-level agent is represented.
  const missingAgents = plan.selectedAgents.filter((a) => !results.some((r) => r.agent === a));
  if (missingAgents.length > 0) {
    adjustments.push(`Planned agent(s) ${missingAgents.join(", ")} did not return a result and are reported as unreachable.`);
  }

  // 2. Are claims supported by evidence?
  const unsupported = results.filter((r) => r.status === "success" && r.evidence.length === 0 && r.findings.length > 0);
  if (unsupported.length > 0) {
    adjustments.push(`${unsupported.map((r) => r.agent).join(", ")} returned findings without attached evidence; treat those as lower-certainty summaries.`);
  }

  // 3. Contradictions / missing info already surfaced by Synthesizer -- carry them forward explicitly.
  if (draft.disagreements.length > 0) adjustments.push(`Disagreement disclosed: ${draft.disagreements.join(" ")}`);
  if (draft.gaps.length > 0) adjustments.push(`Gap disclosed: ${draft.gaps.join(" ")}`);

  // 4. Unsafe / unapproved actions must never be auto-executed -- only ever proposed.
  const pendingApprovals = results.flatMap((r) => r.proposedActions.filter((a) => a.requiresApproval));
  if (pendingApprovals.length > 0) {
    adjustments.push(`${pendingApprovals.length} proposed action(s) require explicit approval before any write/external effect — none were executed automatically.`);
  }

  // 5 & 6. The final answer is the draft itself; only failures that leave a part of the
  // request unanswered get a short note (partial results already carry their caveats).
  // A specialist that was asked but doesn't cover this topic ("Not implemented") isn't worth
  // mentioning when another one answered: nothing in the request is left unanswered.
  const someoneAnswered = results.some((r) => ["success", "partial_success"].includes(r.status) && r.role !== "support");
  const failureNotes = results
    .filter((r) => !["success", "partial_success"].includes(r.status))
    .filter((r) => !(someoneAnswered && /^Not implemented/i.test(r.findings[0] ?? "")))
    .filter((r) => !r.stopped)
    // In plain words, without agent names or internal statuses (those are in the Activity tab).
    .map((r) => `- ${r.status === "timeout" ? "Part of this took too long and was stopped" : r.status === "needs_connection" ? "This needs a connection set up first" : "Part of this couldn't be done"}${r.findings[0] ? `: ${r.findings[0].replace(new RegExp(`\\b${r.agent}\\b`, "g"), "it")}` : "."}`);

  const finalSummary = [draft.summary, failureNotes.length ? `**Couldn't fully complete:**\n${failureNotes.join("\n")}` : ""]
    .filter(Boolean)
    .join("\n\n");

  // Users don't see agent names; which part was unreachable is in the Activity tab and the review notes.
  const finalLimitations = Array.from(new Set([...draft.limitations, ...(missingAgents.length ? ["Part of this request couldn't be handled, so the answer may be incomplete."] : [])]));

  const finalConfidence = usefulResults.length
    ? Math.round((usefulResults.reduce((s, r) => s + r.confidence, 0) / usefulResults.length) * 100) / 100
    : 0;

  logAgentAction(runId, "Router", "review_draft", { outcome: "approved", adjustments: adjustments.length }, "approved");

  return {
    approved: true,
    adjustments,
    finalSummary,
    finalLimitations,
    finalConfidence,
  };
}
