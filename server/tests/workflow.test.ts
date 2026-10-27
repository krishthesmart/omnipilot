import { afterEach, describe, expect, it, vi } from "vitest";
import { executeRun } from "../src/pipeline.js";
import { appendTurn, getTurns, looksLikeFollowUp, resolveFollowUp, type Turn } from "../src/lib/conversation.js";
import { reflect } from "../src/coordinator.js";
import { composeAnswer } from "../src/synthesizer/synthesizer.js";
import { AGENT_SPECS } from "../src/agents/registry.js";
import { AGENT_BUDGETS } from "../src/agents/index.js";
import { AGENT_NAMES, type AgentName, type AgentResult } from "../src/types.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const turn = (over: Partial<Turn>): Turn => ({ request: "x", standalone: "x", answer: "", status: "completed", ...over });

function result(agent: AgentName, over: Partial<AgentResult> = {}): AgentResult {
  return {
    agent,
    status: "success",
    findings: ["done"],
    evidence: [],
    confidence: 0.8,
    limitations: [],
    proposedActions: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    elapsedMs: 1,
    retries: 0,
    ...over,
  };
}

describe("Agent registry", () => {
  it("declares every agent, and budgets come from it", () => {
    for (const a of AGENT_NAMES) {
      expect(AGENT_SPECS[a].description.length).toBeGreaterThan(10);
      expect(AGENT_BUDGETS[a]).toEqual(AGENT_SPECS[a].budget);
    }
  });
});

describe("Conversation memory", () => {
  const prev = turn({ request: "Write a python function that returns the nth prime number", standalone: "Write a python function that returns the nth prime number" });

  it("spots follow-ups but leaves standalone requests alone", () => {
    expect(looksLikeFollowUp("now do it in javascript", prev)).toBe(true);
    expect(looksLikeFollowUp("why?", prev)).toBe(true);
    expect(looksLikeFollowUp("What is the capital of France?", prev)).toBe(false);
    expect(looksLikeFollowUp("now do it in javascript", undefined)).toBe(false);
  });

  it("treats any reply to a clarifying question as a follow-up", () => {
    expect(looksLikeFollowUp("the login handler", turn({ status: "needs_clarification", clarifyingQuestion: "Which file?" }))).toBe(true);
  });

  it("rewrites a follow-up to stand alone with the local model", async () => {
    vi.stubEnv("AGENT_LLM", "");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ request: "Write a javascript function that returns the nth prime number" }) } }] }) } as Response)
    );
    expect(await resolveFollowUp("now do it in javascript", [prev])).toBe("Write a javascript function that returns the nth prime number");
  });

  it("falls back to attaching the previous request when the model is off", async () => {
    expect(await resolveFollowUp("now do it in javascript", [prev])).toBe(
      'now do it in javascript (following up on: "Write a python function that returns the nth prime number")'
    );
  });

  it("carries the previous turn into the next run of the same conversation", async () => {
    const first = await executeRun("Check my code for security bugs", {}, undefined, "conv-1");
    expect(getTurns("conv-1")).toHaveLength(1);
    const second = await executeRun("explain that", {}, undefined, "conv-1");
    expect(second.standaloneRequest).toContain("Check my code for security bugs");
    expect(getTurns("conv-1")[1].request).toBe("explain that");
    expect(first.conversationId).toBe("conv-1");
  });

  it("rejects a rewrite that drops the new message and keeps a self-contained message as is", async () => {
    vi.stubEnv("AGENT_LLM", "");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ request: prev.standalone }) } }] }) } as Response)
    );
    const msg = "find the login code and tell me what's wrong with it";
    expect(await resolveFollowUp(msg, [prev])).toBe(msg);
  });

  it("CodePilot passes earlier code along instead of scanning the workspace when there's no code task", async () => {
    const { codePilotAgent } = await import("../src/agents/codePilot.js");
    const r = await codePilotAgent(
      {
        runId: "t",
        requestText: "Explain how the JavaScript function that checks if a number is prime works",
        context: { previousTurn: { request: "x", answer: "```javascript\nfunction isPrime(n) { return n > 1; }\n```" } },
      },
      { signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! }
    );
    expect(r.role).toBe("support");
    expect(r.findings[0]).toContain("function isPrime");
    expect(r.proposedActions).toHaveLength(0);
  });

  it("keeps conversations separate", async () => {
    appendTurn("conv-a", turn({ request: "a" }));
    expect(getTurns("conv-b")).toEqual([]);
  });
});

describe("Coordinator reflection", () => {
  const base = { runId: "r", requestText: "find the login code and tell me what's wrong with it", context: {} };

  it("hands code Helper found to CodePilot when the user asked what's wrong", async () => {
    const done = new Map<AgentName, AgentResult>([["Helper", result("Helper", { evidence: [{ source: "code/legacy-login.js:9", detail: "query" }] })]]);
    const next = await reflect(base, done);
    expect(next).toMatchObject({ agent: "CodePilot", dependsOn: ["Helper"] });
  });

  it("adds a step only when a majority of reflection samples agree", async () => {
    vi.stubEnv("AGENT_LLM", "");
    const answers = [
      { complete: false, next_agent: "LearnPilot", task: "explain recursion" },
      { complete: false, next_agent: "LearnPilot", task: "teach recursion" },
      { complete: true, next_agent: "none", task: "" },
    ];
    let i = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answers[i++ % 3]) } }] }) }) as Response));
    const done = new Map<AgentName, AgentResult>([["CodePilot", result("CodePilot")]]);
    const next = await reflect({ runId: "r", requestText: "write a recursive factorial and help me understand it", context: {} }, done);
    expect(next?.agent).toBe("LearnPilot");
    expect(next?.dependsOn).toEqual(["CodePilot"]);
  });

  it("never adds a narrow specialist the request isn't about", async () => {
    vi.stubEnv("AGENT_LLM", "");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ complete: false, next_agent: "ScriptScholar", task: "x" }) } }] }) } as Response)
    );
    const done = new Map<AgentName, AgentResult>([["Helper", result("Helper")]]);
    expect(await reflect({ runId: "r", requestText: "how many weeks are in a year?", context: {} }, done)).toBeNull();
  });

  it("does nothing after a safety block", async () => {
    const done = new Map<AgentName, AgentResult>([["LearnPilot", result("LearnPilot", { status: "failed_safe", findings: ["blocked"] })]]);
    expect(await reflect(base, done)).toBeNull();
  });
});

describe("Streaming answer", () => {
  it("streams the composed answer token by token", async () => {
    vi.stubEnv("AGENT_LLM", "");
    const chunks = ['data: {"choices":[{"delta":{"content":"Paris "}}]}\n\n', 'data: {"choices":[{"delta":{"content":"is the capital."}}]}\n\ndata: [DONE]\n\n'];
    const body = new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body } as unknown as Response));
    const tokens: string[] = [];
    const text = await composeAnswer("r", "q", [result("Helper"), result("LearnPilot")], (t) => tokens.push(t));
    expect(tokens).toEqual(["Paris ", "is the capital."]);
    expect(text).toBe("Paris is the capital.");
  });
});
