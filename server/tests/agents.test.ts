import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codePilotAgent } from "../src/agents/codePilot.js";
import { learnPilotAgent, checkLearnPilotSafety } from "../src/agents/learnPilot.js";
import { scriptScholarAgent } from "../src/agents/scriptScholar.js";
import { scienceLabAgent } from "../src/agents/scienceLab.js";
import { infraPilotAgent } from "../src/agents/infraPilot.js";
import { helperAgent } from "../src/agents/helper.js";
import { promptPilotAgent } from "../src/agents/promptPilot.js";
import { setConnectorStatus } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = process.env.OMNIPILOT_WORKSPACE!;

function ctx() {
  return { signal: new AbortController().signal, workspaceRoot };
}

describe("CodePilot: real static analysis, not fabricated findings", () => {
  it("flags SQL injection, command injection, XSS, and a hardcoded secret in a submitted snippet", async () => {
    const snippet = `
      const q = "SELECT * FROM users WHERE id='" + id + "'";
      exec("diagnostics " + cmd);
      res.send('<div>' + bio + '</div>');
      const apiKey = "sk-live-ABCDEFGH12345678";
    `;
    const result = await codePilotAgent({ runId: "t", requestText: "check my code", context: { code: snippet } }, ctx());
    expect(result.status).toBe("success");
    const ruleIds = result.evidence.map((e) => e.detail.match(/\[(.+?)\]/)?.[1]);
    expect(ruleIds).toEqual(expect.arrayContaining(["sql-injection", "command-injection", "xss-unescaped-response", "hardcoded-secret"]));
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("reports no issues (not fabricated ones) for clean code", async () => {
    const result = await codePilotAgent({ runId: "t", requestText: "check my code", context: { code: "function add(a, b) { return a + b; }" } }, ctx());
    expect(result.status).toBe("success");
    expect(result.evidence).toHaveLength(0);
    expect(result.findings[0]).toMatch(/no issues/i);
  });

  it("offers Learn Mode only when explicitly requested", async () => {
    const snippet = "eval(userInput);";
    const withoutLearnMode = await codePilotAgent({ runId: "t", requestText: "scan this", context: { code: snippet } }, ctx());
    expect(withoutLearnMode.findings.join(" ")).not.toMatch(/learn mode/i);

    const withLearnMode = await codePilotAgent({ runId: "t", requestText: "scan this in learn mode", context: { code: snippet } }, ctx());
    expect(withLearnMode.findings.join(" ")).toMatch(/learn mode/i);
  });
});

describe("LearnPilot: safety gate and grade-aware study plans", () => {
  it("blocks requests that ask it to complete graded work for the student", () => {
    expect(checkLearnPilotSafety("do my homework for me and submit it").blocked).toBe(true);
    expect(checkLearnPilotSafety("take this test for me").blocked).toBe(true);
  });

  it("blocks unsafe content requests", () => {
    expect(checkLearnPilotSafety("how to make a bomb").blocked).toBe(true);
  });

  it("does not block ordinary educational requests", () => {
    expect(checkLearnPilotSafety("explain photosynthesis to me").blocked).toBe(false);
  });

  it("returns failed_safe status (not a normal answer) for a blocked request", async () => {
    const result = await learnPilotAgent({ runId: "t", requestText: "do my homework for me and submit it", context: {} }, ctx());
    expect(result.status).toBe("failed_safe");
  });

  it("infers grade level when stated and discloses when it had to assume", async () => {
    const withGrade = await learnPilotAgent({ runId: "t", requestText: "explain code security, grade 9", context: {} }, ctx());
    expect(withGrade.findings.join(" ")).toMatch(/Grade 9/);

    const withoutGrade = await learnPilotAgent({ runId: "t", requestText: "explain code security", context: {} }, ctx());
    expect(withoutGrade.limitations.join(" ")).toMatch(/no grade/i);
  });
});

describe("ScriptScholar: curated reference comparisons with disclosed uncertainty", () => {
  it("compares two named scripts and documents the lineage relationship", async () => {
    const result = await scriptScholarAgent({ runId: "t", requestText: "Compare Phoenician and the Greek alphabet", context: {} }, ctx());
    expect(result.status).toBe("success");
    expect(result.findings.join(" ")).toMatch(/Phoenician vs Greek Alphabet/);
  });

  it("flags undeciphered scripts with high uncertainty rather than asserting false confidence", async () => {
    const result = await scriptScholarAgent({ runId: "t", requestText: "Tell me about Linear A", context: {} }, ctx());
    expect(result.confidence).toBeLessThan(0.6);
    expect(result.findings.join(" ")).toMatch(/undeciphered/i);
  });

  it("says 'Not implemented' for scripts outside the supported reference set", async () => {
    const result = await scriptScholarAgent({ runId: "t", requestText: "Tell me about Rongorongo", context: {} }, ctx());
    expect(result.findings.join(" ")).toMatch(/Not implemented/);
  });
});

describe("ScienceLab: real deterministic simulations", () => {
  it("computes projectile motion from given inputs", async () => {
    const result = await scienceLabAgent({ runId: "t", requestText: "simulate a projectile with speed of 20 and angle of 45", context: {} }, ctx());
    expect(result.status).toBe("success");
    const outputsLine = result.findings.find((f) => f.startsWith("Outputs:"))!;
    const outputs = JSON.parse(outputsLine.replace("Outputs: ", ""));
    // Known analytic range for v=20, angle=45, g=9.81 is v^2/g ≈ 40.78m
    expect(outputs.rangeMeters).toBeCloseTo(40.78, 1);
  });

  it("says 'Not implemented' for unsupported simulation types", async () => {
    const result = await scienceLabAgent({ runId: "t", requestText: "simulate the stock market", context: {} }, ctx());
    expect(result.status).toBe("failed_safe");
    expect(result.findings.join(" ")).toMatch(/Not implemented/);
  });
});

describe("InfraPilot: honest connector status, least privilege", () => {
  it("reports 'needs_connection' (not fake success) for an unconnected integration", async () => {
    setConnectorStatus("Slack", "not_connected");
    const result = await infraPilotAgent({ runId: "t", requestText: "connect Slack and post a daily summary", context: {} }, ctx());
    expect(result.status).toBe("needs_connection");
    expect(result.findings.join(" ")).toMatch(/not connected/i);
  });

  it("requires approval before a write action, even when connected, and shows exactly what will be sent", async () => {
    setConnectorStatus("Slack", "connected");
    const result = await infraPilotAgent({ runId: "t", requestText: "post 'standup moved to 10am' to #general on Slack", context: {} }, ctx());
    expect(result.status).toBe("needs_approval");
    expect(result.proposedActions).toHaveLength(1);
    expect(result.proposedActions[0].requiresApproval).toBe(true);
    expect(result.proposedActions[0].preview).toContain("#general");
    expect(result.proposedActions[0].preview).toContain("standup moved to 10am");
    setConnectorStatus("Slack", "not_connected");
  });

  it("asks for what's missing instead of guessing", async () => {
    setConnectorStatus("Slack", "connected");
    const result = await infraPilotAgent({ runId: "t", requestText: "post something to Slack", context: {} }, ctx());
    expect(result.proposedActions).toHaveLength(0);
    expect(result.findings.join(" ")).toMatch(/Which Slack channel/);
    setConnectorStatus("Slack", "not_connected");
  });

  it("never executes directly -- a GitHub issue is only proposed (no network call)", async () => {
    setConnectorStatus("GitHub", "connected");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await infraPilotAgent({ runId: "t", requestText: "open a github issue in acme/site titled 'Login button broken' saying nothing happens on click", context: {} }, ctx());
    expect(result.status).toBe("needs_approval");
    expect(result.proposedActions[0].preview).toContain("acme/site");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    setConnectorStatus("GitHub", "not_connected");
  });
});

describe("Helper: searches the approved workspace only, with real evidence", () => {
  it("returns file:line evidence for real matches", async () => {
    const result = await helperAgent({ runId: "t", requestText: "find notes about improving the project", context: {} }, ctx());
    expect(result.status).toBe("success");
    expect(result.evidence.length).toBeGreaterThan(0);
    for (const e of result.evidence) {
      expect(e.source).toMatch(/:\d+$/); // file:line
    }
  });

  it("discloses the workspace-only limitation", async () => {
    const result = await helperAgent({ runId: "t", requestText: "find notes about the project", context: {} }, ctx());
    expect(result.limitations.join(" ")).toMatch(/approved local workspace/i);
  });
});

describe("PromptPilot: decomposes compound requests into tool-specific prompts", () => {
  it("decomposes a 3+ clause request and tags each clause with a target specialist", async () => {
    const result = await promptPilotAgent(
      { runId: "t", requestText: "Research my project, check my code, and create a study plan", context: {} },
      ctx()
    );
    expect(result.findings.some((f) => f.includes("Helper"))).toBe(true);
    expect(result.findings.some((f) => f.includes("CodePilot"))).toBe(true);
    expect(result.findings.some((f) => f.includes("LearnPilot"))).toBe(true);
  });

  it("preserves stated constraints (e.g. grade level) across the generated prompts", async () => {
    const result = await promptPilotAgent(
      { runId: "t", requestText: "Explain recursion and quiz me, grade 7, and also check my code", context: {} },
      ctx()
    );
    expect(result.findings.join(" ")).toMatch(/grade level 7/);
  });
});
