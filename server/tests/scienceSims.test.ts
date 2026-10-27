import { describe, expect, it } from "vitest";
import { scienceLabAgent } from "../src/agents/scienceLab.js";
import { decideAgents } from "../src/router/decisionModel.js";

const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! }) as any;
const run = (q: string) => scienceLabAgent({ runId: "s", requestText: q, context: {} } as any, ctx());
const outputs = (r: any) => JSON.parse(r.findings.find((f: string) => f.startsWith("Outputs: ")).slice(9));

describe("ScienceLab's simulations (checked against known values)", () => {
  it("pendulum: a 1 m pendulum swings in about 2 seconds on Earth, longer on the Moon", async () => {
    expect(outputs(await run("simulate a 1 m pendulum")).periodSec).toBeCloseTo(2.01, 1);
    expect(outputs(await run("simulate a 1 m pendulum on the moon")).periodSec).toBeCloseTo(4.94, 1);
  });

  it("free fall: 45 m takes about 3 seconds", async () => {
    const o = outputs(await run("a ball is dropped from 45 meters"));
    expect(o.fallTimeSec).toBeCloseTo(3.03, 1);
    expect(o.impactSpeedMs).toBeCloseTo(29.7, 0);
  });

  it("radioactive decay: after two half-lives a quarter is left", async () => {
    const o = outputs(await run("carbon-14 has a half-life of 5730 years. How much of 100 grams is left after 11460 years?"));
    expect(o.remainingAfterElapsed).toBeCloseTo(25, 5);
  });

  it("medicine in the body: repeated doses settle between a steady peak and trough, with a not-medical-advice note", async () => {
    const r = await run("how much ibuprofen is in my body if I take 400 mg every 8 hours with a half-life of 2 hours?");
    const o = outputs(r);
    expect(o.steadyStatePeakMg).toBeCloseTo(400 / (1 - Math.pow(0.5, 4)), 0); // 426.67
    expect(o.steadyStateTroughMg).toBeCloseTo(o.steadyStatePeakMg / 16, 0);
    expect(r.findings[0]).toMatch(/not medical advice/);
  });

  it("predator-prey: both populations cycle", async () => {
    const o = outputs(await run("simulate 40 rabbits and 9 foxes"));
    expect(o.preyRange[1]).toBeGreaterThan(o.preyRange[0]);
    expect(o.predatorRange[1]).toBeGreaterThan(o.predatorRange[0]);
  });

  it("cooling: 90°C coffee in a 20°C room gets to 60°C in about 11 minutes (ln(70/40) / 0.05)", async () => {
    expect(outputs(await run("how fast does coffee at 90°C cool in a 20°C room?")).minutesToReachTarget).toBeCloseTo(11.19, 1);
  });

  it("soil: suggests where a soil type is found, honestly", async () => {
    const r = await run("I found red clay dirt in my backyard, where could I be?");
    expect(r.findings[0]).toMatch(/Laterite[\s\S]*southeastern US/);
    expect(r.findings[1]).toMatch(/can't pinpoint/);
  });

  it("routes these to ScienceLab", () => {
    for (const q of ["simulate a 2 m pendulum", "a rock is dropped from 80 meters, how long does it fall", "carbon-14 half-life of 5730 years", "simulate predators and prey", "I found black crumbly soil, where in the world could I be?"]) {
      expect(decideAgents(q).selectedAgents, q).toContain("ScienceLab");
    }
  });
});
