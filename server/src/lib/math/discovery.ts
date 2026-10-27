import { CONSTANTS, agreeingDigits, div, fromInt, mul, toDecimal, type Fixed } from "./precise.js";
import { bumpDiscoveryVariants, countDiscoveries, getMathState, insertDiscovery, listDiscoveries, saveMathState, type DiscoveryRow } from "../../db.js";

// MathPilot's always-on search, in the spirit of the Ramanujan Machine: it
// walks through polynomial continued fractions
//
//     x = a(0) + b(1) / (a(1) + b(2) / (a(2) + b(3) / ...))
//
// and asks whether each value equals (p + q·c) / (r + s·c) for a famous
// constant c (π, e, ζ(3), ...) with small integers p, q, r, s. A fast
// double-precision pass finds candidates; each one is then recomputed with
// 60-digit arithmetic and kept only if it holds to at least MIN_DIGITS digits.
// These are numerically verified conjectures, not proofs, and many will turn
// out to be known results -- the UI says so.

export const MIN_DIGITS = 20;
const COEF = 8; // |p|,|q|,|r|,|s| <= COEF in the relation
const MAX_P = 60; // |p| may be a bit larger

/**
 * Search levels, in order: polynomial degrees of a(n) and b(n), and the
 * coefficient range. Small, fast levels first; the later ones take days at
 * background speed, so the search effectively runs "full time".
 */
export const LEVELS = [
  { degA: 1, degB: 2, R: 3 },
  { degA: 1, degB: 2, R: 5 },
  { degA: 2, degB: 4, R: 2 },
  { degA: 2, degB: 4, R: 3 },
  { degA: 1, degB: 3, R: 4 },
  { degA: 3, degB: 6, R: 2 },
  { degA: 1, degB: 2, R: 9 },
  { degA: 2, degB: 4, R: 4 },
  { degA: 1, degB: 3, R: 6 },
  { degA: 2, degB: 4, R: 5 },
  { degA: 3, degB: 6, R: 3 },
  { degA: 2, degB: 4, R: 6 },
];

export interface Cursor {
  level: number;
  index: number;
}

export interface Candidate {
  a: number[]; // a(n) = a[0] + a[1] n + a[2] n² ...
  b: number[];
}

export interface Discovery extends Candidate {
  constant: string;
  /** x = (p + q·c) / (r + s·c) */
  relation: [number, number, number, number];
  value: string;
  digits: number;
}

const poly = (c: number[], n: number) => c.reduceRight((acc, k) => acc * n + k, 0);
const polyBig = (c: number[], n: number) => c.reduceRight((acc, k) => acc * BigInt(n) + BigInt(k), 0n);

export function levelSize(level: (typeof LEVELS)[number]): number {
  return (2 * level.R + 1) ** (level.degA + level.degB + 2);
}

/** The candidate at a position in the search, or null if it's filtered out (diverges, terminates, or repeats an earlier level). */
export function candidateAt(cursor: Cursor): Candidate | null {
  const level = LEVELS[cursor.level];
  const base = 2 * level.R + 1;
  const coeffs: number[] = [];
  let rest = cursor.index;
  for (let i = 0; i < level.degA + level.degB + 2; i++) {
    coeffs.push((rest % base) - level.R);
    rest = Math.floor(rest / base);
  }
  const a = coeffs.slice(0, level.degA + 1);
  const b = coeffs.slice(level.degA + 1);
  // Exact degrees only (lower degrees were covered by earlier levels), positive leading a.
  if (a[a.length - 1] <= 0 || b[b.length - 1] === 0) return null;
  // A wider range only re-checks combinations that use the new, larger coefficients.
  const earlier = LEVELS.slice(0, cursor.level).some((l) => l.degA === level.degA && l.degB === level.degB && l.R < level.R);
  if (earlier && !coeffs.some((c) => Math.abs(c) === level.R)) return null;
  for (let n = 1; n <= 12; n++) {
    if (poly(a, n) <= 0) return null; // keeps the fraction well-behaved
    if (poly(b, n) === 0) return null; // terminates: the value is rational
  }
  return { a, b };
}

/** Value of the continued fraction truncated at `depth`, by backward recurrence. */
export function evalCF(c: Candidate, depth: number): number {
  let t = poly(c.a, depth);
  for (let n = depth - 1; n >= 0; n--) {
    if (t === 0 || !Number.isFinite(t)) return NaN;
    t = poly(c.a, n) + poly(c.b, n + 1) / t;
  }
  return t;
}

export function evalCFPrecise(c: Candidate, depth: number): Fixed | null {
  let t = fromInt(polyBig(c.a, depth));
  for (let n = depth - 1; n >= 0; n--) {
    if (t === 0n) return null;
    t = fromInt(polyBig(c.a, n)) + div(fromInt(polyBig(c.b, n + 1)), t);
  }
  return t;
}

/** Coefficients of p(n + k). */
export function shiftPoly(c: number[], k: number): number[] {
  const out = new Array(c.length).fill(0);
  for (let i = 0; i < c.length; i++) {
    // c[i] (n+k)^i = c[i] Σ_j C(i,j) n^j k^(i-j)
    let binom = 1;
    for (let j = 0; j <= i; j++) {
      out[j] += c[i] * binom * k ** (i - j);
      binom = (binom * (i - j)) / (j + 1);
    }
  }
  return out;
}

/**
 * Fractions that are the same tail shifted along (a(n+k), b(n+k)) are one
 * family: their values are related by a trivial rational transformation. The
 * canonical member puts a's second-highest coefficient in [0, d·lead).
 */
export function familyKey(c: Candidate): string {
  const d = c.a.length - 1;
  const lead = c.a[d];
  const k = d >= 1 ? -Math.floor(c.a[d - 1] / (d * lead)) : 0;
  return JSON.stringify([shiftPoly(c.a, k), shiftPoly(c.b, k)]);
}

const gcd = (x: number, y: number): number => (y === 0 ? Math.abs(x) : gcd(y, x % y));

function isRational(x: number): boolean {
  for (let q = 1; q <= 300; q++) if (Math.abs(x * q - Math.round(x * q)) < 1e-9 * Math.max(1, Math.abs(x * q))) return true;
  return false;
}

/** Fast pass: integers p,q,r,s (small) with x ≈ (p + q·c)/(r + s·c). */
export function matchRelation(x: number, c: number): [number, number, number, number] | null {
  for (let r = -COEF; r <= COEF; r++) {
    for (let s = -COEF; s <= COEF; s++) {
      if (r === 0 && s === 0) continue;
      if (r < 0 || (r === 0 && s < 0)) continue; // sign normalisation
      const y = x * (r + s * c);
      for (let q = -COEF; q <= COEF; q++) {
        const p = Math.round(y - q * c);
        if (Math.abs(p) > MAX_P) continue;
        if (q === 0 && s === 0) continue; // rational
        if (p * s === q * r) continue; // degenerate: constant cancels
        if (Math.abs(y - q * c - p) < 1e-10 * Math.max(1, Math.abs(y))) {
          const g = [p, q, r, s].reduce((acc, v) => gcd(acc, v), 0) || 1;
          return [p / g, q / g, r / g, s / g];
        }
      }
    }
  }
  return null;
}

/** Full check of one candidate: double pass, then 60-digit verification. */
export function examine(c: Candidate): Discovery | null {
  const x1 = evalCF(c, 300);
  const x2 = evalCF(c, 1200);
  if (!Number.isFinite(x1) || !Number.isFinite(x2) || Math.abs(x2) > 1e6) return null;
  if (Math.abs(x1 - x2) > 1e-12 * Math.max(1, Math.abs(x2))) return null; // too slow to converge
  if (isRational(x2)) return null;
  for (const k of CONSTANTS) {
    const rel = matchRelation(x2, k.float);
    if (!rel) continue;
    const p1 = evalCFPrecise(c, 2000);
    const p2 = evalCFPrecise(c, 4000);
    if (p1 === null || p2 === null) return null;
    const converged = agreeingDigits(p1, p2);
    const [p, q, r, s] = rel;
    const lhs = mul(p2, fromInt(r) + BigInt(s) * k.value);
    const rhs = fromInt(p) + BigInt(q) * k.value;
    const digits = Math.min(converged, agreeingDigits(lhs, rhs));
    if (digits < MIN_DIGITS) continue;
    return { ...c, constant: k.name, relation: rel, value: toDecimal(p2, 30), digits };
  }
  return null;
}

// --- Human-readable formulas ---

const SUP: Record<string, string> = { "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶" };

export function polyText(c: number[]): string {
  const terms: string[] = [];
  for (let i = c.length - 1; i >= 0; i--) {
    const k = c[i];
    if (k === 0) continue;
    const mag = Math.abs(k);
    const v = i === 0 ? `${mag}` : `${mag === 1 ? "" : mag}n${i > 1 ? SUP[String(i)] ?? `^${i}` : ""}`;
    terms.push(terms.length === 0 ? (k < 0 ? `−${v}` : v) : `${k < 0 ? "−" : "+"} ${v}`);
  }
  return terms.join(" ") || "0";
}

/** The first few levels of the fraction written out: 1 + 1/(3 + 4/(5 + …)). */
export function expandedText(c: Candidate, levels = 3): string {
  const join = (head: number, num: number, tail: string) => `${head === 0 ? (num < 0 ? "−" : "") : `${head} ${num < 0 ? "−" : "+"} `}${Math.abs(num)}/(${tail})`;
  let s = "…";
  for (let n = levels; n >= 1; n--) s = join(poly(c.a, n), poly(c.b, n + 1), s);
  return join(poly(c.a, 0), poly(c.b, 1), s);
}

export function relationText(rel: [number, number, number, number], constant: string): string {
  let [p, q, r, s] = rel;
  // Prefer a positive-looking numerator: -2/(2 − π) reads better as 2/(π − 2).
  if ((p <= 0 && q <= 0) || (r <= 0 && s <= 0)) [p, q, r, s] = [-p, -q, -r, -s];
  const lin = (u: number, v: number) => {
    const cTerm = `${Math.abs(v) === 1 ? "" : Math.abs(v)}${constant}`;
    if (!v) return `${u < 0 ? "−" : ""}${Math.abs(u)}`;
    if (!u) return `${v < 0 ? "−" : ""}${cTerm}`;
    // Lead with whichever term is positive.
    if (u < 0 && v > 0) return `${cTerm} − ${-u}`;
    return `${u} ${v < 0 ? "−" : "+"} ${cTerm}`;
  };
  const num = lin(p, q);
  const den = lin(r, s);
  if (den === "1") return num;
  const wrap = (t: string) => (/^−?\d+$/.test(t) || CONSTANTS.some((k) => k.name === t) ? t : `(${t})`);
  return `${wrap(num)} / ${wrap(den)}`;
}

export function describe(d: Discovery): string {
  return `${relationText(d.relation, d.constant)} = ${expandedText(d)}   [a(n) = ${polyText(d.a)}, b(n) = ${polyText(d.b)}]`;
}

// --- The always-on runner ---

interface RunnerState {
  cursor: Cursor;
  checked: number;
  paused: boolean;
}

let state: RunnerState | null = null;
let timer: NodeJS.Timeout | null = null;
let lastSaved = 0;
let rateSample = { at: Date.now(), checked: 0 };
let perSecond = 0;
const seen = new Set<string>();
const listeners = new Set<(d: DiscoveryRow) => void>();

const valueKey = (v: string) => v.slice(0, 22);
const families = new Map<string, string>(); // family key -> value of its stored discovery

function load(): RunnerState {
  if (!state) {
    state = getMathState() ?? { cursor: { level: 0, index: 0 }, checked: 0, paused: false };
    for (const d of listDiscoveries(100_000)) {
      seen.add(valueKey(d.value));
      families.set(familyKey(d), d.value);
    }
  }
  return state!;
}

/** Runs the search for up to `budgetMs`; returns new discoveries. Exported for tests. */
export function searchSlice(budgetMs: number): DiscoveryRow[] {
  const s = load();
  const found: DiscoveryRow[] = [];
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < budgetMs && s.cursor.level < LEVELS.length) {
    const cand = candidateAt(s.cursor);
    s.cursor.index++;
    if (s.cursor.index >= levelSize(LEVELS[s.cursor.level])) s.cursor = { level: s.cursor.level + 1, index: 0 };
    count++;
    if (!cand) continue;
    const family = families.get(familyKey(cand));
    if (family) {
      // A shifted copy of a fraction already found: count it, don't re-verify.
      bumpDiscoveryVariants(family);
      continue;
    }
    const d = examine(cand);
    if (!d) continue;
    const key = valueKey(d.value);
    families.set(familyKey(cand), d.value);
    if (seen.has(key)) {
      bumpDiscoveryVariants(d.value);
      continue;
    }
    seen.add(key);
    const row = insertDiscovery({ ...d, text: describe(d) });
    found.push(row);
    for (const l of listeners) l(row);
  }
  s.checked += count;
  if (Date.now() - lastSaved > 5000) {
    saveMathState(s);
    lastSaved = Date.now();
  }
  return found;
}

/** Background loop: short slices with rests in between, so it never hogs the CPU or delays chat. */
export function startMathPilot({ sliceMs = 15, restMs = 60 } = {}) {
  if (timer || process.env.MATHPILOT === "off") return;
  const tick = () => {
    const s = load();
    if (!s.paused && s.cursor.level < LEVELS.length) searchSlice(sliceMs);
    timer = setTimeout(tick, s.paused ? 1000 : restMs);
    timer.unref();
  };
  timer = setTimeout(tick, 2000);
  timer.unref();
}

export function stopMathPilot() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (state) saveMathState(state);
}

export function setMathPaused(paused: boolean) {
  const s = load();
  s.paused = paused;
  saveMathState(s);
}

export function onDiscovery(fn: (d: DiscoveryRow) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Candidates per second of wall-clock time, measured between status checks. */
function measureRate(checked: number): number {
  const now = Date.now();
  if (now - rateSample.at >= 3000) {
    perSecond = rateSample.checked ? Math.max(0, Math.round(((checked - rateSample.checked) * 1000) / (now - rateSample.at))) : 0;
    rateSample = { at: now, checked };
  }
  return perSecond;
}

export function mathStatus() {
  const s = load();
  const level = LEVELS[Math.min(s.cursor.level, LEVELS.length - 1)];
  const finished = s.cursor.level >= LEVELS.length;
  return {
    running: Boolean(timer) && !s.paused && !finished,
    paused: s.paused,
    finished,
    enabled: process.env.MATHPILOT !== "off",
    checked: s.checked,
    perSecond: measureRate(s.checked),
    stage: finished ? LEVELS.length : s.cursor.level + 1,
    stages: LEVELS.length,
    stageProgress: finished ? 1 : s.cursor.index / levelSize(level),
    stageLabel: `a(n) degree ${level.degA}, b(n) degree ${level.degB}, coefficients ±${level.R}`,
    discoveries: countDiscoveries(),
  };
}
