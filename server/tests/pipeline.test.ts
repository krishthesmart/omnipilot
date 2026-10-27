import { describe, expect, it } from "vitest";
import { executeRun } from "../src/pipeline.js";

describe("Full workflow: request -> Router -> parallel specialists -> Synthesizer -> Router review -> final response", () => {
  it("runs the required end-to-end demo request successfully", async () => {
    const record = await executeRun(
      "Research how to improve my project, check my code for issues, create a study plan for the relevant concept, and summarize the findings."
    );

    expect(record.plan!.selectedAgents.sort()).toEqual(["CodePilot", "Helper", "LearnPilot", "PromptPilot"].sort());
    expect(record.agentResults).toHaveLength(4);
    expect(record.draft).toBeDefined();
    expect(record.review).toBeDefined();
    expect(record.review!.approved).toBe(true);
    expect(["completed", "needs_approval"]).toContain(record.status);
    expect(record.finalResponse).toBeDefined();
    expect(record.finalResponse!.summary.length).toBeGreaterThan(0);
    expect(record.finalResponse!.sources.length).toBeGreaterThan(0);
    expect(record.finalResponse!.limitations.length).toBeGreaterThan(0);

    // CodePilot's findings on the seeded vulnerable file surface as high-risk actions. Without the AI
    // model there's no ready-made fix, so they're to-dos for the user (nothing to approve and run).
    const highRisk = record.finalResponse!.nextActions.filter((a) => a.riskLevel === "high");
    expect(highRisk.length).toBeGreaterThan(0);
    expect(highRisk.every((a) => !a.requiresApproval)).toBe(true);
  });

  it("asks a clarifying question instead of fabricating an answer when the request cannot proceed safely", async () => {
    const record = await executeRun("Can you do my homework for me and submit it so my teacher doesn't notice?");
    expect(record.status).toBe("needs_clarification");
    expect(record.review!.approved).toBe(false);
    expect(record.review!.clarifyingQuestion).toBeTruthy();
    expect(record.finalResponse).toBeUndefined();
  });

  it("isolates a single-specialist request without invoking unrelated agents", async () => {
    const record = await executeRun("Check my code for security bugs");
    expect(record.plan!.selectedAgents).toEqual(["CodePilot"]);
    expect(record.status === "completed" || record.status === "needs_approval").toBe(true);
  });

  it("surfaces 'needs_connection' honestly for an unconnected integration rather than pretending success", async () => {
    const record = await executeRun("Connect Slack and schedule a daily status update");
    const infra = record.agentResults!.find((r) => r.agent === "InfraPilot")!;
    expect(infra.status).toBe("needs_connection");
    expect(record.finalResponse!.limitations.join(" ")).toMatch(/connect/i);
  });

  it("every agent result in the final response satisfies the required AgentResult contract", async () => {
    const record = await executeRun("Explain recursion and quiz me");
    for (const r of record.finalResponse!.agentResults) {
      expect(r.agent).toBeTruthy();
      expect(r.status).toBeTruthy();
      expect(Array.isArray(r.findings)).toBe(true);
      expect(Array.isArray(r.evidence)).toBe(true);
      expect(typeof r.confidence).toBe("number");
      expect(Array.isArray(r.limitations)).toBe(true);
      expect(Array.isArray(r.proposedActions)).toBe(true);
    }
  });
});
