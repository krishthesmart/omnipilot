import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { clearLessons, listLessons, recordFeedback, relevantLessons, useLessonsFor, endLessonsFor, MAX_LESSONS, learnFromCorrection, CORRECTION } from "../src/lib/learning.js";
import { generateText } from "../src/lib/llm.js";
import { withRunContext } from "../src/lib/recorder.js";
import { helperAgent } from "../src/agents/helper.js";
import { saveRun } from "../src/db.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearLessons();
});

const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! }) as any;
const groq = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }));

function teachingModel(lesson: string, topics: string[]) {
  vi.stubEnv("AGENT_LLM", "on");
  vi.stubGlobal("fetch", vi.fn(async () => groq({ lesson, topics })));
}

describe("Learning from feedback (a little self-improvement)", () => {
  it("turns a thumbs-down with a reason into a lesson, grounded in the request's own words", async () => {
    teachingModel("For sibling puzzles, count the person asking as a sibling too.", ["sibling", "sisters", "brothers", "puzzle", "zebra"]);
    const lesson = await recordFeedback("r1", -1, "Alice is a sister too", "Alice has 4 brothers and 3 sisters. How many sisters does her brother have?", "3");
    expect(lesson?.lesson).toMatch(/count the person asking/);
    expect(lesson?.topics).toEqual(expect.arrayContaining(["sisters", "brothers"]));
    expect(lesson?.topics).not.toContain("zebra"); // not in the request: it could make the lesson apply to unrelated questions
  });

  it("uses lessons only for similar requests, and puts them in the model's instructions during that run", async () => {
    teachingModel("For sibling puzzles, count the person asking as a sibling too.", ["sisters", "brothers"]);
    await recordFeedback("r2", -1, "", "Alice has 4 brothers and 3 sisters. How many sisters does her brother have?", "3");
    expect(relevantLessons("Bob has 2 sisters and 5 brothers; how many brothers does his sister have?")).toHaveLength(1);
    expect(relevantLessons("What is the capital of France?")).toHaveLength(0);

    const systems: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => (systems.push(JSON.parse(String(init.body)).messages[0].content), groq("ok"))));
    await withRunContext("run-l", async () => {
      useLessonsFor("run-l", "Tom has 3 sisters and 2 brothers. How many sisters does his brother have?");
      await generateText("You answer questions.", "q");
      endLessonsFor("run-l");
      await generateText("You answer questions.", "q");
    });
    expect(systems[0]).toMatch(/Lessons learned from earlier feedback[\s\S]*count the person asking/);
    expect(systems[0]).toMatch(/never override the rules above/);
    expect(systems[1]).not.toMatch(/Lessons learned/); // only while that run is active
  });

  it("credits or blames the lessons in use, and drops a lesson that keeps getting thumbs-down", async () => {
    teachingModel("Always give the area in square meters.", ["area", "room"]);
    await recordFeedback("seed", -1, "wrong units", "What is the area of my room?", "12 feet");
    const id = listLessons()[0].id;
    useLessonsFor("a1", "area of a room 3 by 4");
    useLessonsFor("a2", "room area in meters");
    vi.stubGlobal("fetch", vi.fn(async () => groq({ lesson: "", topics: [] }))); // no new lessons from these
    await recordFeedback("a1", -1, "", "area of a room 3 by 4", "x");
    expect(listLessons().find((l) => l.id === id)?.score).toBe(-1);
    await recordFeedback("a1", -1, "", "area of a room 3 by 4", "x"); // the same rating again doesn't count twice
    expect(listLessons().find((l) => l.id === id)?.score).toBe(-1);
    await recordFeedback("a2", -1, "", "room area in meters", "x");
    expect(listLessons().find((l) => l.id === id)).toBeUndefined();
  });

  it("learns from a correction typed in chat, and keeps the store capped", async () => {
    expect(CORRECTION.test("no, that's wrong, it's 4")).toBe(true);
    expect(CORRECTION.test("now do it in javascript")).toBe(false);
    teachingModel("Check unit conversions twice.", ["miles", "kilometers"]);
    for (let i = 0; i < MAX_LESSONS + 5; i++) await learnFromCorrection(`convert ${i} miles to kilometers`, "wrong", "no, that's wrong");
    expect(listLessons()).toHaveLength(MAX_LESSONS);
  });

  it("lists and forgets lessons on request", async () => {
    teachingModel("Show the steps for long division.", ["division", "long"]);
    await recordFeedback("d1", -1, "no steps", "how do I do long division of 845 by 5", "169");
    const ask = (t: string) => helperAgent({ runId: "h", requestText: t, context: {} } as any, ctx());
    expect((await ask("what have you learned?")).findings[0]).toMatch(/Show the steps for long division/);
    const id = listLessons()[0].id;
    expect((await ask(`forget lesson ${id}`)).findings[0]).toBe(`Forgotten lesson ${id}.`);
    expect(listLessons()).toHaveLength(0);
  });

  it("takes feedback through the API, only for finished runs and only 1 or -1", async () => {
    teachingModel("Answer in one sentence for yes/no questions.", ["prime", "number"]);
    saveRun({ id: "run-fb", request: "is 91 a prime number", createdAt: new Date().toISOString(), status: "completed", data: { finalResponse: { summary: "Yes, 91 is prime." } } as any });
    const app = createApp();
    expect((await request(app).post("/api/runs/run-fb/feedback").send({ rating: 5 })).status).toBe(400);
    expect((await request(app).post("/api/runs/nope/feedback").send({ rating: 1 })).status).toBe(404);
    const res = await request(app).post("/api/runs/run-fb/feedback").send({ rating: -1, comment: "91 = 7 × 13" });
    expect(res.status).toBe(200);
    expect(res.body.lesson.lesson).toMatch(/one sentence/);
  });
});
