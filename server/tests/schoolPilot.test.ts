import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDueDate, scheduleSteps, studyDays, whenText, listTasks, deleteTask } from "../src/lib/school.js";
import { schoolPilotAgent } from "../src/agents/schoolPilot.js";
import { decideAgents } from "../src/router/decisionModel.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const t of listTasks(true)) deleteTask(t.id);
});

const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! }) as any;
const run = (requestText: string) => schoolPilotAgent({ runId: "s", requestText, context: {} } as any, ctx());
// A Wednesday.
const NOW = new Date(2026, 9, 14, 15, 0);

describe("SchoolPilot dates", () => {
  it("reads the due dates students write", () => {
    expect(parseDueDate("due tomorrow", NOW)).toBe("2026-10-15");
    expect(parseDueDate("due Friday", NOW)).toBe("2026-10-16");
    expect(parseDueDate("test on Wednesday", NOW)).toBe("2026-10-21"); // today is Wednesday: next week's
    expect(parseDueDate("in 3 days", NOW)).toBe("2026-10-17");
    expect(parseDueDate("due Oct 30", NOW)).toBe("2026-10-30");
    expect(parseDueDate("due 30th October", NOW)).toBe("2026-10-30");
    expect(parseDueDate("due 11/2", NOW)).toBe("2026-11-02");
    expect(parseDueDate("due Jan 5", NOW)).toBe("2027-01-05"); // already past this year
    expect(parseDueDate("help me with fractions", NOW)).toBeNull();
    expect(whenText("2026-10-15", NOW)).toMatch(/^tomorrow/);
    expect(whenText("2026-10-12", NOW)).toMatch(/^2 days overdue/);
  });

  it("spreads steps before the due date, and study sessions closer together near the test", () => {
    const steps = scheduleSteps(["a", "b", "c"], "2026-10-24", NOW);
    expect(steps.map((s) => s.date)).toEqual(["2026-10-14", "2026-10-19", "2026-10-23"]);
    expect(studyDays("2026-10-24", NOW)).toEqual(["2026-10-17", "2026-10-20", "2026-10-22", "2026-10-23"]);
  });
});

describe("SchoolPilot", () => {
  it("adds a project with a plan, lists it, and marks it done", async () => {
    vi.stubEnv("AGENT_LLM", "on");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ steps: ["Pick a volcano", "Research it", "Build the model", "Practise the talk"] }) } }] }))));
    const added = await run("I have a science project on volcanoes due in 6 days");
    expect(added.findings[0]).toMatch(/Added \*\*Science project on volcanoes\*\*/);
    expect(added.findings[0]).toMatch(/Pick a volcano[\s\S]*Practise the talk/);
    const listed = await run("what's due?");
    expect(listed.findings[0]).toMatch(/Science project on volcanoes.*in 6 days/);
    const done = await run("I finished the volcano project");
    expect(done.findings[0]).toMatch(/Marked done: \*\*Science project on volcanoes\*\*/);
    expect(listTasks()).toHaveLength(0);
  });

  it("plans study sessions for a test, and still plans without the AI", async () => {
    vi.stubEnv("AGENT_LLM", "off");
    const r = await run("I have a math test next Friday");
    expect(r.findings[0]).toMatch(/Study plan/);
    expect(listTasks()[0]).toMatchObject({ kind: "test", subject: "math" });
  });

  it("guides with homework instead of only handing over answers", async () => {
    vi.stubEnv("AGENT_LLM", "on");
    const prompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      prompts.push(JSON.parse(String(init.body)).messages[0].content);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Let's work through it together." } }] }));
    }));
    const r = await run("help me write my essay about the civil war for school");
    expect(r.findings[0]).toBe("Let's work through it together.");
    expect(prompts[0]).toMatch(/guide them to the answer/);
  });

  it("gets school requests from the router", () => {
    for (const q of ["I have a science project due Friday", "what's due this week", "help me with my homework", "my history test is on Monday", "outline for my essay on climate"]) {
      expect(decideAgents(q).selectedAgents, q).toContain("SchoolPilot");
    }
  });
});
