import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

// Requests through a proxy count as coming from another device (as on a hosting service).
const REMOTE = { "X-Forwarded-For": "203.0.113.9", Host: "omni.example.com" };
const ORIGIN = "https://omni.example.com";

describe("signing in when OmniPilot is hosted", () => {
  beforeEach(() => {
    vi.stubEnv("OMNIPILOT_PASSWORD", "correct horse battery");
    vi.stubEnv("OMNIPILOT_PUBLIC_URL", ORIGIN);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("needs no password on this computer", async () => {
    const app = createApp();
    expect((await request(app).get("/api/skills")).status).toBe(200);
    expect((await request(app).get("/api/auth")).body).toEqual({ required: false, signedIn: true });
  });

  it("from elsewhere: the page loads, but data needs signing in", async () => {
    const app = createApp();
    expect((await request(app).get("/api/auth").set(REMOTE)).body).toEqual({ required: true, signedIn: false });
    const r = await request(app).get("/api/skills").set(REMOTE);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("login_required");
    expect((await request(app).get("/api/health").set(REMOTE)).status).toBe(200);
  });

  it("signs in with the password, and the session opens everything", async () => {
    const app = createApp();
    const wrong = await request(app).post("/api/login").set(REMOTE).set("Origin", ORIGIN).send({ password: "nope" });
    expect(wrong.status).toBe(401);
    const ok = await request(app).post("/api/login").set(REMOTE).set("Origin", ORIGIN).send({ password: "correct horse battery" });
    expect(ok.status).toBe(200);
    const cookie = ok.headers["set-cookie"][0];
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Secure/);
    const session = cookie.split(";")[0];
    expect((await request(app).get("/api/skills").set(REMOTE).set("Cookie", session)).status).toBe(200);
    expect((await request(app).get("/api/auth").set(REMOTE).set("Cookie", session)).body.signedIn).toBe(true);
    // Another website can't use the session to change things.
    const csrf = await request(app).post("/api/skills").set(REMOTE).set("Cookie", session).set("Origin", "https://evil.example").send({ name: "x", instructions: "do it" });
    expect(csrf.status).toBe(403);
    const noOrigin = await request(app).post("/api/skills").set(REMOTE).set("Cookie", session).send({ name: "x", instructions: "do it" });
    expect(noOrigin.status).toBe(403);
    const fromApp = await request(app).post("/api/skills").set(REMOTE).set("Cookie", session).set("Origin", ORIGIN).send({ name: "hosted_skill", instructions: "say hi" });
    expect(fromApp.status).toBe(200);
  });

  it("rejects forged or expired sessions, other hosts, and changing the password signs everyone out", async () => {
    const app = createApp();
    expect((await request(app).get("/api/skills").set(REMOTE).set("Cookie", "omnipilot_session=9999999999999.abc.forged")).status).toBe(401);
    const ok = await request(app).post("/api/login").set(REMOTE).set("Origin", ORIGIN).send({ password: "correct horse battery" });
    const session = ok.headers["set-cookie"][0].split(";")[0];
    expect((await request(app).get("/api/skills").set({ ...REMOTE, Host: "evil.example" }).set("Cookie", session)).status).toBe(403);
    vi.stubEnv("OMNIPILOT_PASSWORD", "a brand new password");
    expect((await request(app).get("/api/skills").set(REMOTE).set("Cookie", session)).status).toBe(401);
  });

  it("slows down password guessing", async () => {
    const app = createApp();
    const guess = () => request(app).post("/api/login").set({ ...REMOTE, "X-Forwarded-For": "198.51.100.7" }).set("Origin", ORIGIN).send({ password: "guess" });
    for (let i = 0; i < 10; i++) expect((await guess()).status).toBe(401);
    expect((await guess()).status).toBe(429);
  });

  it("without a password, other devices still can't get in", async () => {
    vi.stubEnv("OMNIPILOT_PASSWORD", "");
    const app = createApp();
    expect((await request(app).get("/api/skills").set(REMOTE)).status).toBe(401);
    expect((await request(app).post("/api/login").set(REMOTE).send({ password: "x" })).status).not.toBe(200);
  });
});

describe("the scheduler's wake-up call", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("runs due routines only with the cron secret", async () => {
    vi.stubEnv("OMNIPILOT_PASSWORD", "correct horse battery");
    vi.stubEnv("OMNIPILOT_PUBLIC_URL", ORIGIN);
    vi.stubEnv("OMNIPILOT_CRON_SECRET", "cron-secret-0123456789");
    const app = createApp();
    expect((await request(app).post("/api/routines/run-due").set(REMOTE)).status).toBe(401);
    expect((await request(app).post("/api/routines/run-due").set(REMOTE).set("X-OmniPilot-Cron", "wrong-secret-000000")).status).toBe(401);
    const ok = await request(app).post("/api/routines/run-due").set(REMOTE).set("X-OmniPilot-Cron", "cron-secret-0123456789");
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.ran)).toBe(true);
    // The secret opens nothing else.
    expect((await request(app).get("/api/skills").set(REMOTE).set("X-OmniPilot-Cron", "cron-secret-0123456789")).status).toBe(401);
  });

  it("checks the forwarded host behind a proxy", async () => {
    vi.stubEnv("OMNIPILOT_PASSWORD", "correct horse battery");
    vi.stubEnv("OMNIPILOT_PUBLIC_URL", ORIGIN);
    const app = createApp();
    const ok = await request(app).post("/api/login").set({ "X-Forwarded-For": "203.0.113.9", "X-Forwarded-Host": "omni.example.com", Host: "container:8080" }).set("Origin", ORIGIN).send({ password: "correct horse battery" });
    expect(ok.status).toBe(200);
  });
});

describe("Cloudflare Tunnel visitors", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("count as internet visitors even though the tunnel connects from this computer", async () => {
    vi.stubEnv("OMNIPILOT_PASSWORD", "");
    const app = createApp();
    expect((await request(app).get("/api/skills").set("CF-Connecting-IP", "203.0.113.5")).status).toBe(401);
    expect((await request(app).get("/api/skills").set("CF-Ray", "8a1b2c3d4e5f-SJC")).status).toBe(401);
    vi.stubEnv("OMNIPILOT_PASSWORD", "correct horse battery");
    vi.stubEnv("OMNIPILOT_PUBLIC_URL", "https://abc-def.trycloudflare.com");
    const app2 = createApp();
    const r = await request(app2).get("/api/skills").set({ "CF-Connecting-IP": "203.0.113.5", Host: "abc-def.trycloudflare.com" });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("login_required");
  });
});
