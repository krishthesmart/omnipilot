import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// A throwaway workspace for this file (set before the app is imported).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omnipilot-ws-"));
process.env.OMNIPILOT_WORKSPACE = ROOT;
fs.mkdirSync(path.join(ROOT, "code"));
const VULN = [
  "const express = require('express');",
  "function login(req, db) {",
  "  const user = req.query.user;",
  '  return db.query("SELECT * FROM users WHERE name = \'" + user + "\'");',
  "}",
  "module.exports = login;",
  "",
].join("\n");
const SAFE = VULN.replace(`'  return db.query("SELECT * FROM users WHERE name = \\'" + user + "\\'");'`, "").replace(
  '  return db.query("SELECT * FROM users WHERE name = \'" + user + "\'");',
  '  return db.query("SELECT * FROM users WHERE name = ?", [user]);'
);

const { applyPatch, getPatch, savePatch, undoPatch, unifiedDiff, safeWorkspacePath } = await import("../src/lib/patches.js");
const { codePilotAgent } = await import("../src/agents/codePilot.js");
const { createApp } = await import("../src/app.js");
const { createApproval } = await import("../src/db.js");
const request = (await import("supertest")).default;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const file = (rel: string, content?: string) => {
  const p = path.join(ROOT, rel);
  if (content !== undefined) fs.writeFileSync(p, content);
  return fs.readFileSync(p, "utf8");
};

describe("Fix patches", () => {
  it("shows a readable unified diff", () => {
    const d = unifiedDiff("code/login.js", VULN, SAFE);
    expect(d).toMatch(/^--- a\/code\/login\.js\n\+\+\+ b\/code\/login\.js\n@@ /);
    expect(d).toMatch(/\n- {2}return db\.query\("SELECT \* FROM users WHERE name = '" \+ user/);
    expect(d).toMatch(/\n\+ {2}return db\.query\("SELECT \* FROM users WHERE name = \?", \[user\]\);/);
    expect(d).toMatch(/\n {3}const user = req\.query\.user;/); // context line
  });

  it("applies only to the unchanged file, keeps the original for undo, and won't undo over later edits", () => {
    file("code/login.js", VULN);
    savePatch({ id: "p1", file: "code/login.js", original: VULN, fixed: SAFE, summary: "parameterized query" });
    expect(applyPatch("p1", ROOT)).toEqual({ ok: true, file: "code/login.js", files: ["code/login.js"] });
    expect(file("code/login.js")).toBe(SAFE);
    expect(applyPatch("p1", ROOT)).toMatchObject({ ok: false, error: "not_pending" });
    expect(undoPatch("p1", ROOT)).toMatchObject({ ok: true });
    expect(file("code/login.js")).toBe(VULN);

    savePatch({ id: "p2", file: "code/login.js", original: VULN, fixed: SAFE, summary: "x" });
    file("code/login.js", VULN + "// edited by hand\n");
    expect(applyPatch("p2", ROOT)).toMatchObject({ ok: false, error: "changed" });
    file("code/login.js", VULN);
    applyPatch("p2", ROOT);
    file("code/login.js", SAFE + "// more edits\n");
    expect(undoPatch("p2", ROOT)).toMatchObject({ ok: false, error: "changed" });
  });

  it("never touches files outside the workspace, including through a symlink", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omnipilot-out-"));
    fs.writeFileSync(path.join(outside, "secret.js"), "x");
    fs.symlinkSync(path.join(outside, "secret.js"), path.join(ROOT, "code", "link.js"));
    expect(safeWorkspacePath(ROOT, "../../etc/passwd")).toBeNull();
    expect(safeWorkspacePath(ROOT, "code/link.js")).toBeNull();
    savePatch({ id: "p3", file: "code/link.js", original: "x", fixed: "y", summary: "x" });
    expect(applyPatch("p3", ROOT)).toMatchObject({ ok: false, error: "outside_workspace" });
    expect(fs.readFileSync(path.join(outside, "secret.js"), "utf8")).toBe("x");
    fs.rmSync(path.join(ROOT, "code", "link.js"));
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe("CodePilot fixes", () => {
  const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: ROOT }) as any;
  const model = (code: string) => {
    vi.stubEnv("AGENT_LLM", "on");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "Use a parameterized query.", code }) } }] }))));
  };

  it("proposes a verified fix with a diff, and applies it when approved", async () => {
    file("code/login.js", VULN);
    model(SAFE);
    const r = await codePilotAgent({ runId: "cp", requestText: "scan my code for security bugs", context: {} } as any, ctx());
    const action = r.proposedActions.find((a: any) => a.preview);
    expect(action?.description).toMatch(/Apply CodePilot's fix to code\/login\.js/);
    expect(action?.preview).toMatch(/\[user\]/);
    expect(getPatch(action!.id)?.status).toBe("pending");
    expect(file("code/login.js")).toBe(VULN); // nothing changes before approval

    createApproval({ id: action!.id, runId: "cp", agent: "CodePilot", description: action!.description, riskLevel: action!.riskLevel, createdAt: new Date().toISOString() });
    const res = await request(createApp()).post(`/api/approvals/${action!.id}/decision`).send({ decision: "approved" });
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual({ file: "code/login.js", files: ["code/login.js"] });
    expect(file("code/login.js")).toBe(SAFE);
    const undo = await request(createApp()).post(`/api/approvals/${action!.id}/undo`);
    expect(undo.status).toBe(200);
    expect(file("code/login.js")).toBe(VULN);
  });

  it("rejects a 'fix' that adds a new kind of problem", async () => {
    file("code/login.js", VULN);
    model(SAFE.replace("function login", 'const API_KEY = "sk_live_1234567890abcdef";\nfunction login'));
    const r = await codePilotAgent({ runId: "cp2", requestText: "scan my code for security bugs", context: {} } as any, ctx());
    expect(r.proposedActions.some((a: any) => a.preview)).toBe(false);
    expect(r.proposedActions.length).toBeGreaterThan(0); // the issue is still listed to fix by hand
  });

  it("discards the fix when denied", async () => {
    file("code/login.js", VULN);
    model(SAFE);
    const r = await codePilotAgent({ runId: "cp3", requestText: "scan my code for security bugs", context: {} } as any, ctx());
    const action = r.proposedActions.find((a: any) => a.preview)!;
    createApproval({ id: action.id, runId: "cp3", agent: "CodePilot", description: action.description, riskLevel: action.riskLevel, createdAt: new Date().toISOString() });
    await request(createApp()).post(`/api/approvals/${action.id}/decision`).send({ decision: "denied" });
    expect(getPatch(action.id)?.status).toBe("rejected");
    expect(file("code/login.js")).toBe(VULN);
  });
});
