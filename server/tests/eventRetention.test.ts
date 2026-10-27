import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { executeRun } from "../src/pipeline.js";
import { runEventBus } from "../src/lib/eventBus.js";
import type { RunEvent } from "../src/types.js";

// Finding 7: in-memory event history must be bounded without breaking replay.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const started = (runId: string): RunEvent => ({ type: "run_started", runId, request: "x" });
const done = (runId: string): RunEvent => ({ type: "run_failed", runId, error: "test" });
const step = (runId: string): RunEvent => ({ type: "synthesizer_start", runId });

afterEach(() => runEventBus.configure({ retainMs: 10 * 60_000, maxFinished: 200 }));

describe("Finding 7: event-history retention", () => {
  it("drops a finished run's events after the retention period", async () => {
    runEventBus.configure({ retainMs: 20 });
    runEventBus.publish(started("ret-1"));
    runEventBus.publish(done("ret-1"));
    expect(runEventBus.getHistory("ret-1")).toHaveLength(2); // late subscribers still get it
    await wait(60);
    expect(runEventBus.getHistory("ret-1")).toEqual([]);
  });

  it("never drops a run that's still going", async () => {
    runEventBus.configure({ retainMs: 10, maxFinished: 1 });
    runEventBus.publish(started("ret-running"));
    runEventBus.publish(step("ret-running"));
    for (const id of ["ret-a", "ret-b", "ret-c"]) {
      runEventBus.publish(started(id));
      runEventBus.publish(done(id));
    }
    await wait(40);
    expect(runEventBus.getHistory("ret-running")).toHaveLength(2);
  });

  it("caps the number of finished runs kept", () => {
    runEventBus.configure({ maxFinished: 2 });
    for (const id of ["cap-1", "cap-2", "cap-3"]) {
      runEventBus.publish(started(id));
      runEventBus.publish(done(id));
    }
    expect(runEventBus.getHistory("cap-1")).toEqual([]); // oldest finished run dropped
    expect(runEventBus.getHistory("cap-3")).toHaveLength(2);
  });

  it("never deletes the history of a run that reuses the ID", async () => {
    runEventBus.configure({ retainMs: 30 });
    runEventBus.publish(started("reused"));
    runEventBus.publish(done("reused")); // eviction scheduled for the first run
    runEventBus.publish(started("reused")); // the ID is reused before that fires
    runEventBus.publish(step("reused"));
    await wait(70);
    expect(runEventBus.getHistory("reused").map((e) => e.type)).toEqual(["run_started", "synthesizer_start"]);
    // ...and once the reused run finishes, its own retention applies.
    runEventBus.publish(done("reused"));
    await wait(70);
    expect(runEventBus.getHistory("reused")).toEqual([]);
  });

  it("still replays a run after its events are dropped", async () => {
    runEventBus.configure({ retainMs: 10 });
    await executeRun("is 8 * 8 = 64?", {}, "ret-replay", "ret-conv");
    await wait(40);
    expect(runEventBus.getHistory("ret-replay")).toEqual([]);
    const res = await request(createApp()).get("/api/runs/ret-replay/events");
    const types = res.text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)).type);
    expect(types[0]).toBe("run_started");
    expect(types[types.length - 1]).toBe("final_response");
  });
});
