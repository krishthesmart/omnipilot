import { describe, expect, it, vi, beforeEach } from "vitest";

// Replace the real specialist agents with controllable test doubles so we can
// deterministically exercise timeout, failure, and retry paths without
// depending on real (fast) agent timing.
vi.mock("../src/agents/index.js", () => {
  const AGENTS: Record<string, any> = {
    InfraPilot: async () => ({
      status: "success",
      findings: ["infra ok"],
      evidence: [],
      confidence: 0.9,
      limitations: [],
      proposedActions: [],
    }),
    Helper: async (_input: any, ctx: any) => {
      // Never resolves on its own within the timeout budget -- exercises the timeout path.
      await new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve(undefined));
      });
      return { status: "success", findings: ["too slow"], evidence: [], confidence: 0.5, limitations: [], proposedActions: [] };
    },
    CodePilot: async () => {
      throw new Error("simulated crash");
    },
    PromptPilot: async () => ({
      status: "success",
      findings: ["prompt ok"],
      evidence: [],
      confidence: 0.8,
      limitations: [],
      proposedActions: [],
    }),
    ScienceLab: async () => ({ status: "success", findings: [], evidence: [], confidence: 0.5, limitations: [], proposedActions: [] }),
    ScriptScholar: async () => ({ status: "success", findings: [], evidence: [], confidence: 0.5, limitations: [], proposedActions: [] }),
    LearnPilot: async () => ({ status: "success", findings: [], evidence: [], confidence: 0.5, limitations: [], proposedActions: [] }),
  };
  const AGENT_BUDGETS: Record<string, { timeoutMs: number; maxRetries: number }> = {
    InfraPilot: { timeoutMs: 2000, maxRetries: 1 },
    Helper: { timeoutMs: 150, maxRetries: 1 },
    CodePilot: { timeoutMs: 2000, maxRetries: 0 },
    PromptPilot: { timeoutMs: 2000, maxRetries: 1 },
    ScienceLab: { timeoutMs: 2000, maxRetries: 1 },
    ScriptScholar: { timeoutMs: 2000, maxRetries: 1 },
    LearnPilot: { timeoutMs: 2000, maxRetries: 1 },
  };
  return { AGENTS, AGENT_BUDGETS };
});

const { runAgentsInParallel } = await import("../src/orchestrator.js");

describe("Orchestrator: parallel execution and isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs every selected agent and returns one terminal AgentResult per agent, regardless of other agents' outcomes", async () => {
    const results = await runAgentsInParallel(["InfraPilot", "Helper", "CodePilot", "PromptPilot"], {
      runId: "test-run-1",
      requestText: "anything",
      context: {},
    });

    expect(results).toHaveLength(4);
    const byAgent = Object.fromEntries(results.map((r) => [r.agent, r]));

    expect(byAgent.InfraPilot.status).toBe("success");
    expect(byAgent.PromptPilot.status).toBe("success");
  });

  it("a timed-out agent does not block or delay other agents' results", async () => {
    const start = Date.now();
    const results = await runAgentsInParallel(["Helper", "InfraPilot"], {
      runId: "test-run-2",
      requestText: "anything",
      context: {},
    });
    const elapsed = Date.now() - start;

    const helper = results.find((r) => r.agent === "Helper")!;
    const infra = results.find((r) => r.agent === "InfraPilot")!;

    expect(helper.status).toBe("timeout");
    expect(infra.status).toBe("success");
    // Helper has a 150ms budget with 1 retry (~300ms worst case); InfraPilot
    // resolves near-instantly. The whole call should not take anywhere close
    // to InfraPilot's own 2000ms budget, proving they ran concurrently.
    expect(elapsed).toBeLessThan(1000);
  });

  it("an agent that throws is isolated as 'unreachable' and never rejects the overall Promise.all", async () => {
    const results = await runAgentsInParallel(["CodePilot", "PromptPilot"], {
      runId: "test-run-3",
      requestText: "anything",
      context: {},
    });

    const codePilot = results.find((r) => r.agent === "CodePilot")!;
    const promptPilot = results.find((r) => r.agent === "PromptPilot")!;

    expect(codePilot.status).toBe("unreachable");
    expect(promptPilot.status).toBe("success");
  });

  it("retries a timed-out agent up to its configured maxRetries and reports the retry count", async () => {
    const results = await runAgentsInParallel(["Helper"], { runId: "test-run-4", requestText: "x", context: {} });
    expect(results[0].status).toBe("timeout");
    expect(results[0].retries).toBe(1); // Helper budget allows exactly 1 retry
  });

  it("every result carries the full AgentResult contract (status, findings, evidence, confidence, limitations, proposedActions)", async () => {
    const [result] = await runAgentsInParallel(["InfraPilot"], { runId: "test-run-5", requestText: "x", context: {} });
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("findings");
    expect(result).toHaveProperty("evidence");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("limitations");
    expect(result).toHaveProperty("proposedActions");
    expect(result).toHaveProperty("startedAt");
    expect(result).toHaveProperty("completedAt");
  });
});
