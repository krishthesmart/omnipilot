import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omnipilot-watch-"));
process.env.OMNIPILOT_WORKSPACE = ROOT;
fs.mkdirSync(path.join(ROOT, "code"));
const { rescanFile, scanAll, pendingAlerts, markAlertsSeen, setAlertLevel, alertLevel, startCodeWatch, stopCodeWatch } = await import("../src/lib/codeWatch.js");
const { codePilotAgent } = await import("../src/agents/codePilot.js");
const { decideAgents } = await import("../src/router/decisionModel.js");
afterAll(() => {
  stopCodeWatch();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const write = (rel: string, s: string) => fs.writeFileSync(path.join(ROOT, rel), s);
const SQL = 'function q(db, name) {\n  return db.query("SELECT * FROM users WHERE name = \'" + name + "\'");\n}\n';
const SECRET = 'const API_KEY = "sk_live_1234567890abcdef";\n';
const CLEAN = "function add(a, b) {\n  return a + b;\n}\n";

describe("CodePilot's always-on alerts", () => {
  it("records what's there at startup quietly, then alerts on new issues and drops fixed ones", () => {
    write("code/a.js", SQL);
    scanAll(ROOT, true);
    expect(pendingAlerts()).toEqual([]);
    write("code/b.js", SECRET);
    const fresh = rescanFile(ROOT, "code/b.js");
    expect(fresh.map((f) => f.title)).toContain("Hardcoded credential-looking literal");
    expect(pendingAlerts().map((a) => a.file)).toContain("code/b.js");
    write("code/b.js", CLEAN);
    rescanFile(ROOT, "code/b.js");
    expect(pendingAlerts()).toEqual([]); // fixed: gone
  });

  it("only alerts at or above the chosen level, and 'seen' clears them", () => {
    setAlertLevel("critical");
    write("code/c.js", SECRET + SQL);
    rescanFile(ROOT, "code/c.js");
    expect(pendingAlerts().length).toBeGreaterThan(0);
    expect(pendingAlerts().every((a) => a.severity === "critical")).toBe(true); // the SQL injection; the "high" secret is filtered out
    setAlertLevel("off");
    expect(pendingAlerts()).toEqual([]);
    setAlertLevel("low");
    expect(pendingAlerts().length).toBeGreaterThan(0);
    markAlertsSeen();
    expect(pendingAlerts()).toEqual([]);
  });

  it("changes the alert level from chat", async () => {
    const say = (t: string) => codePilotAgent({ runId: "w", requestText: t, context: {} } as any, { signal: new AbortController().signal, workspaceRoot: ROOT } as any);
    expect((await say("alert me only for critical issues")).findings[0]).toMatch(/on for critical issues/);
    expect(alertLevel()).toBe("critical");
    expect((await say("alert me for high issues too")).findings[0]).toMatch(/high and more serious/);
    expect((await say("turn off code alerts")).findings[0]).toMatch(/Code alerts are off/);
    expect((await say("turn code alerts back on")).findings[0]).toMatch(/on for medium/);
    expect(decideAgents("alert me only for critical issues").selectedAgents).toContain("CodePilot");
  });

  it("notices a file being edited, by itself", async () => {
    setAlertLevel("low");
    markAlertsSeen();
    startCodeWatch(ROOT);
    await new Promise((r) => setTimeout(r, 300));
    write("code/d.js", SECRET);
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !pendingAlerts().some((a) => a.file === "code/d.js")) await new Promise((r) => setTimeout(r, 200));
    expect(pendingAlerts().some((a) => a.file === "code/d.js")).toBe(true);
  }, 10000);
});
