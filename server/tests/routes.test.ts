import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { executeRun } from "../src/pipeline.js";
import { searchSlice } from "../src/lib/math/discovery.js";

// Endpoints that had no tests (Phase 0 of the stack migration: the behaviour the
// FastAPI front door must keep).

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Runs", () => {
  it("lists runs and returns one run's record", async () => {
    await executeRun("is 3 + 4 = 7?", {}, "routes-run-1");
    const app = createApp();
    const list = await request(app).get("/api/runs");
    expect(list.status).toBe(200);
    expect(list.body.runs.some((r: any) => r.id === "routes-run-1")).toBe(true);
    const one = await request(app).get("/api/runs/routes-run-1");
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: "routes-run-1", status: "completed" });
    expect(one.body.finalResponse.summary).toMatch(/True/);
  });

  it("rejects malformed chat requests", async () => {
    const app = createApp();
    expect((await request(app).post("/api/chat").send({})).status).toBe(400);
    expect((await request(app).post("/api/chat").send({ message: "x".repeat(4001) })).status).toBe(400);
    expect((await request(app).post("/api/ask").send({ message: "" })).status).toBe(400);
  });
});

describe("MathPilot routes", () => {
  it("pauses and resumes the search", async () => {
    const app = createApp();
    expect((await request(app).post("/api/math/pause").send({ paused: true })).body.paused).toBe(true);
    expect((await request(app).post("/api/math/pause").send({ paused: false })).body.paused).toBe(false);
    expect((await request(app).post("/api/math/pause").send({ paused: "yes" })).status).toBe(400);
  });

  it("lists discoveries, newest first, with an 'after' filter", async () => {
    for (let i = 0; i < 10 && (await request(createApp()).get("/api/math/discoveries")).body.discoveries.length < 2; i++) searchSlice(200);
    const all = (await request(createApp()).get("/api/math/discoveries?limit=5")).body.discoveries;
    expect(all.length).toBeGreaterThan(1);
    expect(all[0].id).toBeGreaterThan(all[1].id);
    const newer = (await request(createApp()).get(`/api/math/discoveries?after=${all[1].id}`)).body.discoveries;
    expect(newer.every((d: any) => d.id > all[1].id)).toBe(true);
  });

  it("explains unreadable identities", async () => {
    const res = await request(createApp()).post("/api/math/check").send({ equation: "no equals here" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_equation");
  });
});

import { saveRun } from "../src/db.js";
import { PREVIEW_CSP } from "../src/lib/security.js";

describe("Web page previews", () => {
  const page = "<!DOCTYPE html><html><body><script>document.body.textContent='hi'</script></body></html>";
  saveRun({ id: "run-preview", request: "make a page", createdAt: new Date().toISOString(), status: "completed", data: { finalResponse: { attachments: [{ type: "picture" }, { type: "html-preview", title: "page", html: page }] } } as any });

  it("serves the page with a sandboxing policy: scripts run, but in an opaque origin with no network", async () => {
    const res = await request(createApp()).get("/api/runs/run-preview/preview/1");
    expect(res.status).toBe(200);
    expect(res.text).toBe(page);
    expect(res.headers["content-security-policy"]).toBe(PREVIEW_CSP);
    expect(PREVIEW_CSP).toMatch(/^sandbox allow-scripts/);
    expect(PREVIEW_CSP).toMatch(/default-src 'none'/);
    expect(PREVIEW_CSP).not.toMatch(/allow-same-origin|connect-src/);
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("only serves stored pages, and the app's own pages keep the strict policy", async () => {
    expect((await request(createApp()).get("/api/runs/run-preview/preview/0")).status).toBe(404); // a picture, not a page
    expect((await request(createApp()).get("/api/runs/run-preview/preview/9")).status).toBe(404);
    expect((await request(createApp()).get("/api/runs/nope/preview/0")).status).toBe(404);
    const other = await request(createApp()).get("/api/runs/run-preview");
    expect(other.headers["content-security-policy"]).toMatch(/script-src 'self'/);
    expect(other.headers["x-frame-options"]).toBe("DENY");
  });
});
