import { describe, expect, it } from "vitest";
import { TRICKS, applyTrick, numbersIn } from "../src/lib/math/tricks.js";
import { mathPilotAgent } from "../src/agents/mathPilot.js";
import { decideAgents } from "../src/router/decisionModel.js";

const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! }) as any;
const ask = (requestText: string) => mathPilotAgent({ runId: "m", requestText, context: {} } as any, ctx());

describe("Math tricks", () => {
  it("never gives a wrong answer: every trick agrees with exact arithmetic wherever it applies", () => {
    let applied = 0;
    for (const t of TRICKS) {
      for (let a = 0; a <= 1000; a += 1) {
        for (const b of [a, 2, 5, 9, 11, 25, 50, 100, 96, 52, 372, a + 4]) {
          const r = t.apply(a, b);
          if (!r) continue;
          applied++;
          const exact = t.id === "from1000" ? a - b : t.id === "percentSwap" ? (a * b) / 100 : t.id === "square5" ? a * a : a * b;
          expect(r.answer, `${t.id} ${a},${b}`).toBeCloseTo(exact, 9);
        }
      }
    }
    expect(applied).toBeGreaterThan(1000);
  });

  it("finds the numbers in everyday wording", () => {
    expect(numbersIn("quick way to do 34 × 11")).toEqual({ a: 34, b: 11 });
    expect(numbersIn("trick for 65 squared")).toEqual({ a: 65, b: 65 });
    expect(numbersIn("8% of 50")).toEqual({ a: 8, b: 50 });
    expect(numbersIn("1,000 - 372")).toEqual({ a: 1000, b: 372 });
  });

  it("picks the right trick and shows the steps", () => {
    expect(applyTrick("trick for 34 x 11")).toMatchObject({ trick: { id: "times11" }, answer: 374 });
    expect(applyTrick("78 times 11 in your head")).toMatchObject({ trick: { id: "times11" }, answer: 858 });
    expect(applyTrick("65 squared")).toMatchObject({ trick: { id: "square5" }, answer: 4225 });
    expect(applyTrick("48 × 52")).toMatchObject({ trick: { id: "nearRound" }, answer: 2496 });
    expect(applyTrick("97 × 96")).toMatchObject({ trick: { id: "near100" }, answer: 9312 });
    expect(applyTrick("1000 - 372")).toMatchObject({ trick: { id: "from1000" }, answer: 628 });
    expect(applyTrick("8% of 50")).toMatchObject({ trick: { id: "percentSwap" }, answer: 4 });
  });

  it("MathPilot answers trick requests, and they reach it from the router", async () => {
    expect((await ask("what's a quick way to multiply 34 by 11?")).findings[0]).toMatch(/Answer: 374/);
    expect((await ask("teach me a math trick")).findings[0]).toMatch(/Example:/);
    expect((await ask("show me all math tricks")).findings[0]).toMatch(/Multiply a two-digit number by 11[\s\S]*Subtract from 1000/);
    expect((await ask("divisibility tricks")).findings[0]).toMatch(/By 3/);
    for (const q of ["teach me a math trick", "mental math for 65 squared", "shortcut for multiplying by 11"]) expect(decideAgents(q).selectedAgents, q).toContain("MathPilot");
  });
});

describe("Routing fixes from live testing", () => {
  it("sends trick requests to MathPilot alone, and skill creation to InfraPilot alone", () => {
    expect(decideAgents("what is a quick way to multiply 34 by 11?").selectedAgents).toEqual(["MathPilot"]);
    expect(decideAgents("teach me a math trick").selectedAgents).toEqual(["MathPilot"]);
    expect(decideAgents("teach me a math trick and quiz me on it").selectedAgents).toContain("LearnPilot");
    expect(decideAgents("create a skill called start_my_day that tells me what is due and teaches me a math trick").selectedAgents).toEqual(["InfraPilot"]);
  });
});
