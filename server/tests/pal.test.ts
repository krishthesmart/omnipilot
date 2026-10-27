import { afterEach, describe, expect, it, vi } from "vitest";
import { formatNumber, isWordProblem, runSteps } from "../src/lib/math/pal.js";
import { helperAgent } from "../src/agents/helper.js";

const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Program-aided word problems", () => {
  it("runs steps exactly, with names, functions and thousands separators", () => {
    expect(runSteps(["discount = 40 * 0.25", "price = 40 - discount", "answer = price * 3"])?.value).toBe(90);
    expect(runSteps(["s1 = 48/2", "answer = 48 + s1"])?.value).toBe(72);
    expect(runSteps(["total_cost = 1,250 + 50", "answer = round(total_cost / 3, 2)"])?.value).toBe(433.33);
    expect(runSteps(["e = 5", "answer = e * 2"])?.value).toBe(10); // a step name wins over the constant e
    expect(runSteps(["answer = 7 * 6"])?.trace[0]).toMatchObject({ name: "answer", value: 42 });
  });

  it("rejects steps that don't compute", () => {
    expect(runSteps(["x = 1/0"])).toBeNull();
    expect(runSteps(["x = banana + 1"])).toBeNull();
    expect(runSteps([])).toBeNull();
  });

  it("formats answers plainly", () => {
    expect(formatNumber(72)).toBe("72");
    expect(formatNumber(2.5)).toBe("2.5");
    expect(formatNumber(1 / 3)).toBe("0.3333");
    expect(formatNumber(71.99999999999)).toBe("72");
  });

  it("recognises word problems", () => {
    expect(isWordProblem("Natalia sold clips to 48 friends in April, and half as many in May. How many altogether?")).toBe(true);
    expect(isWordProblem("A $40 shirt is 25% off. What do I pay?")).toBe(true);
    expect(isWordProblem("Why is the sky blue?")).toBe(false);
  });

  it("Helper calculates the steps itself and takes the majority answer", async () => {
    vi.stubEnv("AGENT_LLM", "on");
    // Two samples set the problem up correctly, one doesn't; the model's own arithmetic is never used.
    const plans = [
      { reasoning: "", steps: ["may = 48 / 2", "answer = 48 + may"] },
      { reasoning: "", steps: ["answer = 48 + 48 / 2"] },
      { reasoning: "", steps: ["answer = 48 * 2"] },
    ];
    let call = 0;
    const prompts: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      prompts.push(body);
      const keys = Object.keys(body.response_format?.json_schema?.schema?.properties ?? {});
      // The step-by-step answer (checked alongside the equations) agrees.
      const content = keys.some((k) => k.endsWith("_steps")) ? plans[call++ % 3] : { reasoning: "48 + 24", answer: "She sold 72 clips altogether." };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
    }));
    const r = await helperAgent({ runId: "t", requestText: "Natalia sold clips to 48 friends in April, and half as many in May. How many altogether?", context: {} }, ctx());
    expect(r.findings[0]).toBe("The answer is **72**.");
    expect(r.findings[1]).toContain("may = 48 / 2 = 24");
    expect(r.confidence).toBeGreaterThan(0.85);
    // The model writes its reasoning before its answer, whatever order the engine sorts fields in.
    expect(Object.keys(prompts[0].response_format.json_schema.schema.properties)).toEqual(["00_reasoning", "01_answer"]);
  });

  it("when the two methods disagree, a second look decides", async () => {
    vi.stubEnv("AGENT_LLM", "on");
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const keys = Object.keys(JSON.parse(String(init.body)).response_format?.json_schema?.schema?.properties ?? {});
      const content = keys.some((k) => k.endsWith("_steps"))
        ? { reasoning: "", steps: ["answer = 3"] } // a wrong setup: "Alice's 3 sisters"
        : keys.some((k) => k.endsWith("_correct"))
          ? { reasoning: "Alice is a sister too.", correct: "B" }
          : { reasoning: "Alice and her 3 sisters", answer: "Each brother has 4 sisters." };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
    }));
    const r = await helperAgent({ runId: "t2", requestText: "Alice has 4 brothers and 3 sisters. How many sisters does each of her brothers have?", context: {} }, ctx());
    expect(r.findings[0]).toBe("Each brother has 4 sisters.");
    expect(r.confidence).toBeLessThan(0.7);
  });
});

import { answersAgree } from "../src/agents/helper.js";

describe("Helper knows when it's guessing", () => {
  it("compares answers by their key facts", () => {
    expect(answersAgree("The capital of Australia is Canberra.", "Canberra")).toBe(true);
    expect(answersAgree("Shakespeare was born in 1564.", "In 1564")).toBe(true);
    expect(answersAgree("Canberra", "Sydney")).toBe(false);
    expect(answersAgree("It is about 384,400 km away.", "384400 kilometers")).toBe(true);
  });

  it("flags an answer the model can't reproduce", async () => {
    vi.stubEnv("AGENT_LLM", "on");
    const replies = [{ reasoning: "", answer: "The tallest mountain in Peru is Huascaran." }, { answer: "Mount Misti" }, { answer: "Yerupaja" }];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies[call++]) } }] }), { status: 200 })));
    const r = await helperAgent({ runId: "t", requestText: "What is the tallest mountain in Peru?", context: {} }, ctx());
    expect(r.findings[0]).toMatch(/not confident/);
    expect(r.confidence).toBeLessThan(0.3);
  });

  it("stays confident when the answers agree", async () => {
    vi.stubEnv("AGENT_LLM", "on");
    const replies = [{ reasoning: "", answer: "The capital of Australia is Canberra." }, { answer: "Canberra" }, { answer: "Canberra, ACT" }];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies[call++]) } }] }), { status: 200 })));
    const r = await helperAgent({ runId: "t", requestText: "What is the capital of Australia?", context: {} }, ctx());
    expect(r.findings[0]).not.toMatch(/not confident/);
    expect(r.confidence).toBeGreaterThan(0.5);
  });
});

