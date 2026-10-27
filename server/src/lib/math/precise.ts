// Fixed-point arithmetic on BigInt for MathPilot: every constant is computed
// here from a fast-converging series (no hand-typed digits to get wrong), and
// candidate identities are re-checked at this precision before they're reported.

/** Decimal digits carried (plus guard digits) when verifying a candidate. */
export const DIGITS = 60;
const GUARD = 12;
export const SCALE = 10n ** BigInt(DIGITS + GUARD);

export type Fixed = bigint;

export const fromInt = (n: number | bigint): Fixed => BigInt(n) * SCALE;
export const mul = (a: Fixed, b: Fixed): Fixed => (a * b) / SCALE;
export const div = (a: Fixed, b: Fixed): Fixed => (a * SCALE) / b;
export const abs = (a: Fixed): Fixed => (a < 0n ? -a : a);

/** Converts to a JS number (for the fast double-precision search). */
export function toNumber(a: Fixed): number {
  const s = SCALE.toString().length - 1;
  const neg = a < 0n;
  const str = abs(a).toString().padStart(s + 1, "0");
  return (neg ? -1 : 1) * Number(`${str.slice(0, -s)}.${str.slice(-s, -s + 17)}`);
}

/** Decimal string with `places` digits after the point (truncated). */
export function toDecimal(a: Fixed, places = 30): string {
  const s = SCALE.toString().length - 1;
  const neg = a < 0n;
  const str = abs(a).toString().padStart(s + 1, "0");
  return `${neg ? "-" : ""}${str.slice(0, -s)}.${str.slice(-s, -s + places)}`;
}

/** How many decimal digits two values agree to (0..DIGITS). */
export function agreeingDigits(a: Fixed, b: Fixed): number {
  const d = abs(a - b);
  if (d === 0n) return DIGITS;
  const mag = abs(a) > SCALE ? abs(a) : SCALE; // relative for |a| > 1
  const ratio = (mag * 10n ** 4n) / d; // > 0
  const digits = ratio.toString().length - 1 - 4;
  return Math.max(0, Math.min(DIGITS, digits));
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n)))) || 1n;
  // Newton from a float seed; converge exactly.
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x && y - x <= 1n) {
      while (x * x > n) x -= 1n;
      while ((x + 1n) * (x + 1n) <= n) x += 1n;
      return x;
    }
    x = y;
  }
}

export const sqrt = (a: Fixed): Fixed => isqrt(a * SCALE);

/** atan(1/x) for integer x: Σ (-1)^k / ((2k+1) x^(2k+1)). */
function atanInv(x: bigint): Fixed {
  let term = SCALE / x;
  const x2 = x * x;
  let sum = 0n;
  for (let k = 0n; term !== 0n; k++) {
    sum += (k % 2n === 0n ? 1n : -1n) * (term / (2n * k + 1n));
    term /= x2;
  }
  return sum;
}

/** atanh(y) for fixed-point |y| < 1: Σ y^(2k+1)/(2k+1). */
function atanh(y: Fixed): Fixed {
  const y2 = mul(y, y);
  let power = y;
  let sum = 0n;
  for (let k = 0n; power !== 0n; k++) {
    sum += power / (2n * k + 1n);
    power = mul(power, y2);
  }
  return sum;
}

const ln = (x: Fixed): Fixed => 2n * atanh(div(x - SCALE, x + SCALE));

function computeConstants() {
  const pi = 16n * atanInv(5n) - 4n * atanInv(239n);

  let e = 0n;
  for (let term = SCALE, k = 1n; term !== 0n; k++) {
    e += term;
    term /= k;
  }

  // ln 2 = Σ 1/(k·2^k)
  let ln2 = 0n;
  for (let k = 1n, p = SCALE / 2n; p !== 0n; k++, p /= 2n) ln2 += p / k;

  // Apéry: ζ(3) = 5/2 Σ (-1)^(k-1) / (k³ C(2k,k))
  let zeta3 = 0n;
  let binom = 1n; // C(2k,k)
  for (let k = 1n; ; k++) {
    binom = (binom * (2n * k) * (2n * k - 1n)) / (k * k);
    const term = SCALE / (k * k * k * binom);
    if (term === 0n) break;
    zeta3 += k % 2n === 1n ? term : -term;
  }
  zeta3 = (zeta3 * 5n) / 2n;

  // Catalan (Ramanujan): G = π/8·ln(2+√3) + 3/8 Σ (k!)² / ((2k)! (2k+1)²)
  const sqrt3 = sqrt(fromInt(3));
  let series = 0n;
  let ratio = SCALE; // (k!)²/(2k)!
  for (let k = 0n; ratio !== 0n; k++) {
    series += ratio / ((2n * k + 1n) * (2n * k + 1n));
    ratio = (ratio * (k + 1n)) / (2n * (2n * k + 1n));
  }
  const catalan = mul(pi, ln(fromInt(2) + sqrt3)) / 8n + (3n * series) / 8n;

  const sqrt2 = sqrt(fromInt(2));
  const phi = (SCALE + sqrt(fromInt(5))) / 2n;

  return { pi, e, ln2, zeta3, catalan, sqrt2, phi, pi2: mul(pi, pi) };
}

export const C = computeConstants();

/** The constants MathPilot searches for, with display names. */
export const CONSTANTS: { key: keyof typeof C; name: string; fullName: string; value: Fixed; float: number }[] = (
  [
    ["pi", "π", "pi"],
    ["e", "e", "Euler's number e"],
    ["ln2", "ln2", "the natural log of 2"],
    ["zeta3", "ζ(3)", "Apéry's constant ζ(3)"],
    ["catalan", "G", "Catalan's constant G"],
    ["sqrt2", "√2", "the square root of 2"],
    ["phi", "φ", "the golden ratio φ"],
    ["pi2", "π²", "pi squared"],
  ] as const
).map(([key, name, fullName]) => ({ key, name, fullName, value: C[key], float: toNumber(C[key]) }));
