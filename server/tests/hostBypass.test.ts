import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { internalOnly, localOnly } from "../src/lib/security.js";

// Finding 1: the Host header is not proof that a client is local.
const TOKEN = "test-token-0123456789abcdef";

function run(mw: typeof localOnly, opts: { remote: string; headers?: Record<string, string>; path?: string; method?: string; locals?: Record<string, unknown> }) {
  const req = { headers: { host: "localhost:8899", ...(opts.headers ?? {}) }, path: opts.path ?? "/api/status", method: opts.method ?? "GET", socket: { remoteAddress: opts.remote } } as unknown as Request;
  const out: { status?: number; body?: any; next: boolean; locals: Record<string, unknown> } = { next: false, locals: { ...(opts.locals ?? {}) } };
  const res = {
    locals: out.locals,
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: unknown) {
      out.body = body;
      return this;
    },
    setHeader() {},
    sendStatus(code: number) {
      out.status = code;
      return this;
    },
  } as unknown as Response;
  mw(req, res, () => {
    out.next = true;
  });
  return out;
}

afterEach(() => vi.unstubAllEnvs());

describe("Finding 1: Host-header authentication bypass", () => {
  it("rejects another device that claims to be localhost", () => {
    const r = run(localOnly, { remote: "192.168.1.50", headers: { host: "localhost:8899" }, path: "/api/connectors" });
    expect(r.next).toBe(false);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("token_required");
  });

  it("OMNIPILOT_ALLOW_ANY_HOST relaxes only the Host check, never authentication", () => {
    vi.stubEnv("OMNIPILOT_ALLOW_ANY_HOST", "1");
    expect(run(localOnly, { remote: "192.168.1.50", headers: { host: "omnipilot.lan" }, path: "/api/watcher/events", method: "POST" }).status).toBe(401);
    // A local client with a custom host name is what the override is for.
    expect(run(localOnly, { remote: "127.0.0.1", headers: { host: "omnipilot.lan" } }).next).toBe(true);
  });

  it("treats a proxied request as remote even when it arrives over loopback", () => {
    for (const h of ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host"]) {
      expect(run(localOnly, { remote: "127.0.0.1", headers: { [h]: "203.0.113.9" } }).status).toBe(401);
    }
  });

  it("still allows this computer, and still checks the Host header against DNS rebinding", () => {
    expect(run(localOnly, { remote: "127.0.0.1" }).next).toBe(true);
    expect(run(localOnly, { remote: "::ffff:127.0.0.1" }).next).toBe(true);
    expect(run(localOnly, { remote: "::1" }).next).toBe(true);
    expect(run(localOnly, { remote: "127.0.0.1", headers: { host: "evil.example" } }).status).toBe(403);
  });

  it("lets other devices in only with the token, and only for question-answering", () => {
    vi.stubEnv("OMNIPILOT_API_TOKEN", TOKEN);
    const auth = { authorization: `Bearer ${TOKEN}`, host: "192.168.1.20:8899" };
    expect(run(localOnly, { remote: "192.168.1.50", headers: auth, path: "/api/ask", method: "POST" }).next).toBe(true);
    expect(run(localOnly, { remote: "192.168.1.50", headers: auth, path: "/api/connectors" }).status).toBe(403);
  });

  it("behind the front door, uses the front door's verdict, and only with the internal secret", () => {
    vi.stubEnv("OMNIPILOT_INTERNAL_TOKEN", "per-launch-secret");
    const locals: Record<string, unknown> = {};
    expect(run(internalOnly, { remote: "127.0.0.1", headers: { "x-omnipilot-internal": "per-launch-secret" }, locals }).next).toBe(true);
    const viaDoor = { viaFrontDoor: true };
    // The front door connects over loopback, but that says nothing about the real client.
    expect(run(localOnly, { remote: "127.0.0.1", locals: viaDoor }).status).toBe(401);
    expect(run(localOnly, { remote: "127.0.0.1", headers: { "x-omnipilot-client-local": "1" }, locals: viaDoor }).next).toBe(true);
    // Without the internal secret, a client claiming to be local is just a remote client.
    vi.unstubAllEnvs();
    expect(run(localOnly, { remote: "192.168.1.50", headers: { "x-omnipilot-client-local": "1" } }).status).toBe(401);
  });
});
