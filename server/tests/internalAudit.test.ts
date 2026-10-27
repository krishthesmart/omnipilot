import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

// The activity-log endpoint the Python front door uses for E2B remote execution.
afterEach(() => vi.unstubAllEnvs());

describe("Internal activity-log endpoint", () => {
  it("accepts entries only from the front door (internal secret)", async () => {
    const entry = { agent: "RemoteExec", action: "e2b_smoke_test", outcome: "success", parameters: { exitCode: 0 } };
    // Standalone (no front door): not available at all.
    expect((await request(createApp()).post("/api/internal/audit").send(entry)).status).toBe(404);
    vi.stubEnv("OMNIPILOT_INTERNAL_TOKEN", "per-launch-secret");
    const app = createApp();
    expect((await request(app).post("/api/internal/audit").send(entry)).status).toBe(403); // no secret
    const door = { "x-omnipilot-internal": "per-launch-secret", "x-omnipilot-client-local": "1" };
    const ok = await request(app).post("/api/internal/audit").set(door).send(entry);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ runId: "remote-exec", agent: "RemoteExec", outcome: "success" });
    expect((await request(app).post("/api/internal/audit").set(door).send({ agent: "x" })).status).toBe(400);
    const log = await request(app).get("/api/audit?runId=remote-exec").set(door);
    expect(log.body.entries.some((e: any) => e.action === "e2b_smoke_test")).toBe(true);
  });
});
