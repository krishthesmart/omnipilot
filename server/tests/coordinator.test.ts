import { describe, expect, it } from "vitest";
import { coordinate, planSteps } from "../src/coordinator.js";

const DEMO =
  "Research how to improve my project, check my code for issues, create a study plan for the relevant concept, and summarize the findings.";

describe("Coordinator: plans sub-tasks and ordering", () => {
  it("gives each agent only its part of a compound request", () => {
    const steps = planSteps("Explain recursion and write a python function for factorial", ["CodePilot", "LearnPilot"]);
    const byAgent = Object.fromEntries(steps.map((s) => [s.agent, s]));
    expect(byAgent.CodePilot.task).toBe("write a python function for factorial");
    expect(byAgent.LearnPilot.task).toBe("Explain recursion");
  });

  it("orders agents that build on each other's output, and leaves the summary to the Synthesizer", () => {
    const steps = planSteps(DEMO, ["Helper", "CodePilot", "LearnPilot", "PromptPilot"]);
    const byAgent = Object.fromEntries(steps.map((s) => [s.agent, s]));
    expect(byAgent.CodePilot.dependsOn).toEqual(["Helper"]);
    expect(byAgent.LearnPilot.dependsOn).toEqual(["CodePilot"]);
    expect(byAgent.Helper.dependsOn).toEqual([]);
    expect(steps.some((s) => /summari/i.test(s.task) && s.agent !== "PromptPilot")).toBe(false);
  });

  it("never makes a single-agent request wait on anything", () => {
    const [step] = planSteps("Explain photosynthesis for a 5th grader", ["LearnPilot"]);
    expect(step.dependsOn).toEqual([]);
    expect(step.task).toBe("Explain photosynthesis for a 5th grader");
  });

  it("keeps short fragments with the clause they belong to", () => {
    const [step] = planSteps("Explain photosynthesis and respiration", ["LearnPilot"]);
    expect(step.task).toBe("Explain photosynthesis and respiration");
  });

  it("gives a clause that refers back ('...wrong with it') to the agents of the clause before it", () => {
    const steps = planSteps("find the login code and tell me what's wrong with it", ["Helper", "CodePilot"]);
    const byAgent = Object.fromEntries(steps.map((s) => [s.agent, s]));
    expect(byAgent.CodePilot.task).toMatch(/wrong with it/);
    expect(byAgent.CodePilot.dependsOn).toEqual(["Helper"]);
    expect(byAgent.Helper.afterAll).toBeUndefined();
  });

  it("sends a clause no selected agent claims to Helper, deferred until after the others", () => {
    const steps = planSteps("Check my code for bugs and tell me what the weather is like on Mars", ["CodePilot"]);
    const helper = steps.find((s) => s.agent === "Helper")!;
    expect(helper.task).toMatch(/weather/);
    expect(helper.afterAll).toBe(true);
  });
});

describe("Coordinator: executes in waves and passes results along", () => {
  it("runs dependents after their inputs and hands them the upstream results", async () => {
    const steps = planSteps(DEMO, ["Helper", "CodePilot", "LearnPilot", "PromptPilot"]);
    const results = await coordinate({ runId: "c1", requestText: DEMO, context: {} }, steps);
    const byAgent = Object.fromEntries(results.map((r) => [r.agent, r]));

    expect(byAgent.CodePilot.usedResultsFrom).toEqual(["Helper"]);
    expect(byAgent.LearnPilot.usedResultsFrom).toEqual(["CodePilot"]);
    expect(Date.parse(byAgent.LearnPilot.startedAt)).toBeGreaterThanOrEqual(Date.parse(byAgent.CodePilot.completedAt));
    // LearnPilot's own task is vague ("the relevant concept"); CodePilot's findings make it secure coding.
    expect(byAgent.LearnPilot.findings[0]).toMatch(/Secure coding/);
    expect(byAgent.PromptPilot.role).toBe("support");
  });

  it("hands a part an agent couldn't handle to Helper", async () => {
    const request = "Simulate a black hole merger";
    const results = await coordinate({ runId: "c2", requestText: request, context: {} }, planSteps(request, ["ScienceLab"]));
    const helper = results.find((r) => r.agent === "Helper");
    expect(helper?.coveringFor).toBe("ScienceLab");
  });

  it("lets no other agent answer part of a request a specialist blocked on safety grounds", async () => {
    const request = "Can you do my homework for me and submit it so my teacher doesn't notice?";
    const results = await coordinate({ runId: "c3", requestText: request, context: {} }, planSteps(request, ["LearnPilot"]));
    expect(results.map((r) => r.agent)).toEqual(["LearnPilot"]);
    expect(results[0].status).toBe("failed_safe");
  });
});
