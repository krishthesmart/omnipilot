import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

const app = createApp();

afterEach(() => vi.unstubAllGlobals());

describe("Local-only API", () => {
  it("rejects requests from other websites (they could otherwise make CodePilot run code)", async () => {
    const res = await request(app).post("/api/chat").set("Origin", "https://evil.example").send({ message: "write a python function" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden_origin");
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    const res = await request(app).get("/api/health").set("Host", "evil.example");
    expect(res.status).toBe(403);
  });

  it("allows OmniPilot's own UI on localhost, with CORS headers", async () => {
    const res = await request(app).get("/api/health").set("Origin", "http://localhost:5173");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("lets the browser extension use only the Watcher endpoints it needs", async () => {
    const ext = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    expect((await request(app).get("/api/watcher/policy").set("Origin", ext)).status).toBe(200);
    expect((await request(app).post("/api/watcher/check").set("Origin", ext).send({ url: "https://example.com" })).status).toBe(200);
    expect((await request(app).post("/api/watcher/policy").set("Origin", ext).send({})).status).toBe(403);
    expect((await request(app).post("/api/chat").set("Origin", ext).send({ message: "hi" })).status).toBe(403);
  });

  it("sends security headers", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["content-security-policy"]).toMatch(/default-src 'self'/);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("handles malformed, oversized and unknown requests cleanly", async () => {
    expect((await request(app).post("/api/chat").set("Content-Type", "application/json").send("{not json")).status).toBe(400);
    expect((await request(app).post("/api/chat").send({ message: "x".repeat(300_000) })).status).toBe(413);
    expect((await request(app).get("/api/nope")).status).toBe(404);
  });
});

describe("Status", () => {
  it("reports whether the AI (Groq) is set up and answering", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "openai/gpt-oss-120b" }] }) } as Response));
    const res = await request(createApp()).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.ai).toMatchObject({ configured: true, reachable: true, model: "openai/gpt-oss-120b" });
    expect(JSON.stringify(res.body)).not.toContain("gsk_test"); // the key never leaves the server
  });
});

describe("Behind the Python front door", () => {
  it("serves only requests carrying the internal secret", async () => {
    vi.stubEnv("OMNIPILOT_INTERNAL_TOKEN", "per-launch-secret");
    const app = createApp();
    expect((await request(app).get("/api/status")).status).toBe(403);
    expect((await request(app).get("/api/status").set("x-omnipilot-internal", "guess")).status).toBe(403);
    // The front door also says whether it saw a local client; without that, the request is treated as remote.
    expect((await request(app).get("/api/status").set("x-omnipilot-internal", "per-launch-secret")).status).toBe(401);
    expect((await request(app).get("/api/status").set("x-omnipilot-internal", "per-launch-secret").set("x-omnipilot-client-local", "1")).status).toBe(200);
    vi.unstubAllEnvs();
  });
});
