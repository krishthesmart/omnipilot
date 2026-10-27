import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { executeRun } from "../src/pipeline.js";
import { conversationRuns } from "../src/db.js";
// @ts-expect-error -- plain JS module with its own .d.ts beside it
import { OmniPilot } from "../../sdk/js/index.mjs";

// Finding 2: SDK clients must only read runs they are authorized to access.
const TOKEN = "test-token-0123456789abcdef";
const sdk = { Host: "192.168.1.20:8899", Authorization: `Bearer ${TOKEN}` };

afterEach(() => vi.unstubAllEnvs());

/** Status of a server-sent-events response (which stays open), then disconnect. */
async function streamStatus(app: ReturnType<typeof createApp>, path: string, headers: Record<string, string>): Promise<number> {
  const http = await import("node:http");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<number>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
        resolve(res.statusCode ?? 0);
        req.destroy();
      });
      req.on("error", reject);
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

describe("Finding 2: SDK access to history and other clients' runs", () => {
  it("can't list runs or read the local user's runs", async () => {
    vi.stubEnv("OMNIPILOT_API_TOKEN", TOKEN);
    await executeRun("is 6*7 = 42?", {}, "local-private-run", "local-conv-1");
    const app = createApp();
    expect((await request(app).get("/api/runs").set(sdk)).status).toBe(403);
    expect((await request(app).get("/api/runs/local-private-run").set(sdk)).status).toBe(404);
    expect((await request(app).get("/api/runs/local-private-run/events").set(sdk)).status).toBe(404);
    // The person at this computer still sees everything, without keys.
    expect((await request(app).get("/api/runs/local-private-run")).status).toBe(200);
  });

  it("reads its own run only with that run's key, never another run's key", async () => {
    vi.stubEnv("OMNIPILOT_API_TOKEN", TOKEN);
    const app = createApp();
    const a = (await request(app).post("/api/ask").set(sdk).send({ message: "is 2+2 = 4?", textOnly: true })).body;
    const b = (await request(app).post("/api/ask").set(sdk).send({ message: "is 3+3 = 6?", textOnly: true })).body;
    expect(a.runKey).toBeTruthy();
    expect((await request(app).get(`/api/runs/${a.runId}`).set({ ...sdk, "x-run-key": a.runKey })).status).toBe(200);
    expect((await request(app).get(`/api/runs/${a.runId}`).set(sdk)).status).toBe(404);
    expect((await request(app).get(`/api/runs/${b.runId}`).set({ ...sdk, "x-run-key": a.runKey })).status).toBe(404);
    expect((await request(app).get(`/api/runs/${b.runId}/events`).set({ ...sdk, "x-run-key": a.runKey })).status).toBe(404);
    expect(await streamStatus(app, `/api/runs/${b.runId}/events`, { ...sdk, "x-run-key": b.runKey })).toBe(200);
    // Local clients don't get keys (they can read every run anyway).
    expect((await request(app).post("/api/chat").send({ message: "hi" })).body.runKey).toBeUndefined();
  });

  it("can't read or join the local user's conversation", async () => {
    vi.stubEnv("OMNIPILOT_API_TOKEN", TOKEN);
    await executeRun("Is 97 prime?", {}, "local-conv-run", "shared-looking-id");
    const before = conversationRuns("shared-looking-id").length;
    const app = createApp();
    const r = (await request(app).post("/api/ask").set(sdk).send({ message: "and is 91 prime?", conversationId: "shared-looking-id", textOnly: true })).body;
    expect(conversationRuns("shared-looking-id").length).toBe(before); // nothing added to the local chat
    expect(conversationRuns("sdk:shared-looking-id").map((t) => t.runId)).toEqual([r.runId]);
    // The follow-up wasn't resolved against the local user's previous question.
    expect((await request(app).get(`/api/runs/${r.runId}`)).body.standaloneRequest).toBeUndefined();
  });

  it("the JavaScript SDK streams its own runs with a token", async () => {
    vi.stubEnv("OMNIPILOT_API_TOKEN", TOKEN);
    const server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const op = new OmniPilot({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: TOKEN });
      let text = "";
      const r = await op.stream("is 10 - 3 = 7?", { onDelta: (d: string) => (text += d) });
      expect(text).toMatch(/True/);
      expect(r.status).toBe("completed");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
