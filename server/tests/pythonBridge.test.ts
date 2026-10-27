import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { pythonOwnsRuns } from "../src/lib/pythonBridge.js";

// The bridge the Python engine uses to run agents that haven't been ported yet (docs/PYTHON_PORT.md).
afterEach(() => vi.unstubAllEnvs());

describe("Python bridge", () => {
  it("runs one agent, only for the front door", async () => {
    const input = { runId: "bridge-run", requestText: "How far does a ball thrown at 20 m/s at 45 degrees travel?", context: {} };
    expect((await request(createApp()).post("/api/internal/agent/ScienceLab").send({ input })).status).toBe(404);
    vi.stubEnv("OMNIPILOT_INTERNAL_TOKEN", "per-launch-secret");
    const app = createApp();
    expect((await request(app).post("/api/internal/agent/ScienceLab").send({ input })).status).toBe(403);
    const door = { "x-omnipilot-internal": "per-launch-secret", "x-omnipilot-client-local": "1" };
    expect((await request(app).post("/api/internal/agent/NotAnAgent").set(door).send({ input })).status).toBe(404);
    expect((await request(app).post("/api/internal/agent/ScienceLab").set(door).send({})).status).toBe(400);
    const ok = await request(app).post("/api/internal/agent/ScienceLab").set(door).send({ input, timeoutMs: 10_000 });
    expect(ok.status).toBe(200);
    // The agent's raw result comes back as-is (timing, retries and events are the Python side's job).
    expect(typeof ok.body.result.status).toBe("string");
    expect(ok.body.result.findings.length).toBeGreaterThan(0);
    expect(ok.body.result.startedAt).toBeUndefined();
  });

  it("hands runs to Python only when the launcher put it in front", () => {
    expect(pythonOwnsRuns()).toBe(false);
    vi.stubEnv("OMNIPILOT_ENGINE_URL", "http://127.0.0.1:8899");
    vi.stubEnv("OMNIPILOT_INTERNAL_TOKEN", "s");
    vi.stubEnv("OMNIPILOT_BEHIND_FRONT_DOOR", "1");
    expect(pythonOwnsRuns()).toBe(true);
    vi.stubEnv("OMNIPILOT_RUNS", "node");
    expect(pythonOwnsRuns()).toBe(false);
  });
});
