import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Finding 4: malformed URL decoding and errors thrown by async route handlers.
vi.mock("../src/pipeline.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/pipeline.js")>();
  return { ...real, executeRun: vi.fn(real.executeRun) };
});

const { createApp } = await import("../src/app.js");
const pipeline = await import("../src/pipeline.js");

afterEach(() => vi.mocked(pipeline.executeRun).mockReset());

describe("Finding 4: malformed URLs and async route errors", () => {
  it("answers malformed percent-encoding with 400, not 500", async () => {
    const app = createApp();
    for (const path of ["/api/runs/%E0%A4%A", "/api/conversations/%ZZ", "/api/connectors/%E0/connect", "/api/runs/abc%/events"]) {
      const res = await request(app).get(path).timeout(5000);
      expect([path, res.status]).toEqual([path, 400]);
      expect(res.body.error).toBe("bad_request");
    }
  });

  it("turns an error thrown in an async route into a 500 response (no hang, no crash)", async () => {
    vi.mocked(pipeline.executeRun).mockRejectedValueOnce(new Error("database is locked"));
    const res = await request(createApp()).post("/api/ask").send({ message: "hello" }).timeout(5000);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error" }); // no internals leaked
    // The server keeps working afterwards.
    expect((await request(createApp()).get("/api/health")).status).toBe(200);
  });
});
