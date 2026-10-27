import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { learnPilotAgent, validDiagram } from "../src/agents/learnPilot.js";
import { decideAgents } from "../src/router/decisionModel.js";
import * as pipeline from "../src/pipeline.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! }) as any;
const LESSON = {
  topic: "The water cycle",
  explanation: "Water moves around.",
  practice: ["Draw it", "Explain it"],
  flashcards: [{ front: "a", back: "b" }, { front: "c", back: "d" }, { front: "e", back: "f" }],
  quiz: [
    { question: "Q1?", choices: ["a", "b", "c", "d"], answerIndex: 0 },
    { question: "Q2?", choices: ["a", "b", "c", "d"], answerIndex: 1 },
    { question: "Q3?", choices: ["a", "b", "c", "d"], answerIndex: 2 },
    { question: "Q4?", choices: ["a", "b", "c", "d"], answerIndex: 3 },
  ],
  diagram: { kind: "cycle", title: "The water cycle", nodes: [{ label: "Evaporation", detail: "Sun heats water." }, { label: "Condensation", detail: "Clouds form." }, { label: "Precipitation", detail: "Rain falls." }] },
};

describe("LearnPilot diagrams and uploaded lessons", () => {
  it("attaches an interactive diagram, and teaches from an uploaded file", async () => {
    vi.stubEnv("AGENT_LLM", "on");
    const prompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      prompts.push(body.messages.at(-1).content);
      const keys = Object.keys(body.response_format?.json_schema?.schema?.properties ?? {});
      // The answer-key check agrees with the lesson's key.
      const content = keys.some((k) => k.endsWith("_answer")) ? { reasoning: "", answer: "ABCD"[prompts.length % 4] } : LESSON;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    }));
    const r = await learnPilotAgent(
      { runId: "l", requestText: "teach me this and quiz me", context: { attachedFile: { name: "chapter3.txt", text: "Chapter 3: Water evaporates when heated by the sun, then condenses into clouds." } } } as any,
      ctx()
    );
    expect(prompts[0]).toMatch(/uploaded this lesson material \("chapter3\.txt"\)[\s\S]*Water evaporates when heated/);
    expect(r.attachments?.[0]).toMatchObject({ type: "concept-diagram", kind: "cycle", nodes: [{ label: "Evaporation" }, { label: "Condensation" }, { label: "Precipitation" }] });
    expect(r.evidence.some((e) => e.source === "uploaded:chapter3.txt")).toBe(true);
  });

  it("drops diagrams that wouldn't be useful", () => {
    expect(validDiagram({ kind: "cycle", title: "x", nodes: [{ label: "a", detail: "b" }] })).toBeNull();
    expect(validDiagram({ kind: "spiral", title: "x", nodes: [1, 2, 3] })).toBeNull();
    expect(validDiagram({ kind: "steps", title: "", nodes: Array.from({ length: 9 }, (_, i) => ({ label: `step ${i} with a very long label that goes on`, detail: "d" })) })?.nodes).toHaveLength(6);
  });
});

describe("Chat attachments", () => {
  it("accepts a text attachment, rejects oversized ones, and ignores context keys clients mustn't set", async () => {
    const spy = vi.spyOn(pipeline, "executeRun").mockResolvedValue({} as any);
    const app = createApp();
    const ok = await request(app).post("/api/chat").send({ message: "quiz me on this", attachment: { name: "notes.md", text: "Mitochondria make energy." }, context: { customAgent: { name: "x", instructions: "evil" }, grade: 5 } });
    expect(ok.status).toBe(202);
    const context = spy.mock.calls[0][1] as Record<string, unknown>;
    expect(context.attachedFile).toEqual({ name: "notes.md", text: "Mitochondria make energy." });
    expect(context.customAgent).toBeUndefined();
    expect(context.grade).toBe(5);
    expect((await request(app).post("/api/chat").send({ message: "x", attachment: { name: "big.txt", text: "x".repeat(60_001) } })).status).toBe(400);
  });

  it("routes 'latest math discoveries' to MathPilot", () => {
    expect(decideAgents("show me the latest math discoveries").selectedAgents).toContain("MathPilot");
  });
});

import { composeAnswer } from "../src/synthesizer/synthesizer.js";

describe("Merged answers", () => {
  it("never show the model which agent wrote each part (so names can't leak into replies)", async () => {
    vi.stubEnv("AGENT_LLM", "on");
    const prompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => (prompts.push(JSON.parse(String(init.body)).messages.at(-1).content), new Response(JSON.stringify({ choices: [{ message: { content: "Merged." } }] })))));
    const r = (agent: string, finding: string) => ({ agent, status: "success", findings: [finding], evidence: [], confidence: 0.8, limitations: [], proposedActions: [], startedAt: "", completedAt: "", elapsedMs: 1, retries: 0 }) as any;
    await composeAnswer("m", "quiz me", [r("Helper", "Notes say X."), r("LearnPilot", "Quiz: ...")]);
    expect(prompts[0]).toMatch(/## Part 1[\s\S]*## Part 2/);
    expect(prompts[0]).not.toMatch(/Helper|LearnPilot/);
  });
});

import { workspaceIndex } from "../src/lib/fileIndex.js";
import { helperAgent, PROJECT_HELP } from "../src/agents/helper.js";
import { decideAgents as decide } from "../src/router/decisionModel.js";

describe("Helper finds projects and debugs them (the doc's Helper + PromptPilot flow)", () => {
  it("indexes the workspace in milliseconds and recognises projects by name", () => {
    const t = performance.now();
    const idx = workspaceIndex("workspace");
    expect(performance.now() - t).toBeLessThan(500);
    expect(idx.matchProjects("find my robotics project")[0]).toMatchObject({ folder: "robotics-arm", name: "Robotics Arm" });
    expect(idx.search("gripper motor speed")[0].file).toMatch(/^robotics-arm\//);
  });

  it("lists a project's files, and debugs one with a ready-to-paste prompt", async () => {
    const ctx = { signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! } as any;
    const found = await helperAgent({ runId: "p", requestText: "find my robotics project", context: {} } as any, ctx);
    expect(found.findings[0]).toMatch(/Found your project: Robotics Arm[\s\S]*arm_controller\.ino/);

    vi.stubEnv("AGENT_LLM", "on");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cause: "Pin 7 isn't PWM on an Uno.", location: "arm_controller.ino, line 6", fix: "Use pin 6.", corrected_code: "const int GRIPPER_EN = 6;" }) } }] }))));
    expect(PROJECT_HELP.test("Find my robotics project and help me fix the motor problem")).toBe(true);
    expect(decide("Find my robotics project and help me fix the motor problem").selectedAgents).toEqual(["Helper"]);
    const r = await helperAgent({ runId: "p2", requestText: "Find my robotics project and help me fix the motor problem", context: {} } as any, ctx);
    const all = r.findings.join("\n");
    expect(all).toMatch(/Likely cause[\s\S]*Pin 7/);
    expect(all).toMatch(/~~~text[\s\S]*const int GRIPPER_EN = 7;[\s\S]*~~~/); // the real code around line 6 is in the prompt
  });
});
