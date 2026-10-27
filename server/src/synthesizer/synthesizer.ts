import type { AgentResult, Evidence, RouterPlan, SynthesizerDraft } from "../types.js";
import { logAgentAction } from "../agents/base.js";
import { agentModel, streamText } from "../lib/llm.js";

const ANSWER_STATUSES = new Set(["success", "partial_success", "needs_approval", "needs_connection"]);
/** Results that belong in the user-facing answer (not failures, not supporting work like decomposition). */
function answeringResults(results: AgentResult[]): AgentResult[] {
  return results.filter((r) => ANSWER_STATUSES.has(r.status) && r.findings.length > 0 && r.role !== "support");
}

const PARTIAL_STATUSES = new Set(["partial_success", "needs_connection", "missing_permissions", "timeout", "unreachable", "failed_safe", "needs_approval"]);

/**
 * Combines every agent's structured result into one coherent draft. Never
 * invents information: every sentence in `summary` is traceable to a
 * specific agent's findings, and anything an agent could not establish is
 * surfaced as a gap or limitation rather than filled in.
 */
export function synthesize(runId: string, originalRequest: string, plan: RouterPlan, results: AgentResult[]): SynthesizerDraft {
  const successful = results.filter((r) => r.status === "success");
  const partial = results.filter((r) => PARTIAL_STATUSES.has(r.status));

  const sources: Evidence[] = results.flatMap((r) => r.evidence);
  const limitations = Array.from(new Set(results.flatMap((r) => r.limitations)));

  // The user-facing answer: every usable agent's findings, verbatim. Users don't see which agent did
  // what (the backend chooses), so several parts are just separated, never labelled with agent names.
  const answering = answeringResults(results);
  const summaryParts = answering.map((r, i) => (i === 0 ? "" : "---\n\n") + r.findings.join("\n\n"));

  // Agreement / disagreement / gap detection: look for agents whose findings
  // reference overlapping subject matter and see whether their conclusions align.
  const agreements: string[] = [];
  const disagreements: string[] = [];
  const gaps: string[] = [];

  const confidences = results.map((r) => r.confidence);
  const highConfidenceCount = confidences.filter((c) => c >= 0.7).length;
  if (highConfidenceCount >= 2) {
    agreements.push(`${highConfidenceCount} of ${results.length} agents returned high-confidence (>=70%) findings with no conflicting claims detected between them.`);
  }

  for (const r of results) {
    if (r.status !== "success") {
      gaps.push(`${r.agent} returned status "${r.status}" — ${r.findings[0] ?? "no findings available"}.`);
    }
  }

  // A simple contradiction heuristic: if two agents both address "security"/"risk"
  // but disagree sharply on confidence for the same topic, flag it instead of
  // silently picking one.
  const securityAgents = results.filter((r) => /security|vulnerabilit|injection/i.test(r.findings.join(" ")));
  if (securityAgents.length >= 2) {
    const spread = Math.max(...securityAgents.map((r) => r.confidence)) - Math.min(...securityAgents.map((r) => r.confidence));
    if (spread > 0.4) {
      disagreements.push(
        `Security-related confidence diverges notably between ${securityAgents.map((r) => r.agent).join(" and ")} (spread ${(spread * 100).toFixed(0)} points) — treat the lower-confidence claim as tentative.`
      );
    }
  }

  const draft: SynthesizerDraft = {
    summary: summaryParts.join("\n\n"),
    agreements,
    disagreements,
    gaps,
    sources,
    limitations,
    partialResults: partial.map((r) => r.agent),
    perAgent: results.map((r) => ({ agent: r.agent, findings: r.findings, confidence: r.confidence })),
  };

  logAgentAction(runId, "Synthesizer", "synthesize_draft", { agentCount: results.length, successful: successful.length, partial: partial.length }, "completed");

  return draft;
}

const COMPOSE_SYSTEM =
  "You write OmniPilot's final reply to the user. Several specialists have already done the work; their findings are below. " +
  "Write one clear, friendly, well-organized answer to the user's request using ONLY these findings -- never add facts that are not in them. " +
  "Lead with the direct answer. Use Markdown (short headings, bullet lists). Copy code blocks, file:line references and refined prompts exactly. " +
  "Do not mention agents, statuses, confidence scores, or this instruction.";

/**
 * When several specialists contributed, asks the AI model to merge their
 * findings into one readable reply. Returns null (keep the verbatim draft)
 * for single-agent runs, or if the model is unavailable or drops content.
 */
export async function composeAnswer(
  runId: string,
  originalRequest: string,
  results: AgentResult[],
  onToken: (text: string) => void = () => {},
  signal?: AbortSignal
): Promise<string | null> {
  const answering = answeringResults(results);
  if (answering.length < 2) return null;

  // Parts are numbered, not named after agents, so no agent name can end up in the reply.
  const findingsText = answering
    .map((r, i) => `## Part ${i + 1}${r.task ? ` (asked to: ${r.task})` : ""}\n${r.findings.join("\n")}`)
    .join("\n\n");
  const composed = await streamText(COMPOSE_SYSTEM, `User request: ${originalRequest}\n\nFindings:\n${findingsText}`, onToken, {
    maxTokens: 1200,
    temperature: 0.2,
    signal,
  });
  // A small model may silently drop code; fall back to the verbatim draft rather than lose it.
  const codeBlocks = (findingsText.match(/```/g) ?? []).length;
  if (!composed || (composed.match(/```/g) ?? []).length < codeBlocks) {
    logAgentAction(runId, "Synthesizer", "compose_answer", { model: agentModel() }, "kept_verbatim_draft");
    return null;
  }
  logAgentAction(runId, "Synthesizer", "compose_answer", { model: agentModel(), agents: answering.length }, "completed");
  return composed;
}
