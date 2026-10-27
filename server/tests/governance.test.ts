import { describe, expect, it } from "vitest";
import { governanceCheck, judgeOutcome, unusable } from "../src/lib/governance.js";
import { executeRun } from "../src/pipeline.js";

describe("governance: saying plainly what isn't possible", () => {
  it("recognises things OmniPilot can never do", () => {
    for (const [q, id] of [
      ["make a video of a volcano erupting", "video"],
      ["order me a pizza", "purchase"],
      ["book me a flight to Denver", "purchase"],
      ["send a text to my mom", "phone"],
      ["turn off the lights", "devices"],
      ["hack into my friend's instagram account", "others_accounts"],
      ["what are the winning lottery numbers", "predictions"],
      ["delete all my files", "outside_workspace"],
      ["send an email to sam@example.com", "send_email"],
    ])
      expect(governanceCheck(q).hits.map((h) => h.id), q).toContain(id);
  });

  it("doesn't flag ordinary requests", () => {
    for (const q of ["explain the order of operations", "call list_notes on notes", "pay attention to this function", "turn off code alerts", "what is the price of a stock", "draw a cat", "build a 3d model of a rocket", "summarize my unread emails", "make a picture of a movie theater"])
      expect(governanceCheck(q).hits, q).toEqual([]);
  });

  it("knows whether all of the request or only part is impossible", () => {
    expect(governanceCheck("order me a pizza").whole).toBe(true);
    expect(governanceCheck("make a video about photosynthesis and explain photosynthesis").whole).toBe(false);
    expect(governanceCheck("send an email to sam@example.com saying hi").whole).toBe(false); // drafted instead
  });

  it("answers 'not possible' without running agents", async () => {
    const r = await executeRun("order me a pizza");
    expect(r.finalResponse!.summary).toMatch(/That isn't possible/);
    expect(r.finalResponse!.summary).toMatch(/compare options/);
    expect(r.finalResponse!.governance?.verdict).toBe("not_possible");
    expect(r.agentResults ?? []).toHaveLength(0);
  });

  it("says which part isn't possible and still does the rest", async () => {
    const r = await executeRun("make a video about photosynthesis and explain photosynthesis");
    expect(r.finalResponse!.governance?.verdict).toBe("partly_possible");
    expect(r.finalResponse!.summary).toMatch(/Part of this isn't possible/);
    expect(r.agentResults!.length).toBeGreaterThan(0);
  });

  it("judges outcomes: nothing usable means not possible", () => {
    const base = { agent: "CodePilot", findings: ["Building a project needs the AI model"], evidence: [], limitations: [], proposedActions: [], startedAt: "", completedAt: "", elapsedMs: 0, retries: 0 } as any;
    expect(unusable({ ...base, status: "partial_success", confidence: 0.1 })).toBe(true);
    expect(unusable({ ...base, status: "partial_success", confidence: 0.5 })).toBe(false);
    expect(judgeOutcome({ hits: [], whole: false }, [{ ...base, status: "timeout", confidence: 0 }]).verdict).toBe("not_possible");
    expect(judgeOutcome({ hits: [], whole: false }, [{ ...base, status: "success", confidence: 0.8 }]).verdict).toBe("possible");
  });
});
