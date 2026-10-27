import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, majorityVote } from "../src/lib/llm.js";
import { scienceLabAgent } from "../src/agents/scienceLab.js";
import { promptPilotAgent } from "../src/agents/promptPilot.js";
import { wantedQuizSize } from "../src/agents/learnPilot.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! }) as any;

describe("Model calls wait their turn", () => {
  it("runs a limited number at a time, and a waiting call's time limit only starts when it runs", async () => {
    vi.stubEnv("AGENT_LLM", "on");
    vi.stubEnv("OMNIPILOT_AI_PARALLEL", "1");
    vi.stubEnv("GROQ_TIMEOUT_MS", "300");
    let active = 0;
    let most = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 200)); // each call takes 200 ms; three queued take 600 ms in all
      active--;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }));
    const answers = await Promise.all([1, 2, 3].map(() => generateText("s", "u")));
    expect(answers).toEqual(["ok", "ok", "ok"]); // none timed out while waiting
    expect(most).toBe(1);
  });

  it("drops a waiting call when its run is stopped", async () => {
    vi.stubEnv("AGENT_LLM", "on");
    vi.stubEnv("OMNIPILOT_AI_PARALLEL", "1");
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }));
    const stop = new AbortController();
    const first = generateText("s", "u");
    const second = generateText("s", "u", { signal: stop.signal });
    stop.abort();
    expect(await second).toBeNull();
    expect(await first).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Votes stop as soon as they're decided", () => {
  it("needs two questions when the first two agree, three when they don't", async () => {
    const asks = (answers: (string | null)[]) => {
      let i = 0;
      const ask = vi.fn(async () => answers[i++] ?? null);
      return ask;
    };
    const agree = asks(["B", "B", "C"]);
    expect(await majorityVote(agree)).toBe("B");
    expect(agree).toHaveBeenCalledTimes(2);
    const split = asks(["B", "C", "C"]);
    expect(await majorityVote(split)).toBe("C");
    expect(split).toHaveBeenCalledTimes(3);
    expect(await majorityVote(asks(["A", "B", "C"]))).toBeNull();
    expect(await majorityVote(asks([null, null, "A"]))).toBeNull();
  });
});

describe("LearnPilot quiz size", () => {
  it("reads the number of questions asked for", () => {
    expect(wantedQuizSize("give me a 3-question quiz")).toBe(3);
    expect(wantedQuizSize("a five question quiz on fractions")).toBe(5);
    expect(wantedQuizSize("quiz with 2 questions")).toBe(2);
    expect(wantedQuizSize("quiz of 4")).toBe(4);
    expect(wantedQuizSize("teach me photosynthesis")).toBe(3);
    expect(wantedQuizSize("a 40-question quiz")).toBe(6); // capped
  });
});

describe("ScienceLab reads the numbers people actually write", () => {
  const inputs = async (q: string) => {
    const r = await scienceLabAgent({ runId: "s", requestText: q, context: {} } as any, ctx());
    return { inputs: JSON.parse(r.findings.find((f) => f.startsWith("Inputs: "))!.slice(8)), assumed: r.limitations.some((l) => l.startsWith("No explicit")) };
  };
  it("projectiles: m/s, km/h, degrees", async () => {
    expect(await inputs("Simulate projectile motion for a ball thrown at 30 m/s at 60 degrees.")).toMatchObject({ inputs: { initialSpeedMs: 30, launchAngleDeg: 60 }, assumed: false });
    expect((await inputs("projectile launched at 72 km/h with an angle of 30")).inputs).toMatchObject({ initialSpeedMs: 20, launchAngleDeg: 30 });
    expect((await inputs("Simulate projectile motion")).assumed).toBe(true);
  });
  it("population: starting numbers and percent rates", async () => {
    expect((await inputs("Simulate population growth starting with 50 rabbits, growth rate of 20%, carrying capacity of 500")).inputs).toMatchObject({ initialPopulation: 50, growthRate: 0.2, carryingCapacity: 500 });
    expect((await inputs("population growth with initial population 80 and growth rate 0.3")).inputs).toMatchObject({ initialPopulation: 80, growthRate: 0.3 });
  });
  it("soil moisture: percents and rain in mm", async () => {
    expect((await inputs("Simulate soil moisture of 40% with evaporation rate 10% and 5 mm rain")).inputs).toMatchObject({ initialMoisturePct: 40, evaporationRate: 0.1, rainfallMm: 5 });
  });
});

describe("PromptPilot improves the user's prompt, not its own job", () => {
  it("sends the prompt as marked data with a worked example for that kind of tool", async () => {
    vi.stubEnv("AGENT_LLM", "on");
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "<prompt>\nYou are a dog expert. Describe three popular breeds.\n</prompt>" } }] }));
    }));
    const r = await promptPilotAgent({ runId: "p", requestText: "Rewrite this prompt to be clearer: write me something about dogs", context: {} } as any, ctx());
    const msgs = bodies[0].messages;
    expect(msgs[0].content).not.toMatch(/You are PromptPilot/);
    expect(msgs.at(-1).content).toBe("<prompt>\nwrite me something about dogs\n</prompt>");
    expect(msgs[1].content).toMatch(/volcanoes/); // the chat example
    expect(r.findings[0]).toContain("You are a dog expert. Describe three popular breeds.");
    expect(r.findings[0]).not.toContain("<prompt>");
  });
});

import { FILE_INTENT, helperAgent } from "../src/agents/helper.js";
import { codePilotAgent } from "../src/agents/codePilot.js";

describe("Helper searches files only when asked about files", () => {
  it("tells file requests from everyday questions", () => {
    for (const q of ["find the login query", "find my robotics project", "where is my essay", "what's in my notes about motors", "open legacy-login.js", "search the workspace for TODOs"]) expect(FILE_INTENT.test(q), q).toBe(true);
    for (const q of ["make a webpage", "code a calculator with a html webpage", "what is 25 * 25", "find the derivative of x^2", "explain recursion", "who wrote Hamlet"]) expect(FILE_INTENT.test(q), q).toBe(false);
  });

  it("answers the question itself when the matching files turn out to be unrelated", async () => {
    vi.stubEnv("AGENT_LLM", "on");
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const system = String(JSON.parse(String(init.body)).messages[0].content);
      const content = /passages from their files/.test(system) ? JSON.stringify({ relevant: false, answer: "The passages don't cover this." }) : JSON.stringify({ reasoning: "", answer: "Use the `login()` function in your app." });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }));
    const r = await helperAgent({ runId: "h", requestText: "find the login code and explain it", context: {} } as any, ctx());
    expect(r.findings[0]).toBe("Use the `login()` function in your app.");
    expect(r.findings.join(" ")).not.toMatch(/passages don't|matching line/);
  });
});

describe("CodePilot writes code for everyday wording", () => {
  it("builds a complete web page and attaches a preview", async () => {
    vi.stubEnv("AGENT_LLM", "on");
    const page = "<!DOCTYPE html>\n<html><body><input id=a><script>document.title='calc'</script></body></html>";
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "```html\n" + page + "\n```\nA simple calculator." } }] }));
    }));
    const r = await codePilotAgent({ runId: "c", requestText: "code a calculator with a html webpage with addition subtraction division multiplication", context: {} } as any, ctx());
    expect(r.findings[0]).toContain("<!DOCTYPE html>");
    expect(r.attachments).toEqual([{ type: "html-preview", title: expect.stringContaining("calculator"), html: page }]);
    expect(bodies[0].max_completion_tokens).toBeGreaterThan(2000); // room for a whole page
    expect(bodies[0].messages[0].content).toMatch(/ONE complete, self-contained HTML file/);
  });

  it("recognises 'make a webpage' and 'you code it' as requests to write code", async () => {
    vi.stubEnv("AGENT_LLM", "off");
    for (const q of ["make a webpage that shows the time", "code a snake game", "build me a todo app", "can you code a timer"]) {
      const r = await codePilotAgent({ runId: "c2", requestText: q, context: {} } as any, ctx());
      // Small things are written as one file; apps and games as a whole project.
      expect(r.findings[0], q).toMatch(/(Code generation|Building (or changing )?a project) needs the AI model/);
    }
  });
});

import { planSteps } from "../src/coordinator.js";
import { withTests } from "../src/lib/sandbox.js";

describe("Details stay with the instruction they belong to", () => {
  it("keeps comma-separated settings with the simulation instead of handing them to Helper", () => {
    const steps = planSteps("Simulate population growth starting with 50 rabbits, growth rate of 20%, carrying capacity of 500", ["ScienceLab"]);
    expect(steps.map((s) => s.agent)).toEqual(["ScienceLab"]);
    expect(steps[0].task).toMatch(/growth rate of 20%.*carrying capacity of 500/);
  });
  it("still hands a genuinely new instruction to Helper", () => {
    const steps = planSteps("Simulate projectile motion at 20 m/s, and explain who Isaac Newton was", ["ScienceLab"]);
    expect(steps.map((s) => s.agent)).toContain("Helper");
  });
});

describe("Checks still run when code has its own main program", () => {
  it("switches off `if __name__ == '__main__'` and `require.main === module` in the test copy", () => {
    const py = withTests("python", 'def f():\n    return 1\n\nif __name__ == "__main__":\n    import unittest\n    unittest.main()', ["f() == 1"]);
    expect(py).toContain("if False:");
    expect(py).not.toMatch(/if __name__/);
    const js = withTests("javascript", "function f(){return 1}\nif (require.main === module) { main(); }", ["f() === 1"]);
    expect(js).toContain("if (false)");
  });
});
