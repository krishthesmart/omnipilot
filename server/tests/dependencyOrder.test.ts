import { describe, expect, it } from "vitest";
import { coordinate, planSteps } from "../src/coordinator.js";
import { runEventBus } from "../src/lib/eventBus.js";

// Finding 5: Helper/CodePilot dependency ordering.
const REQUEST = "Find the login code in my project and check it for security bugs, and tell me a fun fact about owls";

describe("Finding 5: a step that builds on Helper waits for Helper", () => {
  it("plans Helper's own part first and the unclaimed part last", () => {
    const steps = planSteps(REQUEST, ["Helper", "CodePilot"]);
    const helperSteps = steps.filter((s) => s.agent === "Helper");
    expect(helperSteps.map((s) => Boolean(s.afterAll))).toEqual([false, true]);
    expect(helperSteps[1].task).toMatch(/owls/);
    expect(steps.find((s) => s.agent === "CodePilot")?.dependsOn).toEqual(["Helper"]);
  });

  it("runs Helper before CodePilot and passes Helper's results on", async () => {
    const order: string[] = [];
    const listener = (e: any) => e.type === "agent_start" && e.runId === "dep-order" && order.push(e.agent);
    runEventBus.on("*", listener);
    const results = await coordinate({ runId: "dep-order", requestText: REQUEST, context: {} }, planSteps(REQUEST, ["Helper", "CodePilot"]));
    runEventBus.off("*", listener);
    expect(order).toEqual(["Helper", "CodePilot", "Helper"]);
    expect(results.find((r) => r.agent === "CodePilot")?.usedResultsFrom).toEqual(["Helper"]);
    // One Helper result covering both of its parts.
    const helper = results.filter((r) => r.agent === "Helper");
    expect(helper).toHaveLength(1);
    expect(helper[0].task).toMatch(/login code.*owls/);
  });

  it("keeps the old single late Helper step when nothing depends on Helper", () => {
    const steps = planSteps("Teach me fractions and tell me a fun fact about owls", ["LearnPilot", "Helper"]);
    expect(steps.filter((s) => s.agent === "Helper").length).toBe(1);
  });
});
