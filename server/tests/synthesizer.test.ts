import { describe, expect, it } from "vitest";
import { synthesize } from "../src/synthesizer/synthesizer.js";
import type { AgentResult, RouterPlan } from "../src/types.js";

function agentResult(overrides: Partial<AgentResult>): AgentResult {
  return {
    agent: "Helper",
    status: "success",
    findings: ["a finding"],
    evidence: [{ source: "file.md:1", detail: "snippet" }],
    confidence: 0.8,
    limitations: ["a limitation"],
    proposedActions: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    elapsedMs: 10,
    retries: 0,
    ...overrides,
  };
}

const plan: RouterPlan = { selectedAgents: ["Helper", "CodePilot"], rationale: {} as any, scores: {} as any };

describe("Synthesizer", () => {
  it("preserves each agent's findings and evidence separately rather than collapsing them", () => {
    const results = [
      agentResult({ agent: "Helper", findings: ["helper finding"] }),
      agentResult({ agent: "CodePilot", findings: ["codepilot finding"] }),
    ];
    const draft = synthesize("r1", "do things", plan, results);
    expect(draft.perAgent.find((p) => p.agent === "Helper")!.findings).toEqual(["helper finding"]);
    expect(draft.perAgent.find((p) => p.agent === "CodePilot")!.findings).toEqual(["codepilot finding"]);
    expect(draft.sources.length).toBe(2);
  });

  it("marks non-success results as partial / gaps instead of silently dropping them", () => {
    const results = [agentResult({ agent: "Helper", status: "timeout", findings: ["Helper did not complete within its time budget."] })];
    const draft = synthesize("r2", "do things", plan, results);
    expect(draft.partialResults).toContain("Helper");
    expect(draft.gaps.some((g) => g.includes("Helper"))).toBe(true);
  });

  it("never invents findings beyond what agents actually returned", () => {
    const results = [agentResult({ agent: "Helper", findings: ["only this exact finding"] })];
    const draft = synthesize("r3", "do things", plan, results);
    expect(draft.summary).toContain("only this exact finding");
    // The synthesizer must not fabricate additional claims not traceable to an agent.
    expect(draft.summary).not.toMatch(/fabricat|invented|made up/i);
  });

  it("flags a confidence disagreement between two agents both touching security topics", () => {
    const results = [
      agentResult({ agent: "Helper", findings: ["no security issues found here"], confidence: 0.9 }),
      agentResult({ agent: "CodePilot", findings: ["possible vulnerability detected"], confidence: 0.3 }),
    ];
    const draft = synthesize("r4", "check security", plan, results);
    expect(draft.disagreements.length).toBeGreaterThan(0);
  });

  it("produces a draft, not a final user-facing response (no approval/clarification fields)", () => {
    const draft = synthesize("r5", "x", plan, [agentResult({})]);
    expect(draft).not.toHaveProperty("approved");
    expect(draft).not.toHaveProperty("clarifyingQuestion");
  });
});
