import { describe, expect, it, vi, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { setConnectorStatus } from "../src/db.js";

const app = createApp();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setConnectorStatus("Slack", "not_connected");
  setConnectorStatus("GitHub", "not_connected");
  setConnectorStatus("Google Drive", "not_connected");
});

describe("Connectors API: every integration is verified for real", () => {
  it("lists connectors with verification mode and never includes a secret token field", async () => {
    const res = await request(app).get("/api/connectors");
    expect(res.status).toBe(200);
    const slack = res.body.connectors.find((c: any) => c.name === "Slack");
    expect(slack.verification).toBe("token");
    expect(slack).not.toHaveProperty("secret_token");
    const drive = res.body.connectors.find((c: any) => c.name === "Google Drive");
    expect(drive.verification).toBe("oauth");
    expect(res.body.connectors.every((c: any) => c.verification !== "simulated")).toBe(true);
  });

  it("requires a token for a token-verified connector", async () => {
    const res = await request(app).post("/api/connectors/Slack/connect").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("token_required");
  });

  it("rejects an invalid token using the provider's own real response, and does not mark it connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: "invalid_auth" }) } as Response)
    );
    const res = await request(app).post("/api/connectors/Slack/connect").send({ token: "xoxb-bad" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("verification_failed");

    const check = await request(app).get("/api/connectors");
    expect(check.body.connectors.find((c: any) => c.name === "Slack").status).toBe("not_connected");
  });

  it("accepts a valid token, stores only the public account label (not the token), and marks it connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, team: "Acme", user: "arul" }) } as Response)
    );
    const res = await request(app).post("/api/connectors/Slack/connect").send({ token: "xoxb-good-token-value" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("connected");
    expect(res.body.account_label).toMatch(/Acme/);
    expect(JSON.stringify(res.body)).not.toContain("xoxb-good-token-value");
  });

  it("never logs the raw token to the audit trail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, team: "Acme", user: "arul" }) } as Response)
    );
    await request(app).post("/api/connectors/Slack/connect").send({ token: "xoxb-super-secret-value" });
    const audit = await request(app).get("/api/audit");
    const entry = audit.body.entries.find((e: any) => e.action === "connector_verify");
    expect(JSON.stringify(entry)).not.toContain("xoxb-super-secret-value");
    expect(entry.parameters.token).toBe("[redacted]");
  });

  it("never pretends to connect: Google Drive needs a real Google sign-in", async () => {
    const res = await request(app).post(`/api/connectors/${encodeURIComponent("Google Drive")}/connect`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("oauth_required");
  });

  it("404s for an unknown connector name", async () => {
    const res = await request(app).post("/api/connectors/NotReal/connect").send({ token: "x" });
    expect(res.status).toBe(404);
  });
});
