import { describe, expect, it } from "vitest";
import { answerWithTools, parseDate } from "../src/lib/tools.js";
import { helperAgent } from "../src/agents/helper.js";
import { decideAgents } from "../src/router/decisionModel.js";

const now = new Date("2026-10-13T12:00:00");
const ask = (q: string) => answerWithTools(q, now)?.answer ?? null;

describe("Exact tools (the questions small models get wrong)", () => {
  it("counts letters and words", () => {
    expect(ask("How many r's are in strawberry?")).toMatch(/\*\*3\*\*/);
    expect(ask("count the s in mississippi")).toMatch(/\*\*4\*\*/);
    expect(ask("How many letters are in the word encyclopedia?")).toMatch(/\*\*12\*\*/);
    expect(ask("how many words in 'the quick brown fox jumps'")).toMatch(/\*\*5\*\*/);
    expect(ask("spell stressed backwards")).toMatch(/desserts/);
  });

  it("compares and sorts decimals correctly", () => {
    expect(ask("Which is bigger: 9.11 or 9.9?")).toMatch(/^\*\*9\.9\*\*/);
    expect(ask("is 9.11 bigger than 9.9?")).toMatch(/^\*\*No\*\*/);
    expect(ask("sort 5, 3, 10, 1.5 and 7")).toMatch(/1\.5, 3, 5, 7, 10/);
    expect(ask("sort these numbers from largest to smallest: 4 9 2")).toMatch(/9, 4, 2/);
  });

  it("knows primes, factors, gcd and lcm", () => {
    expect(ask("Is 97 prime?")).toMatch(/Yes/);
    expect(ask("is 91 a prime number")).toMatch(/7 × 13/);
    expect(ask("prime factors of 360")).toMatch(/2 × 2 × 2 × 3 × 3 × 5/);
    expect(ask("what is the 100th prime")).toMatch(/541/);
    expect(ask("gcd of 48 and 180")).toMatch(/\*\*12\*\*/);
    expect(ask("lcm of 4, 6 and 10")).toMatch(/\*\*60\*\*/);
  });

  it("does percentages and plain arithmetic", () => {
    expect(ask("What is 17% of 240?")).toMatch(/40\.8/);
    expect(ask("what percent of 80 is 20")).toMatch(/25%/);
    expect(ask("15% tip on $48")).toMatch(/7\.2.*55\.2/);
    expect(ask("what's 12 times 8")).toMatch(/\*\*96\*\*/);
    expect(ask("what is 2^10 + 3*4")).toMatch(/1036/);
  });

  it("converts units", () => {
    expect(ask("convert 5 miles to km")).toMatch(/8\.0467 km/);
    expect(ask("100 F in C")).toMatch(/37\.7778 °C/);
    expect(ask("how many ounces in a pound")).toMatch(/16 oz/);
    expect(ask("how many days in a week")).toMatch(/1 week = \*\*7 days\*\*/);
    expect(ask("5 miles in kg")).toBeNull(); // different kinds of unit
  });

  it("works out dates", () => {
    expect(ask("what day of the week was July 4, 1776")).toMatch(/Thursday/);
    expect(ask("how many days until christmas")).toMatch(/73 days/);
    expect(ask("is 1900 a leap year")).toMatch(/No/);
    expect(ask("is 2000 a leap year")).toMatch(/Yes/);
    expect(ask("how old is someone born on March 15, 2000")).toMatch(/\*\*26\*\*/);
    expect(parseDate("12/25/2026", now)?.toISOString().slice(0, 10)).toBe("2026-12-25");
  });

  it("leaves open-ended questions to the model", () => {
    for (const q of ["why is the sky blue", "write a poem about cats", "explain photosynthesis", "connect an LED to my arduino"]) expect(ask(q)).toBeNull();
  });

  it("Helper answers with the tool, with no model at all", async () => {
    const r = await helperAgent({ runId: "t", requestText: "How many r's are in strawberry?", context: {} }, { signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! });
    expect(r.findings[0]).toMatch(/\*\*3\*\*/);
    expect(r.confidence).toBeGreaterThan(0.95);
    expect(decideAgents("How many r's are in strawberry?").selectedAgents).toEqual(["Helper"]);
  });
});
