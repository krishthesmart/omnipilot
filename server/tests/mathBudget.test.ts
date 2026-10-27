import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { BudgetExceeded, EvalBudget, checkIdentity, evaluate, parse } from "../src/lib/math/expr.js";
import { runSteps } from "../src/lib/math/pal.js";

// Finding 3: unbounded nested math evaluation.
const timed = <T,>(fn: () => T) => {
  const t = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t };
};

describe("Finding 3: math evaluation is bounded per calculation", () => {
  it("refuses nested sums that multiply into trillions of steps, quickly", () => {
    const nested = timed(() => checkIdentity("sum(sum(1, k, 1, 1000000), n, 1, 1000000)", "1"));
    expect(nested.value.verdict).toBe("unclear");
    expect(nested.value.detail).toMatch(/too much calculating/);
    expect(nested.ms).toBeLessThan(5000);
    const nestedInfinite = timed(() => checkIdentity("sum(sum(1/k^2, k, 1, inf), n, 1, inf)", "1"));
    expect(nestedInfinite.value.verdict).toBe("unclear");
    expect(nestedInfinite.ms).toBeLessThan(5000);
  });

  it("still computes reasonable nested sums", () => {
    expect(checkIdentity("sum(sum(k, k, 1, 10), n, 1, 10)", "550").verdict).toBe("true");
    expect(checkIdentity("sum(sum(1, j, 1, k), k, 1, n)", "n(n+1)/2").verdict).toBe("true");
  });

  it("gives every check its own budget (repeated checks never run each other out)", () => {
    // Each of these uses millions of steps; a shared counter would fail the later ones.
    for (let i = 0; i < 5; i++) expect(checkIdentity("sum(1/n^2, n, 1, inf)", "pi^2/6").verdict).toBe("true");
    const tree = parse("sum(k, k, 1, 1000000)");
    for (let i = 0; i < 3; i++) expect(evaluate(tree, {})).toBe(500000500000);
  });

  it("stops an evaluation that exceeds its own budget", () => {
    expect(() => evaluate(parse("sum(sum(1, k, 1, 1000), n, 1, 1000)"), {}, new EvalBudget(10_000))).toThrow(BudgetExceeded);
  });

  it("refuses deeply nested input instead of overflowing the stack", () => {
    expect(() => parse(`${"(".repeat(5000)}1${")".repeat(5000)}`)).toThrow(/nested too deeply/);
    expect(() => parse(`${"-".repeat(5000)}1`)).toThrow(/nested too deeply/);
    expect(evaluate(parse(`${"(".repeat(50)}2${")".repeat(50)}`), {})).toBe(2); // normal nesting is fine
  });

  it("keeps the API and word-problem steps responsive", async () => {
    const res = await request(createApp()).post("/api/math/check").send({ equation: "sum(prod(1, j, 1, 100000), k, 1, 1000000) = 1" });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("unclear");
    const steps = timed(() => runSteps(["a = sum(sum(1, k, 1, 100000), n, 1, 100000)", "answer = a"]));
    expect(steps.value).toBeNull();
    expect(steps.ms).toBeLessThan(5000);
  });
});
