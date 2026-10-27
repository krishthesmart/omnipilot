import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

const app = createApp();

describe("Routines, skills and workspace pages API", () => {
  it("creates, schedules, edits, pauses and deletes a routine", async () => {
    const made = await request(app).post("/api/skills").send({ name: "Start my day", kind: "skill", instructions: "Tell me what's due today", dailyAt: "7:30" });
    expect(made.status).toBe(200);
    expect(made.body.skill).toMatchObject({ name: "start_my_day", dailyAt: "07:30", conversationId: "routine-start_my_day" });

    expect((await request(app).patch("/api/skills/start_my_day").send({ dailyAt: "6pm" })).body.skill.dailyAt).toBe("18:00");
    expect((await request(app).patch("/api/skills/start_my_day").send({ dailyAt: "25:99" })).status).toBe(400);
    expect((await request(app).patch("/api/skills/start_my_day").send({ instructions: "What's due this week?" })).body.skill.instructions).toBe("What's due this week?");
    expect((await request(app).patch("/api/skills/start_my_day").send({ dailyAt: null })).body.skill.dailyAt).toBeNull();

    const list = await request(app).get("/api/skills");
    expect(list.body.skills.map((s: any) => s.name)).toContain("start_my_day");
    expect((await request(app).delete("/api/skills/start_my_day")).status).toBe(200);
    expect((await request(app).delete("/api/skills/start_my_day")).status).toBe(404);
  });

  it("runs a skill now and returns the chat its results go to", async () => {
    await request(app).post("/api/skills").send({ name: "facts", kind: "skill", instructions: "What is 2 + 2?" });
    const r = await request(app).post("/api/skills/facts/run");
    expect(r.status).toBe(200);
    expect(r.body.conversationId).toBe("routine-facts");
    expect(r.body.runId).toBeTruthy();
  });

  it("custom agents can't be scheduled or 'run'", async () => {
    await request(app).post("/api/skills").send({ name: "SpanishTutor", kind: "agent", instructions: "A friendly Spanish tutor" });
    expect((await request(app).patch("/api/skills/spanishtutor").send({ dailyAt: "07:00" })).status).toBe(400);
    expect((await request(app).post("/api/skills/spanishtutor/run")).status).toBe(400);
  });

  it("lists workspace projects and pending changes", async () => {
    const p = await request(app).get("/api/workspace/projects");
    expect(p.body.projects.map((x: any) => x.name)).toContain("Robotics Arm");
    const a = await request(app).get("/api/approvals?status=pending");
    expect(Array.isArray(a.body.approvals)).toBe(true);
  });
});
