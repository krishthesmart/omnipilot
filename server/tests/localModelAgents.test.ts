import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codePilotAgent } from "../src/agents/codePilot.js";
import { learnPilotAgent } from "../src/agents/learnPilot.js";
import { helperAgent } from "../src/agents/helper.js";
import { promptPilotAgent, parseRefineRequest } from "../src/agents/promptPilot.js";
import { refusalReason, runTests } from "../src/lib/sandbox.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = process.env.OMNIPILOT_WORKSPACE!;
const ctx = () => ({ signal: new AbortController().signal, workspaceRoot });

function mockOllama(content: string) {
  vi.stubEnv("AGENT_LLM", "");
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) } as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Agents with the local model available (mocked Ollama)", () => {
  it("Helper answers from the local model when nothing in the workspace matches, and labels it unverified", async () => {
    mockOllama(JSON.stringify({ reasoning: "France's capital city is Paris.", answer: "Paris is the capital of France." }));
    const result = await helperAgent({ runId: "t", requestText: "What is the capital of France?", context: {} }, ctx());
    expect(result.status).toBe("partial_success");
    expect(result.findings[0]).toBe("Paris is the capital of France.");
    expect(result.limitations.join(" ")).toMatch(/verified/);
  });

  it("LearnPilot builds a lesson for a topic outside its content bank at the requested grade", async () => {
    const fetchMock = mockOllama(
      JSON.stringify({
        topic: "Photosynthesis",
        explanation: "Plants use sunlight, water and carbon dioxide to make sugar and release oxygen.",
        practice: ["Name the three inputs."],
        flashcards: [{ front: "Output gas?", back: "Oxygen" }],
        quiz: [{ question: "Where does it happen?", choices: ["Roots", "Leaves", "Bark", "Seeds"], answerIndex: 1 }],
      })
    );
    const result = await learnPilotAgent({ runId: "t", requestText: "Explain photosynthesis for a 5th grader", context: {} }, ctx());
    expect(result.status).toBe("success");
    expect(result.findings[0]).toMatch(/Photosynthesis.*Grade 5/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content).toMatch(/Grade 5/);
  });

  it("LearnPilot still blocks unsafe requests before ever calling the model", async () => {
    const fetchMock = mockOllama("{}");
    const result = await learnPilotAgent({ runId: "t", requestText: "do my homework for me", context: {} }, ctx());
    expect(result.status).toBe("failed_safe");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("CodePilot generates code and statically scans its own output", async () => {
    mockOllama('```js\nconst q = "SELECT * FROM t WHERE id=\'" + id + "\'";\n```\nQueries by id.');
    vi.stubEnv("CODE_VERIFY", "off");
    const result = await codePilotAgent({ runId: "t", requestText: "Write a function to look up a user by id", context: {} }, ctx());
    expect(result.status).toBe("partial_success");
    expect(result.findings[1]).toMatch(/Not executed/);
    expect(result.findings[2]).toMatch(/SQL injection/);
    expect(result.proposedActions).toHaveLength(0);
  });

  it("PromptPilot returns the model's refined prompt", async () => {
    mockOllama("a fluffy orange cat floating in deep space, cinematic lighting --ar 16:9");
    const result = await promptPilotAgent({ runId: "t", requestText: "Refine my prompt for Midjourney: a cat in space", context: {} }, ctx());
    expect(result.findings[0]).toMatch(/Refined prompt for Midjourney:\*\*\n\n```\na fluffy orange cat/);
  });
});

describe("Agents with the local model unavailable (AGENT_LLM=off)", () => {
  it("PromptPilot falls back to a tool-specific template", async () => {
    const result = await promptPilotAgent({ runId: "t", requestText: "Refine my prompt for Midjourney: a cat in space", context: {} }, ctx());
    expect(result.status).toBe("success");
    expect(result.findings[0]).toMatch(/Refined prompt for Midjourney:\*\*\n\n```\na cat in space, .*--ar/);
  });

  it("parses the target tool and original prompt from a refine request", () => {
    expect(parseRefineRequest('Improve this prompt for ChatGPT: "summarize my notes"')).toEqual({
      tool: "ChatGPT",
      family: "chat",
      original: "summarize my notes",
    });
  });

  it("CodePilot says code generation needs the AI model instead of scanning unrelated files", async () => {
    const result = await codePilotAgent({ runId: "t", requestText: "Write a python function to reverse a linked list", context: {} }, ctx());
    expect(result.findings[0]).toMatch(/needs the AI model/);
    expect(result.evidence).toHaveLength(0);
  });
});

/** Mock Ollama with a function of the request body, for multi-step flows. */
function mockOllamaBy(reply: (body: any) => string) {
  vi.stubEnv("AGENT_LLM", "");
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: reply(body) } }] }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Small-model techniques", () => {
  it("sandbox runs passing tests, reports a failing one, and refuses file/process access", async () => {
    const code = "def add(a, b):\n    return a + b";
    const report = await runTests("python", code, ["add(2, 3) == 5", "add(2, 3) == 6", "add(0, 0) == 0"]);
    expect(report).toMatchObject({ ran: true, passed: 2, total: 3 });
    expect(report.failures).toEqual([expect.stringContaining("add(2, 3) == 6")]);
    const broken = await runTests("python", "def add(a, b) return a + b", ["add(1, 1) == 2"]);
    expect(broken.ran).toBe(false);
    expect(refusalReason("python", "import os\nos.remove('x')")).toMatch(/import os/);
    expect(refusalReason("javascript", "require('child_process')")).toMatch(/require/);
  });

  it("CodePilot ignores a repair that replies in prose instead of code", async () => {
    mockOllamaBy((body) => {
      const system: string = body.messages[0].content;
      if (system.startsWith("You write unit tests")) return JSON.stringify({ tests: ["double(2) == 4", "double(0) == 0", "double(3) == 7"] });
      if (system.includes("fixing your own code")) return "The code is correct; the last test is wrong.";
      return "```python\ndef double(n):\n    return n * 2\n```";
    });
    const result = await codePilotAgent({ runId: "t", requestText: "Write a python function that doubles a number", context: {} }, ctx());
    expect(result.findings[0]).toContain("return n * 2");
    expect(result.findings[1]).toMatch(/2 passed, 1 failed/);
  });

  it("treats 'check if a number is even' as a spec, not a request to scan the workspace", async () => {
    vi.stubEnv("CODE_VERIFY", "off");
    mockOllama("```js\nfunction isEven(n) { return n % 2 === 0; }\n```");
    const result = await codePilotAgent({ runId: "t", requestText: "Write a javascript function to check if a number is even", context: {} }, ctx());
    expect(result.findings[0]).toContain("isEven");
    expect(result.proposedActions).toHaveLength(0);
  });

  it("CodePilot repairs its own code when the tests fail", async () => {
    const buggy = "```python\ndef square(n):\n    return n + n\n```";
    const fixed = "```python\ndef square(n):\n    return n * n\n```";
    const fetchMock = mockOllamaBy((body) => {
      const system: string = body.messages[0].content;
      if (system.startsWith("You write unit tests")) return JSON.stringify({ tests: ["square(3) == 9", "square(0) == 0", "square(-2) == 4"] });
      if (system.includes("fixing your own code")) return fixed;
      return buggy;
    });
    const result = await codePilotAgent({ runId: "t", requestText: "Write a python function that squares a number", context: {} }, ctx());
    expect(result.status).toBe("success");
    expect(result.findings[0]).toContain("return n * n");
    expect(result.findings[1]).toMatch(/all passed \(after 1 repair\/resample attempt/);
    expect(fetchMock.mock.calls.some(([, init]) => String(init.body).includes("Failures:") && String(init.body).includes("square(3) == 9"))).toBe(true);
  });

  it("LearnPilot corrects a wrong quiz answer key by majority vote", async () => {
    mockOllamaBy((body) => {
      if (Object.keys(body.response_format?.json_schema?.schema?.properties ?? {}).some((k) => k.replace(/^\d{2}_/, "") === "answer")) return JSON.stringify({ answer: "C" });
      return JSON.stringify({
        topic: "Photosynthesis",
        explanation: "Plants make sugar from light, water and carbon dioxide.",
        practice: ["Name the inputs.", "Name the outputs."],
        flashcards: [
          { front: "Input gas?", back: "Carbon dioxide" },
          { front: "Output gas?", back: "Oxygen" },
          { front: "Energy source?", back: "Sunlight" },
        ],
        quiz: [{ question: "Main product?", choices: ["Oxygen", "Water", "Glucose", "Carbon dioxide"], answerIndex: 3 }],
      });
    });
    const result = await learnPilotAgent({ runId: "t", requestText: "Explain photosynthesis", context: {} }, ctx());
    expect(result.findings.join("\n")).toMatch(/Answers: 1c/);
    expect(result.limitations.join(" ")).toMatch(/1 answer\(s\) corrected/);
  });

  it("Helper answers from the matched passages of the user's files, with citations", async () => {
    const fetchMock = mockOllama(JSON.stringify({ relevant: true, answer: "The login handler builds SQL by concatenation (code/legacy-login.js:9)." }));
    const result = await helperAgent({ runId: "t", requestText: "find the login query", context: {} }, ctx());
    expect(result.findings[0]).toMatch(/legacy-login\.js:9/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content).toMatch(/Passages:/);
  });
});
