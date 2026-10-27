import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { getConnectorInternal, setConnectorStatus } from "../src/db.js";
import { driveQuery } from "../src/agents/drive.js";
import { infraPilotAgent } from "../src/agents/infraPilot.js";
import { executeAction } from "../src/lib/actions.js";

const app = createApp();
const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! }) as any;
const infra = (q: string, context = {}) => infraPilotAgent({ runId: "d", requestText: q, context } as any, ctx());
const CLIENT = "123-abc.apps.googleusercontent.com";

/** A fake Google: token endpoint, Drive about/search/export/upload. */
function fakeGoogle() {
  const calls: { url: string; init: any }[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const body = new URLSearchParams(String(init.body));
      if (body.get("grant_type") === "authorization_code") return json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
      return json({ access_token: "at-2", expires_in: 3600 });
    }
    if (url.includes("/drive/v3/about")) return json({ user: { emailAddress: "student@gmail.com" } });
    if (url.includes("/upload/drive/v3/files")) return json({ id: "new1", webViewLink: "https://docs.google.com/document/d/new1" });
    if (url.includes("/drive/v3/files?")) {
      return json({
        files: [
          { id: "f1", name: "Biology notes", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-10T10:00:00Z", webViewLink: "https://docs.google.com/document/d/f1" },
          { id: "f2", name: "Old essay", mimeType: "application/pdf", modifiedTime: "2026-09-01T10:00:00Z" },
        ],
      });
    }
    if (url.includes("/files/f1/export")) return new Response("Mitochondria make ATP through cellular respiration. Test on Friday.", { status: 200 });
    return realFetch(input, init);
  });
  return calls;
}

describe("Google Drive (real Google sign-in)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setConnectorStatus("Google Drive", "not_connected");
  });

  it("finds the file name in a request", () => {
    expect(driveQuery("summarize my Biology notes doc in Google Drive")).toBe("Biology notes");
    expect(driveQuery('find "History essay" in my drive')).toBe("History essay");
    expect(driveQuery("find my science fair report in google drive")).toBe("science fair report");
  });

  it("signs in with Google (PKCE), stores tokens privately, and rejects forged callbacks", async () => {
    const calls = fakeGoogle();
    const start = await request(app).post(`/api/connectors/${encodeURIComponent("Google Drive")}/oauth/start`).send({ clientId: CLIENT, clientSecret: "secret", origin: "http://localhost:8899" });
    expect(start.status).toBe(200);
    const url = new URL(start.body.url);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8899/api/oauth/google/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("drive.readonly");

    const forged = await request(app).get("/api/oauth/google/callback?code=x&state=not-mine");
    expect(forged.status).toBe(400);
    expect(getConnectorInternal("Google Drive").status).toBe("not_connected");

    const done = await request(app).get(`/api/oauth/google/callback?code=good&state=${url.searchParams.get("state")}`);
    expect(done.status).toBe(200);
    expect(done.text).toContain("student@gmail.com");
    const tokenCall = calls.find((c) => c.url.includes("oauth2.googleapis.com/token"))!;
    expect(new URLSearchParams(tokenCall.init.body).get("code_verifier")).toBeTruthy();
    const pub = (await request(app).get("/api/connectors")).body.connectors.find((c: any) => c.name === "Google Drive");
    expect(pub).toMatchObject({ status: "connected", account_label: "student@gmail.com" });
    expect(JSON.stringify(pub)).not.toContain("rt-1");
    // The same state can't be used twice.
    expect((await request(app).get(`/api/oauth/google/callback?code=good&state=${url.searchParams.get("state")}`)).status).toBe(400);
  });

  it("won't redirect anywhere but this computer", async () => {
    const r = await request(app).post(`/api/connectors/${encodeURIComponent("Google Drive")}/oauth/start`).send({ clientId: CLIENT, clientSecret: "s", origin: "https://evil.example" });
    expect(r.status).toBe(400);
  });

  async function connect() {
    fakeGoogle();
    const start = await request(app).post(`/api/connectors/${encodeURIComponent("Google Drive")}/oauth/start`).send({ clientId: CLIENT, clientSecret: "secret", origin: "http://localhost:8899" });
    await request(app).get(`/api/oauth/google/callback?code=good&state=${new URL(start.body.url).searchParams.get("state")}`);
  }

  it("searches and reads Drive files, and hands the text to LearnPilot", async () => {
    await connect();
    const found = await infra("find my biology notes in google drive");
    expect(found.findings.join("\n")).toContain("[Biology notes](https://docs.google.com/document/d/f1)");
    const read = await infra("summarize my Biology notes doc in Google Drive");
    expect(read.findings.join("\n")).toMatch(/Mitochondria make ATP/);
    expect(read.evidence.find((e) => e.source === "drive-file:Biology notes")?.detail).toContain("Test on Friday");
  });

  it("saves a new Google Doc only after approval", async () => {
    await connect();
    const r = await infra("save that to my google drive as Biology study plan", { previousTurn: { request: "make a study plan for biology", answer: "Day 1: cells. Day 2: respiration." } });
    expect(r.status).toBe("needs_approval");
    expect(r.proposedActions[0].preview).toContain("Day 1: cells");
    const calls = fakeGoogle();
    const out = await executeAction(r.proposedActions[0].id);
    expect(out).toMatchObject({ ok: true, url: "https://docs.google.com/document/d/new1" });
    const upload = calls.find((c) => c.url.includes("/upload/drive/v3/files"))!;
    expect(String(upload.init.body)).toContain('"name":"Biology study plan"');
    expect(String(upload.init.body)).toContain("Day 2: respiration.");
  });

  it("asks to sign in when Drive isn't connected", async () => {
    expect((await infra("what's new in my google drive")).status).toBe("needs_connection");
  });
});
