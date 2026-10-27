import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { verifyGithubToken, verifyNotionToken, verifySlackToken } from "../src/lib/integrations.js";

// Finding 6: connector verification must time out.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A provider that accepts the connection but never answers (until the request is aborted). */
function hangingProvider() {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new DOMException("aborted", "AbortError")));
    }))
  );
}

describe("Finding 6: connector verification timeouts", () => {
  it("gives up on a provider that never answers", async () => {
    vi.stubEnv("OMNIPILOT_PROVIDER_TIMEOUT_MS", "50");
    hangingProvider();
    for (const verify of [verifySlackToken, verifyGithubToken, verifyNotionToken]) {
      const t = performance.now();
      const r = await verify("some-token");
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/provider_timeout/);
      expect(performance.now() - t).toBeLessThan(2000);
    }
  });

  it("answers the connect request instead of hanging", async () => {
    vi.stubEnv("OMNIPILOT_PROVIDER_TIMEOUT_MS", "50");
    hangingProvider();
    const res = await request(createApp()).post("/api/connectors/Slack/connect").send({ token: "xoxb-anything" }).timeout(5000);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "verification_failed" });
    expect(res.body.message).toMatch(/didn't answer in time/);
  });

  it("still verifies a provider that answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, team: "Acme", user: "sam" }), { status: 200 })));
    expect(await verifySlackToken("xoxb-real")).toMatchObject({ ok: true });
  });
});
