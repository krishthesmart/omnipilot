import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { countTests, installCommands, runInSandbox, setE2bSdk, testCommands } from "../src/lib/e2b.js";
import { checkProject } from "../src/lib/projectCheck.js";
import { runBrowserTask } from "../src/lib/web/browserUse.js";
import { linkSkill } from "../src/agents/links.js";
import { driveIdFromLink } from "../src/lib/googleDrive.js";
import { runCommandSkill } from "../src/agents/runCommand.js";
import { BROWSE_INTENT, SERVICE_LINK } from "../src/agents/helper.js";
import { decideAgents } from "../src/router/decisionModel.js";

const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! }) as any;

/** A fake E2B: records files and commands; "pytest"/"unittest" print passing output, `false` fails. */
function fakeE2b() {
  const log: { files: string[]; commands: string[]; killed: boolean } = { files: [], commands: [], killed: false };
  setE2bSdk({
    Sandbox: {
      create: async (opts: any) => {
        expect(opts.apiKey).toBe("e2b_test");
        return {
          files: { write: async (entries: any[]) => log.files.push(...entries.map((e) => e.path)) },
          commands: {
            run: async (cmd: string) => {
              log.commands.push(cmd);
              if (cmd === "false") throw Object.assign(new Error("exit status 1"), { exitCode: 1, stdout: "", stderr: "failed" });
              if (cmd.includes("unittest")) return { exitCode: 0, stdout: "", stderr: "test_a (t.T.test_a) ... ok\ntest_b (t.T.test_b) ... ok\n\nOK" };
              return { exitCode: 0, stdout: `ran: ${cmd}`, stderr: "" };
            },
          },
          kill: async () => {
            log.killed = true;
          },
        };
      },
    },
  });
  return log;
}

describe("E2B cloud sandbox", () => {
  afterEach(() => {
    setE2bSdk(null);
    vi.unstubAllEnvs();
  });

  it("works out install and test commands, and reads test counts", () => {
    const files = [
      { path: "requirements.txt", content: "requests\n" },
      { path: "tests/test_x.py", content: "import unittest" },
      { path: "package.json", content: '{"scripts":{"test":"node --test"},"dependencies":{"left-pad":"1"}}' },
    ];
    expect(installCommands(files)).toEqual(["pip install --quiet -r requirements.txt", "npm install --silent --no-audit --no-fund"]);
    expect(testCommands(files)).toEqual(["npm test", 'python -m unittest discover -s tests -p "*test*.py" -v']);
    expect(countTests("# pass 7\n# fail 1")).toEqual({ passed: 7, failed: 1 });
    expect(countTests("==== 5 passed, 2 failed in 0.3s")).toEqual({ passed: 5, failed: 2 });
  });

  it("runs commands with the project's files, keeps going after a failure, and always shuts down", async () => {
    vi.stubEnv("E2B_API_KEY", "e2b_test");
    const log = fakeE2b();
    const runs = await runInSandbox({ files: [{ path: "main.py", content: "print(1)" }], commands: ["false", "echo hi"] });
    expect(log.files).toEqual(["/home/user/project/main.py"]);
    expect(runs.map((r) => r.exitCode)).toEqual([1, 0]);
    expect(log.killed).toBe(true);
  });

  it("project tests the local guard won't run go to E2B (with package installs)", async () => {
    vi.stubEnv("E2B_API_KEY", "e2b_test");
    const log = fakeE2b();
    const r = await checkProject([
      { path: "requirements.txt", content: "requests\n" },
      { path: "app.py", content: "import requests\n\ndef ok():\n    return True\n" },
      { path: "tests/test_app.py", content: "import unittest\nfrom app import ok\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertTrue(ok())\n" },
    ]);
    expect(r.tests).toMatchObject({ ran: true, passed: 2, failed: 0, via: "e2b" });
    expect(log.commands[0]).toBe("pip install --quiet -r requirements.txt");
  });

  it("without E2B, says how to enable it instead", async () => {
    vi.stubEnv("E2B_API_KEY", "");
    const r = await checkProject([
      { path: "app.py", content: "import requests\n" },
      { path: "test_app.py", content: "import unittest\nimport app\n" },
    ]);
    expect(r.tests.ran).toBe(false);
    expect(r.tests.why).toMatch(/E2B key/);
  });

  it("CodePilot runs a command only in the sandbox, never on this computer", async () => {
    vi.stubEnv("E2B_API_KEY", "");
    const no = await runCommandSkill({ runId: "r", requestText: "run `ls -la` please", context: {} } as any, ctx());
    expect(no!.findings[0]).toMatch(/don't run shell commands on your computer/);
    vi.stubEnv("E2B_API_KEY", "e2b_test");
    const log = fakeE2b();
    const yes = await runCommandSkill({ runId: "r", requestText: "run `python main.py` in my robotics arm project", context: {} } as any, ctx());
    expect(yes!.findings.join("\n")).toContain("ran: python main.py");
    expect(log.files.some((f) => f.endsWith("arm_controller.ino"))).toBe(true);
  });

  it("routes run requests to CodePilot", () => {
    expect(decideAgents("run the tests in my robotics arm project").selectedAgents).toContain("CodePilot");
  });
});

describe("Browser Use (cloud browser for multi-step sites)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("starts a read-only task and waits for its answer", async () => {
    vi.stubEnv("BROWSER_USE_API_KEY", "bu_test");
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    const bodies: any[] = [];
    let polls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
      expect(init.headers["X-Browser-Use-API-Key"]).toBe("bu_test");
      if (String(url).endsWith("/tasks")) {
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: "t1", sessionId: "s1" }), { status: 202 });
      }
      polls++;
      return new Response(JSON.stringify(polls < 2 ? { id: "t1", status: "started" } : { id: "t1", status: "finished", isSuccess: true, output: "Lunch on Monday: pizza." }), { status: 200 });
    });
    const p = runBrowserTask("Go to school.edu and find Monday's lunch");
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    vi.useRealTimers();
    expect(r).toMatchObject({ ok: true, output: "Lunch on Monday: pizza." });
    expect(bodies[0].task).toMatch(/Do NOT sign in/);
  });

  it("recognises jobs that need clicking through a site, but not account links", () => {
    expect(BROWSE_INTENT.test("go to lincolnhigh.org and find this week's lunch menu")).toBe(true);
    expect(BROWSE_INTENT.test("what is photosynthesis")).toBe(false);
    expect(SERVICE_LINK.test("summarize https://docs.google.com/document/d/abc")).toBe(true);
  });
});

describe("account links go through integrations", () => {
  afterEach(() => vi.restoreAllMocks());

  it("finds the Drive file in Docs/Sheets/Slides links", () => {
    expect(driveIdFromLink("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit")).toBe("1AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(driveIdFromLink("https://docs.google.com/spreadsheets/d/1ZyXwVuTsRqPoNmLkJiHgFeDcBa/edit#gid=0")).toBe("1ZyXwVuTsRqPoNmLkJiHgFeDcBa");
    expect(driveIdFromLink("https://drive.google.com/open?id=1QqWwEeRrTtYyUuIiOoPpAaSs")).toBe("1QqWwEeRrTtYyUuIiOoPpAaSs");
  });

  it("a Google Docs link asks to connect Drive when it isn't", async () => {
    const { infraPilotAgent } = await import("../src/agents/infraPilot.js");
    const r = await infraPilotAgent({ runId: "l", requestText: "summarize https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit", context: {} } as any, ctx());
    expect(r.status).toBe("needs_connection");
    expect(r.evidence[0].source).toBe("connector:Google Drive");
    expect(decideAgents("summarize https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit").selectedAgents).toContain("InfraPilot");
  });

  it("reads a public GitHub repo without a token; a private one asks to connect", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.endsWith("/repos/octo/hello")) return new Response(JSON.stringify({ full_name: "octo/hello", description: "Says hi", stargazers_count: 3, language: "Python", pushed_at: "2026-10-01T00:00:00Z", html_url: "https://github.com/octo/hello" }), { status: 200 });
      if (u.endsWith("/repos/octo/hello/readme")) return new Response("# Hello\nRun python hi.py", { status: 200 });
      return new Response("{}", { status: 404 });
    });
    const pub = await linkSkill({ runId: "g", requestText: "what is https://github.com/octo/hello", context: {} } as any, new AbortController().signal);
    expect(pub!.findings[0]).toContain("octo/hello: Says hi");
    expect(pub!.findings[1]).toContain("Run python hi.py");
    const priv = await linkSkill({ runId: "g", requestText: "explain https://github.com/octo/secret", context: {} } as any, new AbortController().signal);
    expect(priv!.status).toBe("needs_connection");
  });

  it("a Notion link asks to connect Notion", async () => {
    const r = await linkSkill({ runId: "n", requestText: "summarize https://www.notion.so/My-Notes-0123456789abcdef0123456789abcdef", context: {} } as any, new AbortController().signal);
    expect(r!.status).toBe("needs_connection");
    expect(r!.findings[0]).toMatch(/Notion/);
  });
});

import { splitClauses } from "../src/agents/promptPilot.js";
describe("commands stay exactly as typed", () => {
  it("never splits code in backticks or quotes", () => {
    expect(splitClauses('run `python3 -c "print(1, 2)"` and explain it')).toEqual(['run `python3 -c "print(1, 2)"`', "explain it"]);
    expect(splitClauses('post "hi, team and all" to #general')).toEqual(['post "hi, team and all" to #general']);
  });
});

import { bbSearch } from "../src/lib/web/browserbase.js";
describe("Browserbase time limits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it("really cancels a search that stalls", async () => {
    vi.stubEnv("BROWSERBASE_API_KEY", "bb_test");
    // A server that never answers until it's cancelled.
    vi.spyOn(globalThis, "fetch").mockImplementation((_u: any, init: any) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    const t = Date.now();
    await expect(bbSearch("x", 5, new AbortController().signal, 300)).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
