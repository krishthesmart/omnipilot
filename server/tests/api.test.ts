import { describe, expect, it, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

const app = createApp();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("HTTP API", () => {
  it("GET /api/health responds ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /api/chat rejects an empty message", async () => {
    const res = await request(app).post("/api/chat").send({ message: "" });
    expect(res.status).toBe(400);
  });

  it("POST /api/chat returns a runId immediately (does not block on the full pipeline)", async () => {
    const start = Date.now();
    const res = await request(app).post("/api/chat").send({ message: "Check my code for issues" });
    expect(res.status).toBe(202);
    expect(res.body.runId).toBeTruthy();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("GET /api/runs/:id eventually reflects the completed run", async () => {
    const chatRes = await request(app).post("/api/chat").send({ message: "Check my code for issues" });
    const runId = chatRes.body.runId;
    await sleep(300);
    const res = await request(app).get(`/api/runs/${runId}`);
    expect(res.status).toBe(200);
    expect(res.body.plan.selectedAgents).toEqual(["CodePilot"]);
  });

  it("GET /api/runs/:id 404s for an unknown run", async () => {
    const res = await request(app).get("/api/runs/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("approving an action runs it exactly once, with the parameters stored when it was proposed", async () => {
    const { setConnectorVerified, setConnectorStatus } = await import("../src/db.js");
    setConnectorVerified("Slack", "Test workspace", "xoxb-test");
    const calls: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).includes("slack.com/api/chat.postMessage")) {
        calls.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return realFetch(url, init);
    }) as any;
    try {
      const chatRes = await request(app).post("/api/chat").send({ message: "post 'deploy done' to #releases on slack" });
      const runId = chatRes.body.runId;
      let approvals: any[] = [];
      for (let i = 0; i < 30 && !approvals.length; i++) {
        await sleep(100);
        approvals = (await request(app).get(`/api/approvals?runId=${runId}`)).body.approvals;
      }
      expect(approvals.length).toBe(1);
      expect(calls).toHaveLength(0); // nothing sent before approval

      const decide1 = await request(app).post(`/api/approvals/${approvals[0].id}/decision`).send({ decision: "approved" });
      expect(decide1.status).toBe(200);
      expect(decide1.body.status).toBe("approved");
      expect(decide1.body.outcome).toMatchObject({ ok: true });
      expect(calls).toEqual([{ channel: "#releases", text: "deploy done" }]);

      // Deciding again must be rejected -- approvals are decided (and run) exactly once.
      const decide2 = await request(app).post(`/api/approvals/${approvals[0].id}/decision`).send({ decision: "approved" });
      expect(decide2.status).toBe(409);
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
      setConnectorStatus("Slack", "not_connected");
    }
  });

  it("GET /api/connectors lists known integrations, none connected by default", async () => {
    const res = await request(app).get("/api/connectors");
    expect(res.status).toBe(200);
    expect(res.body.connectors.length).toBeGreaterThan(0);
    expect(res.body.connectors.every((c: any) => c.status === "not_connected" || c.status === "connected")).toBe(true);
  });

  it("GET /api/audit returns a chronological log with timestamp/agent/action/outcome for a run", async () => {
    const chatRes = await request(app).post("/api/chat").send({ message: "Check my code for issues" });
    const runId = chatRes.body.runId;
    await sleep(300);
    const res = await request(app).get(`/api/audit?runId=${runId}`);
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    for (const e of res.body.entries) {
      expect(e.timestamp).toBeTruthy();
      expect(e.agent).toBeTruthy();
      expect(e.action).toBeTruthy();
      expect(e.outcome).toBeTruthy();
    }
  });
});

describe("run events without streaming", () => {
  it("lists a run's events after a position, and says when it's done", async () => {
    const app = createApp();
    const { runId } = (await request(app).post("/api/chat").send({ message: "what is 2 + 2?" })).body;
    let body: any = { done: false, events: [], next: 0 };
    const all: any[] = [];
    for (let i = 0; i < 50 && !body.done; i++) {
      body = (await request(app).get(`/api/runs/${runId}/events.json?after=${all.length}`)).body;
      all.push(...body.events);
      if (!body.done) await new Promise((r) => setTimeout(r, 100));
    }
    expect(body.done).toBe(true);
    expect(all[0].type).toBe("run_started");
    expect(all.at(-1).type).toBe("final_response");
    expect((await request(app).get(`/api/runs/${runId}/events.json?after=${all.length}`)).body.events).toEqual([]);
    expect((await request(app).get(`/api/runs/no-such-run/events.json`)).status).toBe(404);
  });
});
