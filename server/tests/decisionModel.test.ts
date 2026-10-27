import { describe, expect, it } from "vitest";
import { decideAgents } from "../src/router/decisionModel.js";

describe("Router decision model", () => {
  it("selects Helper, CodePilot, LearnPilot, and PromptPilot for the required end-to-end demo request", () => {
    const plan = decideAgents(
      "Research how to improve my project, check my code for issues, create a study plan for the relevant concept, and summarize the findings."
    );
    expect(new Set(plan.selectedAgents)).toEqual(new Set(["Helper", "CodePilot", "LearnPilot", "PromptPilot"]));
  });

  it("routes a code-only request to just CodePilot", () => {
    const plan = decideAgents("Can you check my code for security vulnerabilities?");
    expect(plan.selectedAgents).toEqual(["CodePilot"]);
  });

  it("routes a study-only request to just LearnPilot", () => {
    const plan = decideAgents("Explain the concept of photosynthesis and quiz me, grade 6");
    expect(plan.selectedAgents).toEqual(["LearnPilot"]);
  });

  it("runs CodePilot and LearnPilot in parallel for a combined code+study request", () => {
    const plan = decideAgents("Check this code and create a study plan for the issue");
    expect(new Set(plan.selectedAgents)).toEqual(new Set(["CodePilot", "LearnPilot"]));
  });

  it("selects InfraPilot for integration/workflow requests", () => {
    const plan = decideAgents("Can you connect Slack and schedule a daily workflow?");
    expect(plan.selectedAgents).toContain("InfraPilot");
  });

  it("selects ScriptScholar for ancient-script comparisons", () => {
    const plan = decideAgents("Compare cuneiform and hieroglyphs");
    expect(plan.selectedAgents).toEqual(["ScriptScholar"]);
  });

  it("selects ScienceLab for simulation requests", () => {
    const plan = decideAgents("Simulate a projectile launched at 30 m/s");
    expect(plan.selectedAgents).toEqual(["ScienceLab"]);
  });

  it("falls back to Helper (read-only) when nothing matches, rather than selecting nothing", () => {
    const plan = decideAgents("hello");
    expect(plan.selectedAgents).toEqual(["Helper"]);
  });

  it("never performs specialist work itself -- only returns a plan, not findings", () => {
    const plan = decideAgents("check my code");
    expect(plan).not.toHaveProperty("findings");
    expect(plan).not.toHaveProperty("evidence");
  });
});
