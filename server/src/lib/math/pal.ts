import { EvalBudget, evaluate, parse } from "./expr.js";

// Program-aided answers for word problems: the model writes the reasoning and
// the calculation as steps ("total = price * 3"), and OmniPilot runs the steps
// exactly. A small model sets up the problem; the arithmetic is never guessed,
// so it can't make the arithmetic slips even much bigger models make.
// training/ teaches omnipilot-mini this exact format (same prompt, same schema).

export const PAL_SYSTEM =
  "You solve word problems. Think briefly, then write the calculation as steps. " +
  "Each step is `name = expression` using numbers and names from earlier steps, with + - * / ^ and parentheses " +
  "(functions allowed: round, floor, ceil, min, max, sqrt). The last step must be `answer = ...`. " +
  "Never do arithmetic in your head: write the expression and the computer will calculate it.";

export const PAL_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    steps: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 },
  },
  required: ["reasoning", "steps"],
};

export const PAL_EXAMPLE = {
  user: "A shirt costs $40 and is 25% off. Sam buys 3 of them. How much does Sam pay?",
  assistant: JSON.stringify({
    reasoning: "Each shirt is 25% off $40, so find the sale price, then multiply by 3.",
    steps: ["discount = 40 * 0.25", "price = 40 - discount", "answer = price * 3"],
  }),
};

export interface StepTrace {
  name: string;
  expression: string;
  value: number;
}

const STEP = /^\s*([a-z_][a-z0-9_]*)\s*=\s*(.+?)\s*$/i;

/** Runs the steps in order; null if any step can't be read or doesn't give a finite number. */
export function runSteps(steps: string[]): { value: number; trace: StepTrace[] } | null {
  const env: Record<string, number> = {};
  const trace: StepTrace[] = [];
  // One calculation budget for all the steps (the model writes them, so they're untrusted input).
  const budget = new EvalBudget(2_000_000);
  for (const [i, raw] of steps.entries()) {
    const m = STEP.exec(raw.replace(/[`$]/g, "").replace(/(\d),(?=\d{3}\b)/g, "$1"));
    const name = m ? m[1].toLowerCase() : i === steps.length - 1 ? "answer" : null;
    const expression = m ? m[2] : raw;
    if (!name) return null;
    let value: number;
    try {
      value = evaluate(parse(expression, new Set(Object.keys(env))), env, budget);
    } catch {
      return null;
    }
    if (!Number.isFinite(value)) return null;
    env[name] = value;
    trace.push({ name, expression, value });
  }
  return trace.length ? { value: trace[trace.length - 1].value, trace } : null;
}

/** 72 -> "72", 2.5 -> "2.5", 0.333333 -> "0.3333", 1234567 -> "1234567". */
export function formatNumber(x: number): string {
  if (Math.abs(x - Math.round(x)) < 1e-9) return String(Math.round(x));
  return String(Math.round(x * 10_000) / 10_000);
}

/** A question that's mostly about computing a number ("how many...", "what's 15% of 80?"). */
export function isWordProblem(text: string): boolean {
  const numbers = (text.match(/\d+(\.\d+)?/g) ?? []).length + (text.match(/\b(half|twice|double|triple|third|quarter|dozen|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand)\b/gi) ?? []).length;
  return numbers >= 2 && /\b(how (many|much|long|far|old)|what (is|was|will)|total|left|remain\w*|each|per|altogether|cost|pay|earn|percent|%|average|times)\b/i.test(text);
}
