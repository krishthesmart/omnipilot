// Mental-math tricks for MathPilot. Each trick knows when it applies to the numbers in a request,
// works the example step by step, and is checked against exact arithmetic, so a trick is never
// shown with a wrong answer. No model involved.

export interface Trick {
  id: string;
  name: string;
  /** How the trick works, in general. */
  how: string;
  /** A worked example with fixed numbers. */
  example: string;
  /** The trick applied to the user's numbers, or null if it doesn't fit them. */
  apply(a: number, b: number | null): { steps: string[]; answer: number } | null;
  /** Words that name this trick ("by 11", "squaring", "divisible"). */
  names: RegExp;
}

const digits = (n: number) => String(n).split("").map(Number);
const isInt = (n: number) => Number.isInteger(n) && n >= 0;

export const TRICKS: Trick[] = [
  {
    id: "times11",
    name: "Multiply a two-digit number by 11",
    how: "Split the digits apart and put their sum in the middle. If the sum is 10 or more, carry the 1 to the first digit.",
    example: "34 × 11: 3 _ 4, and 3 + 4 = 7 goes in the middle: 374.",
    names: /\b(by|times|x|×)\s*11\b|\b11\s*(×|x|times)/i,
    apply(a, b) {
      const n = b === 11 ? a : a === 11 ? b : null;
      if (n === null || !isInt(n) || n < 10 || n > 99) return null;
      const [x, y] = digits(n);
      const mid = x + y;
      const answer = n * 11;
      return {
        steps: [`Split ${n} into ${x} and ${y}.`, `Add them: ${x} + ${y} = ${mid}.`, mid < 10 ? `Put ${mid} in the middle: ${x}${mid}${y}.` : `${mid} is 10 or more, so write ${mid % 10} in the middle and carry 1 onto the ${x}: ${x + 1}${mid % 10}${y}.`],
        answer,
      };
    },
  },
  {
    id: "square5",
    name: "Square a number ending in 5",
    how: "Take the digits before the 5, multiply them by the next number up, then write 25 after it.",
    example: "65²: 6 × 7 = 42, then 25: 4225.",
    names: /\bend(s|ing)? in (a )?5\b|\bsquar(e|ing)\b[^.?!]*\b5\b/i,
    apply(a, b) {
      if ((b !== null && b !== a && b !== 2) || !isInt(a) || a % 10 !== 5 || a < 15 || a > 995) return null;
      const t = (a - 5) / 10;
      return { steps: [`Drop the 5: ${t}.`, `Multiply by the next number up: ${t} × ${t + 1} = ${t * (t + 1)}.`, `Write 25 after it: ${t * (t + 1)}25.`], answer: a * a };
    },
  },
  {
    id: "nearRound",
    name: "Multiply two numbers the same distance from a round number",
    how: "If the numbers are r − d and r + d, the product is r² − d² (difference of squares).",
    example: "48 × 52 = (50 − 2)(50 + 2) = 2500 − 4 = 2496.",
    names: /\bdifference of squares\b|\bsame distance\b/i,
    apply(a, b) {
      if (b === null || !isInt(a) || !isInt(b) || a === b || (a + b) % 2 !== 0) return null;
      const r = (a + b) / 2;
      const d = Math.abs(a - b) / 2;
      if (r % 10 !== 0 || d > 9) return null;
      return { steps: [`Both are ${d} away from ${r}: ${Math.min(a, b)} = ${r} − ${d} and ${Math.max(a, b)} = ${r} + ${d}.`, `${r}² = ${r * r} and ${d}² = ${d * d}.`, `${r * r} − ${d * d} = ${r * r - d * d}.`], answer: a * b };
    },
  },
  {
    id: "near100",
    name: "Multiply two numbers just under 100",
    how: "Find how far each is below 100. Subtract one distance from the other number for the first two digits; multiply the distances for the last two.",
    example: "97 × 96: 3 and 4 below 100. 97 − 4 = 93, 3 × 4 = 12: 9312.",
    names: /\bnear 100\b|\bclose to 100\b|\bunder 100\b/i,
    apply(a, b) {
      if (b === null || !isInt(a) || !isInt(b) || a < 90 || b < 90 || a > 99 || b > 99) return null;
      const da = 100 - a;
      const db = 100 - b;
      const front = a - db;
      return { steps: [`${a} is ${da} below 100 and ${b} is ${db} below 100.`, `${a} − ${db} = ${front} (the first part).`, `${da} × ${db} = ${da * db} (the last two digits): ${front}${String(da * db).padStart(2, "0")}.`], answer: a * b };
    },
  },
  {
    id: "times5",
    name: "Multiply by 5",
    how: "Multiply by 10, then halve it (5 is half of 10).",
    example: "68 × 5: 680 ÷ 2 = 340.",
    names: /\b(by|times|x|×)\s*5\b(?!\d)/i,
    apply(a, b) {
      const n = b === 5 ? a : a === 5 ? b : null;
      if (n === null || !isInt(n) || n < 10) return null;
      return { steps: [`${n} × 10 = ${n * 10}.`, `Halve it: ${n * 10} ÷ 2 = ${n * 5}.`], answer: n * 5 };
    },
  },
  {
    id: "times9",
    name: "Multiply by 9",
    how: "Multiply by 10, then subtract the number once (9 is one less than 10).",
    example: "47 × 9: 470 − 47 = 423.",
    names: /\b(by|times|x|×)\s*9\b(?!\d)/i,
    apply(a, b) {
      const n = b === 9 ? a : a === 9 ? b : null;
      if (n === null || !isInt(n) || n < 10) return null;
      return { steps: [`${n} × 10 = ${n * 10}.`, `Subtract ${n}: ${n * 10} − ${n} = ${n * 9}.`], answer: n * 9 };
    },
  },
  {
    id: "times25",
    name: "Multiply by 25",
    how: "Multiply by 100, then divide by 4 (25 is a quarter of 100).",
    example: "36 × 25: 3600 ÷ 4 = 900.",
    names: /\b(by|times|x|×)\s*25\b/i,
    apply(a, b) {
      const n = b === 25 ? a : a === 25 ? b : null;
      if (n === null || !isInt(n) || n < 4) return null;
      return { steps: [`${n} × 100 = ${n * 100}.`, `Divide by 4: ${n * 100} ÷ 4 = ${n * 25}.`], answer: n * 25 };
    },
  },
  {
    id: "halveDouble",
    name: "Halve one number and double the other",
    how: "The product doesn't change if you halve one factor and double the other. Keep going until it's easy.",
    example: "16 × 35 = 8 × 70 = 560.",
    names: /\bhalv(e|ing)\b|\bdoubl(e|ing)\b/i,
    apply(a, b) {
      if (b === null || !isInt(a) || !isInt(b)) return null;
      let [x, y] = a % 2 === 0 ? [a, b] : [b, a];
      if (x % 2 !== 0 || y % 5 !== 0 || x < 4) return null;
      const steps: string[] = [];
      while (x % 2 === 0 && y % 10 !== 0 && steps.length < 4) {
        steps.push(`Halve ${x} and double ${y}: ${x / 2} × ${y * 2}.`);
        x /= 2;
        y *= 2;
      }
      if (steps.length === 0) return null;
      steps.push(`${x} × ${y} = ${x * y}.`);
      return { steps, answer: a * b };
    },
  },
  {
    id: "percentSwap",
    name: "Swap a percentage",
    how: "x% of y is the same as y% of x, so pick whichever is easier.",
    example: "8% of 50 = 50% of 8 = 4.",
    names: /\bpercent(age)?\b|%/i,
    apply(a, b) {
      if (b === null || !isInt(a) || !isInt(b) || a === b) return null;
      const easy = [10, 20, 25, 50, 100, 200];
      if (!easy.includes(b) || easy.includes(a)) return null;
      return { steps: [`${a}% of ${b} is the same as ${b}% of ${a}.`, `${b}% of ${a} = ${(b * a) / 100}.`], answer: (a * b) / 100 };
    },
  },
  {
    id: "from1000",
    name: "Subtract from 1000",
    how: "Take every digit from 9, except the last one, which you take from 10.",
    example: "1000 − 372: 9−3, 9−7, 10−2 → 628.",
    names: /\b1000\s*(−|-|minus)\b|\bsubtract(ing)? from 1000\b/i,
    apply(a, b) {
      if (a !== 1000 || b === null || !isInt(b) || b < 100 || b > 999 || b % 10 === 0) return null;
      const [x, y, z] = digits(b);
      return { steps: [`9 − ${x} = ${9 - x}, 9 − ${y} = ${9 - y}, 10 − ${z} = ${10 - z}.`, `Together: ${9 - x}${9 - y}${10 - z}.`], answer: 1000 - b };
    },
  },
];

const DIVISIBILITY = [
  "**By 2:** the last digit is even.",
  "**By 3:** the digits add up to a multiple of 3 (372: 3 + 7 + 2 = 12, so yes).",
  "**By 4:** the last two digits make a multiple of 4 (1,316: 16, so yes).",
  "**By 5:** it ends in 0 or 5.",
  "**By 6:** it passes the tests for 2 and for 3.",
  "**By 9:** the digits add up to a multiple of 9.",
  "**By 10:** it ends in 0.",
  "**By 11:** alternately add and subtract the digits; the result is a multiple of 11 (918,082: 9−1+8−0+8−2 = 22, so yes).",
];

/** "34 × 11", "65 squared", "97 times 96", "8% of 50", "1000 - 372". */
export function numbersIn(text: string): { a: number; b: number | null } | null {
  const t = text.replace(/,(?=\d{3})/g, "");
  const sq = /(\d+(?:\.\d+)?)\s*(?:²|\^2|squared)/i.exec(t) ?? /\bsquare (?:of )?(\d+)/i.exec(t);
  if (sq) return { a: Number(sq[1]), b: Number(sq[1]) };
  const pct = /(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/i.exec(t);
  if (pct) return { a: Number(pct[1]), b: Number(pct[2]) };
  const mult = /\bmultiply(?:ing)?\s+(\d+(?:\.\d+)?)\s+(?:by|and|with)\s+(\d+(?:\.\d+)?)/i.exec(t);
  if (mult) return { a: Number(mult[1]), b: Number(mult[2]) };
  const op = /(\d+(?:\.\d+)?)\s*(?:×|x|\*|times|multiplied by|−|-|minus)\s*(\d+(?:\.\d+)?)/i.exec(t);
  if (op) return { a: Number(op[1]), b: Number(op[2]) };
  return null;
}

/** Tricks named in the text ("trick for multiplying by 11"). */
export const tricksNamed = (text: string) => TRICKS.filter((t) => t.names.test(text));

export const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : String(Math.round(n * 1e6) / 1e6));

/** The best trick for these numbers, applied and checked, or null. */
export function applyTrick(text: string): { trick: Trick; steps: string[]; answer: number } | null {
  const nums = numbersIn(text);
  if (!nums) return null;
  const named = tricksNamed(text);
  const order = [...named, ...TRICKS.filter((t) => !named.includes(t))];
  const isSubtraction = /(−|-|minus)/.test(text) && nums.a === 1000;
  for (const trick of order) {
    if (isSubtraction !== (trick.id === "from1000")) continue;
    const r = trick.apply(nums.a, nums.b);
    if (!r) continue;
    // Exact check: never show a trick with a wrong answer.
    const exact = trick.id === "from1000" ? nums.a - (nums.b ?? 0) : trick.id === "percentSwap" ? (nums.a * (nums.b ?? 0)) / 100 : nums.a * (nums.b ?? nums.a);
    if (Math.abs(r.answer - exact) > 1e-9) continue;
    return { trick, ...r };
  }
  return null;
}

export function divisibilityText(): string {
  return `**Divisibility tricks**\n${DIVISIBILITY.map((d) => `- ${d}`).join("\n")}`;
}

export function trickCard(t: Trick): string {
  return `**${t.name}**\n${t.how}\n\nExample: ${t.example}`;
}
