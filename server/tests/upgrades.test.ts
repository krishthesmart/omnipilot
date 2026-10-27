import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { executeRun } from "../src/pipeline.js";
import { beginRun, cancelRun, endRun } from "../src/lib/runControl.js";
import { runEventBus } from "../src/lib/eventBus.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Chat history", () => {
  it("lists conversations, reopens them, and deletes them", async () => {
    const app = createApp();
    await executeRun("is 2+2 = 4?", {}, "hist-run-1", "conv-hist");
    await executeRun("is 3*3 = 9?", {}, "hist-run-2", "conv-hist");
    const list = (await request(app).get("/api/conversations")).body.conversations;
    const conv = list.find((c: any) => c.id === "conv-hist");
    expect(conv).toMatchObject({ title: "is 2+2 = 4?", turns: 2 });
    const turns = (await request(app).get("/api/conversations/conv-hist")).body.turns;
    expect(turns.map((t: any) => t.runId)).toEqual(["hist-run-1", "hist-run-2"]);
    expect((await request(app).delete("/api/conversations/conv-hist")).body.deleted).toBe(2);
    expect((await request(app).get("/api/conversations/conv-hist")).body.turns).toEqual([]);
  });

  it("replays a saved run after a restart", async () => {
    await executeRun("is 5! = 120?", {}, "replay-run", "conv-replay");
    // Forget the in-memory events, as a restart would.
    (runEventBus as any).history.delete("replay-run");
    const res = await request(createApp()).get("/api/runs/replay-run/events");
    const types = res.text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)).type);
    expect(types[0]).toBe("run_started");
    expect(types).toContain("agent_complete");
    expect(types[types.length - 1]).toBe("final_response");
  });
});

describe("Stop button", () => {
  it("stops a run and reports it as stopped", async () => {
    const events: string[] = [];
    const unsub = runEventBus.subscribe("stop-run", (e) => events.push(e.type));
    const running = executeRun("Explain photosynthesis for a 5th grader", {}, "stop-run", "conv-stop");
    expect(cancelRun("stop-run")).toBe(true);
    const record = await running;
    unsub();
    expect(record.status).toBe("cancelled");
    expect(events[events.length - 1]).toBe("run_cancelled");
    expect(cancelRun("stop-run")).toBe(false); // already finished
  });

  it("answers the cancel endpoint", async () => {
    beginRun("api-stop");
    expect((await request(createApp()).post("/api/runs/api-stop/cancel")).body.cancelled).toBe(true);
    endRun("api-stop");
    expect((await request(createApp()).post("/api/runs/unknown/cancel")).body.cancelled).toBe(false);
  });
});
