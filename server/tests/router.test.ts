import { describe, expect, it } from "vitest";
import { reviewDraft } from "../src/router/router.js";
import { synthesize } from "../src/synthesizer/synthesizer.js";
import type { AgentResult, RouterPlan } from "../src/types.js";

function agentResult(overrides: Partial<AgentResult>): AgentResult {
  return {
    agent: "Helper",
    status: "success",
    findings: ["a finding"],
    evidence: [{ source: "file.md:1", detail: "snippet" }],
    confidence: 0.8,
    limitations: [],
    proposedActions: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    elapsedMs: 10,
    retries: 0,
    ...overrides,
  };
}

const plan: RouterPlan = { selectedAgents: ["Helper"], rationale: {} as any, scores: {} as any };

describe("Router verification pass", () => {
  it("approves a draft backed by at least one usable agent result", () => {
    const results = [agentResult({})];
    const draft = synthesize("r1", "do things", plan, results);
    const review = reviewDraft("r1", "do things", plan, results, draft);
    expect(review.approved).toBe(true);
    expect(review.clarifyingQuestion).toBeUndefined();
  });

  it("asks exactly one focused clarifying question when every selected agent is blocked/unusable", () => {
    const results = [agentResult({ status: "failed_safe", findings: ["blocked for safety reasons"] })];
    const draft = synthesize("r2", "do something unsafe", plan, results);
    const review = reviewDraft("r2", "do something unsafe", plan, results, draft);
    expect(review.approved).toBe(false);
    expect(typeof review.clarifyingQuestion).toBe("string");
    expect(review.clarifyingQuestion!.length).toBeGreaterThan(0);
  });

  it("discloses pending approvals in the review instead of silently executing them", () => {
    const results = [
      agentResult({
        proposedActions: [{ id: "a1", description: "do a risky write", riskLevel: "high", requiresApproval: true }],
      }),
    ];
    const draft = synthesize("r3", "do a write action", plan, results);
    const review = reviewDraft("r3", "do a write action", plan, results, draft);
    expect(review.approved).toBe(true);
    expect(review.adjustments.some((a) => a.includes("require explicit approval"))).toBe(true);
  });

  it("states what failed/was disconnected when some but not all agents are unusable", () => {
    const results = [agentResult({ agent: "Helper", status: "success" }), agentResult({ agent: "CodePilot", status: "needs_connection", findings: ["not connected"] })];
    const mixedPlan: RouterPlan = { selectedAgents: ["Helper", "CodePilot"], rationale: {} as any, scores: {} as any };
    const draft = synthesize("r4", "x", mixedPlan, results);
    const review = reviewDraft("r4", "x", mixedPlan, results, draft);
    expect(review.approved).toBe(true);
    // Said in plain words, without the agent's name (the backend chooses agents; users don't see them).
    expect(review.finalSummary).toMatch(/needs a connection set up first: not connected/);
    expect(review.finalSummary).not.toMatch(/CodePilot/);
  });

  it("reports an unreachable planned agent instead of pretending it ran", () => {
    const results = [agentResult({ agent: "Helper" })];
    const planWithMissing: RouterPlan = { selectedAgents: ["Helper", "ScienceLab"], rationale: {} as any, scores: {} as any };
    const draft = synthesize("r5", "x", planWithMissing, results);
    const review = reviewDraft("r5", "x", planWithMissing, results, draft);
    expect(review.finalLimitations.some((l) => /couldn't be handled/.test(l))).toBe(true);
    expect(review.finalLimitations.join(" ")).not.toMatch(/ScienceLab/);
    expect(review.adjustments.some((a) => a.includes("ScienceLab"))).toBe(true); // still in the review notes
  });
});
