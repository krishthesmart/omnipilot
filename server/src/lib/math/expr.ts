// A small, safe math-expression parser for MathPilot's identity checker
// ("is sin(x)^2 + cos(x)^2 = 1?"). It builds a tree and evaluates it --
// never eval() -- and supports + − × ÷ ^ !, implicit multiplication (2x, 3π),
// the usual functions, and sum()/prod() over a range.

export type Node =
  | { k: "num"; v: number }
  | { k: "var"; name: string }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Node; b: Node }
  | { k: "fact"; a: Node }
  | { k: "call"; fn: string; args: Node[] }
  | { k: "agg"; fn: "sum" | "prod"; body: Node; index: string; from: Node; to: Node };

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, phi: (1 + Math.sqrt(5)) / 2, tau: 2 * Math.PI, inf: Infinity, infinity: Infinity };

const FNS: Record<string, (...x: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sec: (x) => 1 / Math.cos(x), csc: (x) => 1 / Math.sin(x), cot: (x) => 1 / Math.tan(x),
  exp: Math.exp, ln: Math.log, log: Math.log, log10: Math.log10, log2: Math.log2,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  round: (x, digits = 0) => Math.round(x * 10 ** digits) / 10 ** digits,
  min: (...x) => Math.min(...x), max: (...x) => Math.max(...x), mod: (a, b) => ((a % b) + b) % b,
  gamma: (x) => gamma(x),
  binom: (n, k) => gamma(n + 1) / (gamma(k + 1) * gamma(n - k + 1)),
  choose: (n, k) => gamma(n + 1) / (gamma(k + 1) * gamma(n - k + 1)),
};

/** Lanczos approximation (≈15 digits). */
function gamma(x: number): number {
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return Math.sqrt(2 * Math.PI) * t ** (x + 0.5) * Math.exp(-t) * a;
}

function factorial(n: number): number {
  if (Number.isInteger(n) && n > 170) return Infinity;
  if (Number.isInteger(n) && n >= 0) {
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  }
  return gamma(n + 1);
}

/** Turns typed/pasted math into the parser's ASCII form. */
export function normalizeMath(s: string): string {
  return s
    .replace(/[−–—]/g, "-")
    .replace(/[×·∙]/g, "*")
    .replace(/÷/g, "/")
    .replace(/π/g, "pi")
    .replace(/φ/g, "phi")
    .replace(/∞/g, "inf")
    .replace(/√\s*\(/g, "sqrt(")
    .replace(/√\s*([a-z0-9.]+)/gi, "sqrt($1)")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/\*\*/g, "^")
    .replace(/\bsquare root of\b/gi, "sqrt")
    .trim();
}

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0].toLowerCase() });
      i += id[0].length;
      continue;
    }
    if ("+-*/^(),!".includes(ch)) {
      out.push({ t: "op", v: ch });
      i++;
      continue;
    }
    throw new Error(`I can't read "${ch}" in that expression`);
  }
  return out;
}

/** Splits an identifier like "xy" or "2pix" glued together: known names win, otherwise single letters. */
function splitIdentifier(id: string, known: (s: string) => boolean): string[] {
  // Names with digits or underscores ("s1", "total_cost") are always one variable.
  if (known(id) || id.length === 1 || /[\d_]/.test(id)) return [id];
  for (let len = id.length - 1; len >= 1; len--) {
    const head = id.slice(0, len);
    if (known(head) || len === 1) return [head, ...splitIdentifier(id.slice(len), known)];
  }
  return [id];
}

/** `names`: variables that are already defined, so multi-letter names ("price") aren't split into letters. */
export function parse(input: string, names: Set<string> = new Set()): Node {
  const raw = tokenize(normalizeMath(input));
  const known = (s: string) => names.has(s) || s in CONSTS || s in FNS || s === "sum" || s === "prod";
  // Expand glued identifiers ("xy" -> x y) unless they're a known name.
  const toks: Tok[] = raw.flatMap((t): Tok[] => (t.t === "id" ? splitIdentifier(t.v, known).map((v) => ({ t: "id" as const, v })) : [t]));
  let pos = 0;
  // Deeply nested input ("((((...))))", "- - - - x") would otherwise overflow the stack.
  let depth = 0;
  const enter = () => {
    if (++depth > MAX_DEPTH) throw new Error("that expression is nested too deeply");
  };
  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`expected "${v}"`);
    pos++;
  };

  // expr := term (('+'|'-') term)*
  function expr(): Node {
    enter();
    let left = term();
    while (isOp("+") || isOp("-")) {
      const op = (toks[pos++] as { v: "+" | "-" }).v;
      left = { k: "bin", op, a: left, b: term() };
    }
    depth--;
    return left;
  }
  // term := unary (('*'|'/'|implicit) unary)*
  function term(): Node {
    let left = unary();
    for (;;) {
      if (isOp("*") || isOp("/")) {
        const op = (toks[pos++] as { v: "*" | "/" }).v;
        left = { k: "bin", op, a: left, b: unary() };
      } else if (peek() && (peek()!.t === "num" || peek()!.t === "id" || isOp("("))) {
        left = { k: "bin", op: "*", a: left, b: unary() }; // implicit: 2x, 3(x+1), x sin(x)
      } else return left;
    }
  }
  // unary := '-' unary | power
  function unary(): Node {
    enter();
    try {
      if (isOp("-")) {
        pos++;
        return { k: "neg", a: unary() };
      }
      if (isOp("+")) {
        pos++;
        return unary();
      }
      return power();
    } finally {
      depth--;
    }
  }
  // power := postfix ('^' unary)?   (right-associative, binds tighter than unary minus on the left)
  function power(): Node {
    const base = postfix();
    if (isOp("^")) {
      pos++;
      return { k: "bin", op: "^", a: base, b: unary() };
    }
    return base;
  }
  function postfix(): Node {
    let n = atom();
    while (isOp("!")) {
      pos++;
      n = { k: "fact", a: n };
    }
    return n;
  }
  function atom(): Node {
    const t = peek();
    if (!t) throw new Error("the expression ends too early");
    if (t.t === "num") {
      pos++;
      return { k: "num", v: t.v };
    }
    if (isOp("(")) {
      pos++;
      const e = expr();
      expect(")");
      return e;
    }
    if (t.t === "id") {
      pos++;
      if (t.v === "sum" || t.v === "prod") {
        expect("(");
        const body = expr();
        expect(",");
        const idx = peek();
        if (idx?.t !== "id") throw new Error(`${t.v}(expression, n, from, to) needs an index letter`);
        pos++;
        expect(",");
        const from = expr();
        expect(",");
        const to = expr();
        expect(")");
        return { k: "agg", fn: t.v, body, index: idx.v, from, to };
      }
      if (t.v in FNS) {
        if (isOp("(")) {
          pos++;
          const args = [expr()];
          while (isOp(",")) {
            pos++;
            args.push(expr());
          }
          expect(")");
          return { k: "call", fn: t.v, args };
        }
        // "sin x", "ln 2": function applied to the next power-level term
        return { k: "call", fn: t.v, args: [power()] };
      }
      if (t.v in CONSTS && !names.has(t.v)) return { k: "num", v: CONSTS[t.v] };
      return { k: "var", name: t.v };
    }
    throw new Error(`unexpected "${t.v}"`);
  }

  const tree = expr();
  if (pos < toks.length) throw new Error(`unexpected "${(toks[pos] as any).v}"`);
  return tree;
}

/** Free variables (not bound by a sum/prod index). */
export function variables(n: Node, bound: Set<string> = new Set()): Set<string> {
  const out = new Set<string>();
  const walk = (x: Node, b: Set<string>) => {
    switch (x.k) {
      case "var":
        if (!b.has(x.name)) out.add(x.name);
        break;
      case "neg":
      case "fact":
        walk(x.a, b);
        break;
      case "bin":
        walk(x.a, b);
        walk(x.b, b);
        break;
      case "call":
        x.args.forEach((a) => walk(a, b));
        break;
      case "agg":
        walk(x.from, b);
        walk(x.to, b);
        walk(x.body, new Set([...b, x.index]));
        break;
    }
  };
  walk(n, bound);
  return out;
}

export function hasInfiniteSum(n: Node): boolean {
  if (n.k === "agg") {
    let to: number | null = null;
    try {
      to = evaluate(n.to, {}, new EvalBudget(100_000));
    } catch {
      // the upper limit is a variable ("sum to n")
    }
    return to === Infinity || hasInfiniteSum(n.body);
  }
  if (n.k === "neg" || n.k === "fact") return hasInfiniteSum(n.a);
  if (n.k === "bin") return hasInfiniteSum(n.a) || hasInfiniteSum(n.b);
  if (n.k === "call") return n.args.some(hasInfiniteSum);
  return false;
}

const MAX_TERMS = 2_000_000;
const MAX_DEPTH = 250; // about two per bracket level

/**
 * A calculation's step allowance: every evaluated node costs one step, nested sums and products
 * included, so nesting can't multiply the work. Each request makes its own budget (nothing is
 * shared between requests), and running out is an error the caller reports, not a stalled server.
 */
export class EvalBudget {
  used = 0;
  constructor(readonly limit = 5_000_000) {}
  step() {
    if (++this.used > this.limit) throw new BudgetExceeded();
  }
}

export class BudgetExceeded extends Error {
  constructor() {
    super("that would take too much calculating");
    this.name = "BudgetExceeded";
  }
}

export function evaluate(n: Node, env: Record<string, number>, budget: EvalBudget = new EvalBudget()): number {
  budget.step();
  switch (n.k) {
    case "num":
      return n.v;
    case "var":
      if (!(n.name in env)) throw new Error(`no value for ${n.name}`);
      return env[n.name];
    case "neg":
      return -evaluate(n.a, env, budget);
    case "fact":
      return factorial(evaluate(n.a, env, budget));
    case "call": {
      const args = n.args.map((a) => evaluate(a, env, budget));
      return FNS[n.fn](...args);
    }
    case "bin": {
      const a = evaluate(n.a, env, budget);
      const b = evaluate(n.b, env, budget);
      switch (n.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "^": return a ** b;
      }
    }
    // falls through (unreachable)
    case "agg": {
      const from = Math.round(evaluate(n.from, env, budget));
      const toRaw = evaluate(n.to, env, budget);
      if (!Number.isFinite(from)) return NaN;
      if (toRaw === Infinity) return infiniteAggregate(n, env, from, budget);
      const to = Math.round(toRaw);
      if (to - from > MAX_TERMS) throw new Error("that sum has too many terms to add up");
      let acc = n.fn === "sum" ? 0 : 1;
      const local = { ...env };
      for (let i = from; i <= to; i++) {
        local[n.index] = i;
        const v = evaluate(n.body, local, budget);
        acc = n.fn === "sum" ? acc + v : acc * v;
      }
      return acc;
    }
  }
}

/**
 * Infinite sums/products: partial results at N and 2N terms plus Richardson
 * extrapolation (assumes the usual 1/N tail). Good to ~8-10 digits for typical
 * series; the checker uses a looser tolerance when these appear.
 */
function infiniteAggregate(n: Extract<Node, { k: "agg" }>, env: Record<string, number>, from: number, budget: EvalBudget): number {
  const N = 400_000;
  const local = { ...env };
  let acc = n.fn === "sum" ? 0 : 1;
  let atN = 0;
  let atHalf = 0;
  let atQuarter = 0;
  for (let i = from; i < from + N; i++) {
    local[n.index] = i;
    const v = evaluate(n.body, local, budget);
    acc = n.fn === "sum" ? acc + v : acc * v;
    const count = i - from + 1;
    if (count === N / 4) atQuarter = acc;
    if (count === N / 2) atHalf = acc;
  }
  atN = acc;
  if (n.fn === "prod") return 2 * atN - atHalf;
  // If the terms still change a lot, check it's actually converging (alternating or 1/N-like).
  if (!Number.isFinite(atN)) return atN;
  const d1 = atHalf - atQuarter;
  const d2 = atN - atHalf;
  if (Math.abs(d2) > Math.abs(d1) * 0.9 && Math.abs(d2) > 1e-6) return Infinity; // diverges (like Σ 1/n)
  // Two-step Richardson for a/N + b/N² tails.
  const r1 = 2 * atN - atHalf;
  const r0 = 2 * atHalf - atQuarter;
  return (4 * r1 - r0) / 3;
}

export interface IdentityCheck {
  verdict: "true" | "false" | "unclear";
  left: string;
  right: string;
  detail: string;
  /** For variable identities: points tried, and a counterexample if one was found. */
  pointsTested?: number;
  counterexample?: { values: Record<string, number>; left: number; right: number };
  digits?: number;
}

const fmt = (x: number) => (Number.isInteger(x) && Math.abs(x) < 1e15 ? String(x) : x.toPrecision(15).replace(/\.?0+(e|$)/, "$1"));

/** Checks "left = right" numerically: exactly-evaluable sides to ~13 digits, variable identities at many random points. */
export function checkIdentity(left: string, right: string): IdentityCheck {
  // One budget for the whole check (every test point), made fresh for each check.
  const budget = new EvalBudget(20_000_000);
  try {
    return checkWithin(left, right, budget);
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      return { verdict: "unclear", left, right, detail: "That would take too much calculating to check here. Try smaller limits (for example fewer terms in a sum) or fewer nested sums." };
    }
    throw err;
  }
}

function checkWithin(left: string, right: string, budget: EvalBudget): IdentityCheck {
  const L = parse(left);
  const R = parse(right);
  const vars = [...new Set([...variables(L), ...variables(R)])];
  if (vars.includes("i")) {
    return { verdict: "unclear", left, right, detail: "That uses i (the imaginary unit). MathPilot only checks real-number identities for now." };
  }
  const infinite = hasInfiniteSum(L) || hasInfiniteSum(R);
  const tol = infinite ? 1e-7 : 1e-11;
  const close = (a: number, b: number) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
  const digitsOf = (a: number, b: number) => (a === b ? 15 : Math.max(0, Math.min(15, Math.floor(-Math.log10(Math.abs(a - b) / Math.max(1, Math.abs(a)))))));

  if (vars.length === 0) {
    const a = evaluate(L, {}, budget);
    const b = evaluate(R, {}, budget);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return { verdict: "unclear", left, right, detail: `One side doesn't have a finite value (left ≈ ${fmt(a)}, right ≈ ${fmt(b)}).` };
    }
    const ok = close(a, b);
    return {
      verdict: ok ? "true" : "false",
      left,
      right,
      digits: digitsOf(a, b),
      detail: ok
        ? `Both sides equal ${fmt(a)}${infinite ? " (the infinite sum was estimated, so this is about 8 digits)" : ` (they agree to ${digitsOf(a, b)} digits)`}.`
        : `Left side ≈ ${fmt(a)}, right side ≈ ${fmt(b)}.`,
    };
  }

  // Deterministic pseudo-random points, so the same question always gets the same answer.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const integerish = vars.every((v) => /^[nkmij]$/.test(v));
  let tested = 0;
  // Simple values first (so a counterexample is easy to follow), then random ones (so a
  // statement that happens to work at nice numbers, like x^2 = x at x = 1, is still caught).
  const NICE = [1, 2, 3, 0.5, -1, -2, 1.5, 4, -0.5, 5];
  for (let attempt = 0; attempt < 400 && tested < 40; attempt++) {
    const env: Record<string, number> = {};
    vars.forEach((v, i) => {
      env[v] =
        attempt < NICE.length
          ? integerish
            ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10][(attempt + i * 3) % 10]
            : NICE[(attempt + i * 3) % NICE.length]
          : integerish
            ? 1 + Math.floor(rand() * 12)
            : attempt < 200
              ? rand() * 6 - 3
              : rand() * 5 + 0.05;
    });
    let a: number, b: number;
    try {
      a = evaluate(L, env, budget);
      b = evaluate(R, env, budget);
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err; // out of budget for the whole check, not just this point
      continue;
    }
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue; // outside the domain (sqrt of a negative, ln 0...)
    tested++;
    if (!close(a, b)) {
      return {
        verdict: "false",
        left,
        right,
        pointsTested: tested,
        counterexample: { values: env, left: a, right: b },
        detail: `Not an identity: at ${vars.map((v) => `${v} = ${fmt(env[v])}`).join(", ")} the left side is ${fmt(a)} but the right side is ${fmt(b)}.`,
      };
    }
  }
  if (tested < 5) return { verdict: "unclear", left, right, pointsTested: tested, detail: "I couldn't find enough values where both sides are defined to test it." };
  return {
    verdict: "true",
    left,
    right,
    pointsTested: tested,
    detail: `Holds at all ${tested} ${integerish ? "whole-number" : "different"} values I tried for ${vars.join(", ")}. That's strong evidence, not a proof.`,
  };
}

/** Finds "A = B" in a sentence ("is it true that sin(x)^2 + cos(x)^2 = 1?"). */
export function extractEquation(text: string): { left: string; right: string } | null {
  const cleaned = text.replace(/[?]+\s*$/, "").replace(/`/g, "");
  const m = /^(.*?[^<>!=])\s*(?:==?|≟)\s*([^=].*)$/.exec(cleaned);
  if (!m) return null;
  // Strip the words before the math ("is it true that", "check:", "MathPilot, prove").
  const LEAD = /^\s*(?:hey\s+)?(?:mathpilot[,:]?|please|can you|could you|is it (?:true|correct|right) that|is it true|is|are|does|do|check|verify|prove|test|show|confirm|whether|that|if|me)\b\s*[:,]?\s*/i;
  const stripLead = (s: string) => {
    let prev = "";
    while (prev !== s) {
      prev = s;
      s = s.replace(LEAD, "");
    }
    return s;
  };
  const stripTail = (s: string) => s.replace(/\s+(?:for all|for every|always|true|holds|correct|right)\b.*$/i, "").replace(/[.,;:]+$/, "");
  const left = stripLead(m[1]).trim();
  const right = stripTail(m[2]).trim();
  if (!left || !right) return null;
  return { left, right };
}
