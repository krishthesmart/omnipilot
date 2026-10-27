import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { routeRequest } from "../src/router/route.js";

function mockModelResponse(agents: string[]) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ agents }) } }] }),
  } as Response;
}

describe("Hybrid Router (AI model + heuristic safety net)", () => {
  beforeEach(() => {
    // Allow the model path to actually run in this file (globally disabled for the rest of the
    // suite via vitest.config.ts). fetch is mocked in every test.
    vi.stubEnv("ROUTER_MODE", "");
    vi.stubEnv("AGENT_LLM", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("falls back to heuristic-only when the local model is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const plan = await routeRequest("check my code for issues");
    expect(plan.routingMode).toBe("heuristic-only");
    expect(plan.selectedAgents).toEqual(["CodePilot"]);
  });

  it("falls back to heuristic-only when the local model returns malformed JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "not json" } }] }) } as Response)
    );
    const plan = await routeRequest("check my code for issues");
    expect(plan.routingMode).toBe("heuristic-only");
  });

  it("falls back to heuristic-only when the local model hallucinates an invalid agent name", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockModelResponse(["NotARealAgent", "AlsoFake"])));
    const plan = await routeRequest("check my code for issues");
    expect(plan.routingMode).toBe("heuristic-only");
    expect(plan.selectedAgents).toEqual(["CodePilot"]);
  });

  it("doesn't call the model when keywords already decided the plan (it could only confirm them)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockModelResponse(["CodePilot", "LearnPilot", "PromptPilot"]));
    vi.stubGlobal("fetch", fetchMock);
    const plan = await routeRequest(
      "Research how to improve my project, check my code for issues, create a study plan for the relevant concept, and summarize the findings."
    );
    expect(plan.routingMode).toBe("heuristic-only");
    expect(new Set(plan.selectedAgents)).toEqual(new Set(["Helper", "CodePilot", "LearnPilot", "PromptPilot"]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("includes an agent the model caught but the keyword heuristic would have missed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockModelResponse(["HardwarePilot"])));
    // Deliberately phrased so no HardwarePilot keyword (arduino/wire/sensor...) appears.
    const plan = await routeRequest("My little robot's motor won't spin when I give it power, what am I doing wrong?");
    expect(plan.selectedAgents).toContain("HardwarePilot");
  });

  it("routes projectile questions phrased without the word 'simulate' to ScienceLab by keyword", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await routeRequest("Model how a ball thrown upward behaves over time")).selectedAgents).toContain("ScienceLab");
    expect((await routeRequest("How far does a ball thrown at 20 m/s at 45 degrees travel?")).selectedAgents).toContain("ScienceLab");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("times out instead of hanging when the model never responds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          })
      )
    );
    vi.stubEnv("ROUTER_TIMEOUT_MS", "50");
    const plan = await routeRequest("check my code for issues");
    expect(plan.routingMode).toBe("heuristic-only");
  }, 10000);

  it("does not let the model add unrelated specialists when the heuristic already matched", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockModelResponse(["ScriptScholar"]));
    vi.stubGlobal("fetch", fetchMock);
    const plan = await routeRequest("check my code for issues");
    expect(plan.selectedAgents).toEqual(["CodePilot"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never adds PromptPilot on the local model's word alone", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockModelResponse(["PromptPilot"])));
    const plan = await routeRequest("What is the capital of France?");
    expect(plan.selectedAgents).toEqual(["Helper"]);
  });

  it("doesn't let the model pick a narrow specialist for a general question", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockModelResponse(["ScienceLab"])));
    const plan = await routeRequest("What are black holes?");
    expect(plan.selectedAgents).toEqual(["Helper"]);
  });
});
