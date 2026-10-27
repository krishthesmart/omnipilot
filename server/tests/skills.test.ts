import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteSkill, dueRoutines, getSkill, listSkills, matchInvocation, parseTime, saveSkill, setDailyAt } from "../src/lib/skills.js";
import { infraPilotAgent } from "../src/agents/infraPilot.js";
import { eventsBetween, fetchIcs, parseIcs } from "../src/lib/calendar.js";
import { executeRun } from "../src/pipeline.js";
import { decideAgents } from "../src/router/decisionModel.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const s of listSkills()) deleteSkill(s.name);
});

const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! }) as any;
const infra = (requestText: string) => infraPilotAgent({ runId: "i", requestText, context: {} } as any, ctx());

describe("Skills, custom agents and routines", () => {
  it("creates a skill from chat and runs it with a slash command", async () => {
    const r = await infra("create a skill called start_my_day that checks what homework is due and gives me a math trick");
    expect(r.findings[0]).toMatch(/Created the skill \*\*\/start_my_day\*\*/);
    expect(getSkill("start_my_day")?.instructions).toBe("checks what homework is due and gives me a math trick");
    expect(matchInvocation("/start_my_day")?.skill.name).toBe("start_my_day");
    expect(matchInvocation("run start_my_day please")?.extra).toBe("please");
    expect(matchInvocation("/nope")).toBeNull();
    expect(matchInvocation("run start_my_day every day at 7am")).toBeNull(); // scheduling, not running
    // Running it goes through the normal pipeline with the saved request.
    const record = await executeRun("/start_my_day");
    expect(record.standaloneRequest ?? record.request).toBeTruthy();
    expect(record.plan!.selectedAgents).toEqual(expect.arrayContaining(["SchoolPilot", "MathPilot"]));
  });

  it("creates a custom agent that Helper answers as", async () => {
    await infra("create an agent called SpanishTutor that helps me practise Spanish and corrects my mistakes");
    expect(getSkill("spanishtutor")).toMatchObject({ kind: "agent", label: "SpanishTutor" });
    vi.stubEnv("AGENT_LLM", "on");
    const systems: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => (systems.push(JSON.parse(String(init.body)).messages[0].content), new Response(JSON.stringify({ choices: [{ message: { content: "¡Hola! ¿Cómo estás?" } }] })))));
    const record = await executeRun("ask SpanishTutor how do I say good morning");
    expect(record.plan!.selectedAgents).toEqual(["Helper"]);
    expect(record.finalResponse!.summary).toMatch(/Hola/);
    expect(systems.some((s) => /You are SpanishTutor[\s\S]*corrects my mistakes[\s\S]*never override safety/.test(s))).toBe(true);
  });

  it("schedules routines: once a day, and not straight away if the time already passed", async () => {
    // Scheduled at 10am, so 7am has already passed today (whatever time the tests really run).
    const tenAm = new Date();
    tenAm.setHours(10, 0, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"], now: tenAm });
    saveSkill({ name: "evening", label: "evening", kind: "skill", instructions: "what's due tomorrow" });
    const late = new Date();
    late.setHours(23, 59, 0, 0);
    const r = await infra("run evening every day at 7am");
    expect(r.findings[0]).toMatch(/every day at \*\*07:00\*\*/);
    expect(dueRoutines(late)).toHaveLength(0); // 7am already passed today when it was scheduled -> starts tomorrow
    setDailyAt("evening", "06:00");
    const tomorrow7 = new Date(late.getTime() + 24 * 3600_000);
    tomorrow7.setHours(7, 0, 0, 0);
    expect(dueRoutines(tomorrow7).map((s) => s.name)).toEqual(["evening"]);
    expect((await infra("stop the evening routine")).findings[0]).toMatch(/Stopped the daily routine/);
    expect(getSkill("evening")?.dailyAt).toBeNull();
    vi.useRealTimers();
  });

  it("lists and deletes", async () => {
    saveSkill({ name: "a_skill", label: "a skill", kind: "skill", instructions: "do x" });
    expect((await infra("list my skills")).findings[0]).toMatch(/\/a_skill/);
    expect((await infra("delete the skill a_skill")).findings[0]).toMatch(/Deleted/);
    expect(getSkill("a_skill")).toBeNull();
  });

  it("reads times", () => {
    expect(parseTime("at 7am")).toBe("07:00");
    expect(parseTime("7:30 pm")).toBe("19:30");
    expect(parseTime("at 12 am")).toBe("00:00");
    expect(parseTime("noon")).toBe("12:00");
    expect(parseTime("every day")).toBeNull();
  });

  it("routes skill and calendar requests to InfraPilot", () => {
    for (const q of ["create a skill called start_my_day that checks my calendar", "what's on my calendar tomorrow", "create an agent called Coach that motivates me", "list my routines"]) {
      expect(decideAgents(q).selectedAgents, q).toContain("InfraPilot");
    }
  });
});

describe("Calendar (iCal link)", () => {
  const ICS = [
    "BEGIN:VCALENDAR",
    "X-WR-CALNAME:School",
    "BEGIN:VEVENT",
    "SUMMARY:Dentist",
    "DTSTART:20261020T150000Z",
    "DTEND:20261020T160000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "SUMMARY:Field trip",
    "DTSTART;VALUE=DATE:20261021",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "SUMMARY:Soccer practice",
    "DTSTART:20261005T170000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
    "EXDATE:20261021T170000",
    "LOCATION:Main field",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "SUMMARY:A long",
    "  folded title",
    "DTSTART:20261022T090000",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("reads one-off, all-day and repeating events in a window", () => {
    expect(parseIcs(ICS)).toHaveLength(4);
    const events = eventsBetween(ICS, new Date(2026, 9, 19), 4); // Mon Oct 19 .. Thu Oct 22
    expect(events.map((e) => e.title)).toEqual(["Soccer practice", "Dentist", "Field trip", "A long folded title"]);
    expect(events[0].location).toBe("Main field");
    expect(events[2].allDay).toBe(true);
    // Wednesday's practice was cancelled (EXDATE); Monday's is there.
  });

  it("only fetches https links on public hosts", async () => {
    await expect(fetchIcs("http://calendar.google.com/x.ics")).rejects.toThrow(/https/);
    await expect(fetchIcs("https://127.0.0.1/cal.ics")).rejects.toThrow();
    await expect(fetchIcs("https://localhost/cal.ics")).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>not a calendar</html>")));
    await expect(fetchIcs("https://calendar.google.com/calendar/ical/x/basic.ics")).rejects.toThrow(/isn't an iCal/);
  });

  it("asks to connect before reading the calendar", async () => {
    const r = await infra("what's on my calendar today?");
    expect(r.status).toBe("needs_connection");
    expect(r.findings[0]).toMatch(/Secret address in iCal format/);
  });
});

describe("Integration routing and calendar windows (from live testing)", () => {
  it("keeps integration requests with InfraPilot, but notes searches with Helper", () => {
    expect(decideAgents("Create a workflow in Google Drive that backs up my notes every week").selectedAgents).toEqual(["InfraPilot"]);
    expect(decideAgents("search my notes for the github link").selectedAgents).toEqual(["Helper"]);
  });

  it("says when the next event is if the window is empty, and reads 'this month'", async () => {
    const { setConnectorVerified, setConnectorStatus } = await import("../src/db.js");
    const day = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    };
    const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "SUMMARY:Science fair", `DTSTART;VALUE=DATE:${day(12)}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(ics)));
    setConnectorVerified("Google Calendar", "School", "https://calendar.example.com/x.ics");
    try {
      expect((await infra("what's on my calendar this week?")).findings[0]).toMatch(/Nothing on your calendar in the next 7 days\. The next thing is .*Science fair/);
      expect((await infra("what's on my calendar this month?")).findings[0]).toMatch(/Your calendar in the next 30 days[\s\S]*Science fair/);
    } finally {
      setConnectorStatus("Google Calendar", "not_connected");
    }
  });
});
