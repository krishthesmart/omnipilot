import { describe, expect, it } from "vitest";
import { profileSigns, extractSigns } from "../src/lib/decipher.js";
import { scriptScholarAgent } from "../src/agents/scriptScholar.js";
import { decideAgents } from "../src/router/decisionModel.js";

const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! }) as any;
const run = (q: string) => scriptScholarAgent({ runId: "d", requestText: q, context: {} } as any, ctx());

describe("ScriptScholar's decipherment helper", () => {
  it("transliterates Phoenician and recognises a small alphabet", () => {
    // 𐤀𐤁𐤂𐤃 = ʾ b g d
    const p = profileSigns("decipher this: \u{10900}\u{10901}\u{10902}\u{10903} \u{10900}\u{10901}")!;
    expect(p.script).toBe("Phoenician");
    expect(p.transliteration).toBe("ʾbgd ʾb");
    expect(p.distinct).toBe(4);
  });

  it("transliterates runes", () => {
    const p = profileSigns("ᚠᚢᚦᚨᚱᚲ")!; // ᚠᚢᚦᚨᚱᚲ
    expect(p.transliteration).toBe("futhark");
  });

  it("reads Linear-A-style sign codes and finds repeated groups", () => {
    const text = "decipher: AB01 AB28 AB59 AB01 AB28 AB04 AB01 AB28 AB59 AB77";
    expect(extractSigns(text).signs).toHaveLength(10);
    const p = profileSigns(text)!;
    expect(p.repeats[0]).toEqual({ group: "AB01-AB28", count: 3 });
    expect(p.repeats.some((r) => r.group === "AB01-AB28-AB59" && r.count === 2)).toBe(true);
  });

  it("a text with many different signs points to a bigger script than one that repeats a few", () => {
    const alphabetLike = Array.from({ length: 300 }, (_, i) => `A${String(10 + ((i * 7) % 22)).padStart(2, "0")}`).join(" ");
    const logoLike = Array.from({ length: 300 }, (_, i) => `B${100 + ((i * 13) % 280)}`).join(" ");
    const a = profileSigns(`decipher ${alphabetLike}`)!;
    const l = profileSigns(`decipher ${logoLike}`)!;
    expect(a.likelyType).toMatch(/alphabet/);
    expect(a.estimatedInventory).toBeLessThan(40);
    expect(l.estimatedInventory).toBeGreaterThan(110);
    expect(l.likelyType).toMatch(/logo/);
  });

  it("nothing to analyse in ordinary text", () => {
    expect(profileSigns("compare cuneiform and hieroglyphs")).toBeNull();
  });

  it("the agent reports the profile and says it's not a translation", async () => {
    const r = await run("decipher this unknown script: AB01 AB28 AB59 AB01 AB28 AB04");
    expect(r.status).toBe("success");
    expect(r.findings.join("\n")).toMatch(/Sign count/);
    expect(r.findings.join("\n")).toMatch(/not a translation/);
  });

  it("comparisons still work", async () => {
    const r = await run("compare cuneiform and hieroglyphs");
    expect(r.findings.join("\n")).not.toMatch(/Sign count/);
  });

  it("routes decipherment requests to ScriptScholar", async () => {
    const d = decideAgents("decipher this mystery script for me: AB01 AB28 AB59 AB01");
    expect(d.selectedAgents).toContain("ScriptScholar");
  });
});

describe("short texts and pasted ancient text", () => {
  it("doesn't claim a script type from a few signs", () => {
    expect(profileSigns("decipher AB01 AB28 AB59 AB01 AB28 AB04")!.likelyType).toMatch(/too little text/);
  });
  it("routes pasted Phoenician to ScriptScholar even without the word decipher", () => {
    expect(decideAgents("what does this say? \u{10901}\u{1090F}\u{1090B} \u{1090C}\u{1090B}\u{1090A}").selectedAgents).toContain("ScriptScholar");
  });
  it("modern Greek isn't treated as an ancient script", () => {
    expect(decideAgents("τι κάνεις σήμερα;").selectedAgents).not.toContain("ScriptScholar");
  });
});
