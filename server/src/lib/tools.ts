import { evaluate, parse } from "./math/expr.js";
import { formatNumber } from "./math/pal.js";

// Exact answers for the questions small language models are famously bad at:
// counting letters, comparing decimals, primes, percentages, unit conversions,
// dates. A small (3 GB or less) model can't beat a big one at these by "thinking harder",
// but a few lines of code beat every model. Each tool either answers exactly or
// returns null and lets the model handle the question.

export interface ToolAnswer {
  tool: string;
  answer: string;
}

type Tool = (text: string, now: Date) => ToolAnswer | null;

const clean = (s: string) => s.trim().replace(/[?!.]+$/, "").trim();
const quoted = (s: string) => /["“'‘]([^"”'’]+)["”'’]/.exec(s)?.[1];
const n = (x: number) => formatNumber(x);

// --- Letters, words, text ---

const letterCount: Tool = (text) => {
  const m =
    /how many (?:times does (?:the letter )?)?["'‘“]?([a-z])["'’”]?(?:'s|s)?\b(?: (?:letters?|are|appear|occur|is))*(?: there)? in (?:the word )?["'‘“]?([a-z][a-z'\- ]*?)["'’”]?(?: appear| occur)?\s*$/i.exec(clean(text)) ??
    /count (?:the )?(?:letter )?["'‘“]?([a-z])["'’”]?(?:'s|s)? in (?:the word )?["'‘“]?([a-z][a-z'\- ]*?)["'’”]?\s*$/i.exec(clean(text));
  if (!m) return null;
  const [letter, word] = [m[1].toLowerCase(), m[2].trim()];
  const count = [...word.toLowerCase()].filter((c) => c === letter).length;
  const marked = word.replace(new RegExp(`(${letter}+)`, "gi"), "**$1**");
  return { tool: "letter count", answer: `There ${count === 1 ? "is" : "are"} **${count}** "${letter}"${count === 1 ? "" : "s"} in "${word}": ${marked}` };
};

const textStats: Tool = (text) => {
  const m = /how many (letters|characters|words|vowels|consonants) (?:are )?(?:there )?in (.+)$/i.exec(clean(text));
  if (!m) return null;
  const target = quoted(m[2]) ?? m[2].replace(/^(the word|the sentence|the phrase)\s+/i, "").trim();
  if (!target || target.length > 500) return null;
  const kind = m[1].toLowerCase();
  const letters = [...target].filter((c) => /\p{L}/u.test(c));
  const value =
    kind === "words" ? target.split(/\s+/).filter(Boolean).length
    : kind === "characters" ? [...target].length
    : kind === "vowels" ? letters.filter((c) => /[aeiou]/i.test(c)).length
    : kind === "consonants" ? letters.filter((c) => /[a-z]/i.test(c) && !/[aeiou]/i.test(c)).length
    : letters.length;
  return { tool: "text count", answer: `"${target}" has **${value}** ${kind}${kind === "characters" ? " (including spaces)" : ""}.` };
};

const reverseText: Tool = (text) => {
  const m = /^(?:reverse|spell)\s+(?:the word\s+)?(.+?)(?:\s+backwards?)?$/i.exec(clean(text)) ?? /^(?:what is|what's)\s+(.+?)\s+(?:spelled\s+)?backwards?$/i.exec(clean(text));
  if (!m || (!/^reverse/i.test(text) && !/backwards?/i.test(text))) return null;
  const target = quoted(m[1]) ?? m[1].replace(/^["']|["']$/g, "");
  if (!target || target.length > 300) return null;
  return { tool: "reverse", answer: `"${target}" backwards is **${[...target].reverse().join("")}**.` };
};

// --- Numbers ---

const NUM = String.raw`-?\d+(?:,\d{3})*(?:\.\d+)?`;
const num = (s: string) => Number(s.replace(/,/g, ""));

const compareNumbers: Tool = (text) => {
  const m = new RegExp(String.raw`(?:which is|what is|what's)\s+(bigger|larger|greater|smaller|less|higher|lower)[:,]?\s*(${NUM})\s+or\s+(${NUM})`, "i").exec(text) ??
    new RegExp(String.raw`^is\s+(${NUM})\s+(bigger|larger|greater|smaller|less|more|higher|lower)\s+than\s+(${NUM})`, "i").exec(clean(text));
  if (!m) return null;
  if (/^is/i.test(clean(text))) {
    const [a, word, b] = [num(m[1]), m[2].toLowerCase(), num(m[3])];
    const wantBigger = /bigger|larger|greater|more|higher/.test(word);
    const yes = wantBigger ? a > b : a < b;
    return { tool: "compare", answer: `${yes ? "**Yes**" : "**No**"}: ${m[1]} is ${a === b ? "equal to" : a > b ? "bigger than" : "smaller than"} ${m[3]}.` };
  }
  const [word, a, b] = [m[1].toLowerCase(), num(m[2]), num(m[3])];
  if (a === b) return { tool: "compare", answer: `They're equal: ${m[2]} = ${m[3]}.` };
  const wantBigger = /bigger|larger|greater|higher/.test(word);
  const pick = (wantBigger ? a > b : a < b) ? m[2] : m[3];
  return { tool: "compare", answer: `**${pick}** is ${wantBigger ? "bigger" : "smaller"}${/\.\d/.test(m[2] + m[3]) ? ` (compare place by place: ${m[2]} vs ${m[3]})` : ""}.` };
};

const sortNumbers: Tool = (text) => {
  const m = /^(?:sort|order|arrange)\b[^:\d-]*?(descending|largest to smallest|biggest to smallest|high to low|ascending|smallest to largest|low to high)?[^:\d-]*:?\s*((?:-?\d[\d.,]*\s*(?:,|and|\s)\s*)+-?\d[\d.]*)\s*(?:from |in )?(descending|largest to smallest|biggest to smallest|high to low|ascending|smallest to largest|low to high)?(?: order)?$/i.exec(clean(text));
  if (!m) return null;
  const values = m[2].split(/\s*(?:,(?!\d{3}\b)|\band\b|\s)\s*/).filter(Boolean).map(Number);
  if (values.length < 2 || values.some((v) => !Number.isFinite(v))) return null;
  const desc = /desc|largest to|biggest to|high(est)? to/i.test(text);
  const sorted = [...values].sort((a, b) => (desc ? b - a : a - b));
  return { tool: "sort", answer: `${desc ? "Largest to smallest" : "Smallest to largest"}: **${sorted.join(", ")}**` };
};

function factorize(x: number): number[] {
  const out: number[] = [];
  for (let p = 2; p * p <= x; p++) while (x % p === 0) out.push(p), (x /= p);
  if (x > 1) out.push(x);
  return out;
}

const primes: Tool = (text) => {
  const t = clean(text);
  const isPrime = /^is\s+(\d[\d,]*)\s+(?:a\s+)?prime(?:\s+number)?$/i.exec(t);
  if (isPrime) {
    const x = num(isPrime[1]);
    if (!Number.isSafeInteger(x) || x > 1e15) return null;
    if (x < 2) return { tool: "prime check", answer: `**No**: ${x} isn't prime (primes start at 2).` };
    const f = factorize(x);
    return f.length === 1
      ? { tool: "prime check", answer: `**Yes**, ${x} is prime.` }
      : { tool: "prime check", answer: `**No**, ${x} isn't prime: ${x} = ${f.join(" × ")}.` };
  }
  const fact = /(?:prime factors?|prime factori[sz]ation|factori[sz]e)\s+(?:of\s+)?(\d[\d,]*)/i.exec(t);
  if (fact) {
    const x = num(fact[1]);
    if (!Number.isSafeInteger(x) || x < 2 || x > 1e15) return null;
    return { tool: "prime factors", answer: `${x} = **${factorize(x).join(" × ")}**` };
  }
  const nth = /(?:what is |what's )?the\s+(\d+)(?:st|nd|rd|th)\s+prime(?:\s+number)?$/i.exec(t);
  if (nth) {
    const k = Number(nth[1]);
    if (k < 1 || k > 100_000) return null;
    let count = 0;
    for (let c = 2; ; c++) if (factorize(c).length === 1 && ++count === k) return { tool: "nth prime", answer: `The ${nth[1]}${nth[0].match(/(st|nd|rd|th)/i)?.[1]} prime is **${c}**.` };
  }
  return null;
};

const gcdLcm: Tool = (text) => {
  const m = /(gcd|gcf|hcf|greatest common (?:divisor|factor)|highest common factor|lcm|least common multiple|lowest common multiple)\s+(?:of\s+)?([\d,\s]+(?:and\s+\d+)?)$/i.exec(clean(text));
  if (!m) return null;
  const values = m[2].split(/[\s,]+|and/).filter(Boolean).map(Number);
  if (values.length < 2 || values.some((v) => !Number.isSafeInteger(v) || v <= 0)) return null;
  const g2 = (a: number, b: number): number => (b ? g2(b, a % b) : a);
  const isGcd = /gcd|gcf|hcf|greatest|highest/i.test(m[1]);
  const value = isGcd ? values.reduce(g2) : values.reduce((a, b) => (a / g2(a, b)) * b);
  return { tool: isGcd ? "gcd" : "lcm", answer: `The ${isGcd ? "greatest common divisor" : "least common multiple"} of ${values.join(", ")} is **${value}**.` };
};

const percentages: Tool = (text) => {
  const t = clean(text).replace(/\$/g, "");
  let m = new RegExp(String.raw`(?:what is |what's |calculate )?(${NUM})\s*(?:%|percent)\s+of\s+(${NUM})`, "i").exec(t);
  if (m) return { tool: "percent", answer: `${m[1]}% of ${m[2]} is **${n((num(m[1]) / 100) * num(m[2]))}**.` };
  m = new RegExp(String.raw`what (?:percent|percentage) (?:of (${NUM}) is (${NUM})|is (${NUM}) of (${NUM}))`, "i").exec(t);
  if (m) {
    const [part, whole] = m[1] ? [num(m[2]), num(m[1])] : [num(m[3]), num(m[4])];
    return { tool: "percent", answer: `${n(part)} is **${n((part / whole) * 100)}%** of ${n(whole)}.` };
  }
  m = new RegExp(String.raw`(increase|raise|decrease|reduce|discount)\s+(${NUM})\s+by\s+(${NUM})\s*(?:%|percent)`, "i").exec(t);
  if (m) {
    const up = /increase|raise/i.test(m[1]);
    const value = num(m[2]) * (1 + ((up ? 1 : -1) * num(m[3])) / 100);
    return { tool: "percent", answer: `${m[2]} ${up ? "increased" : "decreased"} by ${m[3]}% is **${n(value)}**.` };
  }
  m = new RegExp(String.raw`(${NUM})\s*(?:%|percent)\s+tip\s+(?:on|for)\s+(?:a\s+)?(${NUM})`, "i").exec(t);
  if (m) {
    const tip = (num(m[1]) / 100) * num(m[2]);
    return { tool: "percent", answer: `A ${m[1]}% tip on ${m[2]} is **${n(Math.round(tip * 100) / 100)}**, for a total of ${n(Math.round((num(m[2]) + tip) * 100) / 100)}.` };
  }
  return null;
};

const WORD_OPS: [RegExp, string][] = [
  [/\bmultiplied by\b|\btimes\b/gi, "*"],
  [/\bdivided by\b|\bover\b/gi, "/"],
  [/\bplus\b|\badded to\b/gi, "+"],
  [/\bminus\b/gi, "-"],
  [/\bto the power of\b|\braised to\b/gi, "^"],
  [/\bsquared\b/gi, "^2"],
  [/\bcubed\b/gi, "^3"],
  [/\b(?:the )?square root of\b/gi, "sqrt"],
  [/\bx\b/g, "*"],
];

const calculator: Tool = (text) => {
  let t = clean(text).replace(/^(?:what is|what's|whats|calculate|compute|evaluate|solve|how much is)\s+/i, "").replace(/\s*=\s*$/, "");
  for (const [re, op] of WORD_OPS) t = t.replace(re, ` ${op} `);
  t = t.replace(/(\d),(?=\d{3}\b)/g, "$1");
  // Only plain math: digits, operators and known function names, with at least one operator.
  if (!/^[\d\s.+\-*/^()!%×÷√πe]+$|^[\d\s.+\-*/^()!×÷√π]*(sqrt|sin|cos|tan|ln|log|abs|round|floor|ceil)[\d\s.+\-*/^()!×÷√π a-z]*$/i.test(t)) return null;
  if (!/[+\-*/^!×÷√]|sqrt|sin|cos|tan|ln|log|abs|round|floor|ceil/.test(t) || !/\d/.test(t)) return null;
  t = t.replace(/(\d+(?:\.\d+)?)\s*%/g, "($1/100)");
  try {
    const value = evaluate(parse(t), {});
    if (!Number.isFinite(value)) return null;
    return { tool: "calculator", answer: `${t.replace(/\s+/g, " ").trim()} = **${n(value)}**` };
  } catch {
    return null;
  }
};

// --- Units ---

type Dim = "length" | "mass" | "volume" | "time" | "speed" | "data" | "area" | "temperature";
const UNITS: { names: string[]; dim: Dim; factor: number; label: string }[] = [
  // length (metres)
  { names: ["mm", "millimeter", "millimetre"], dim: "length", factor: 0.001, label: "mm" },
  { names: ["cm", "centimeter", "centimetre"], dim: "length", factor: 0.01, label: "cm" },
  { names: ["m", "meter", "metre"], dim: "length", factor: 1, label: "m" },
  { names: ["km", "kilometer", "kilometre"], dim: "length", factor: 1000, label: "km" },
  { names: ["in", "inch", "inche"], dim: "length", factor: 0.0254, label: "in" },
  { names: ["ft", "foot", "feet"], dim: "length", factor: 0.3048, label: "ft" },
  { names: ["yd", "yard"], dim: "length", factor: 0.9144, label: "yd" },
  { names: ["mi", "mile"], dim: "length", factor: 1609.344, label: "mi" },
  { names: ["nautical mile", "nmi"], dim: "length", factor: 1852, label: "nautical mi" },
  // mass (kg)
  { names: ["mg", "milligram"], dim: "mass", factor: 1e-6, label: "mg" },
  { names: ["g", "gram"], dim: "mass", factor: 0.001, label: "g" },
  { names: ["kg", "kilogram", "kilo"], dim: "mass", factor: 1, label: "kg" },
  { names: ["oz", "ounce"], dim: "mass", factor: 0.028349523125, label: "oz" },
  { names: ["lb", "lbs", "pound"], dim: "mass", factor: 0.45359237, label: "lb" },
  { names: ["st", "stone"], dim: "mass", factor: 6.35029318, label: "st" },
  { names: ["ton", "tonne", "metric ton"], dim: "mass", factor: 1000, label: "t" },
  // volume (litres)
  { names: ["ml", "milliliter", "millilitre"], dim: "volume", factor: 0.001, label: "mL" },
  { names: ["l", "liter", "litre"], dim: "volume", factor: 1, label: "L" },
  { names: ["tsp", "teaspoon"], dim: "volume", factor: 0.00492892159375, label: "tsp" },
  { names: ["tbsp", "tablespoon"], dim: "volume", factor: 0.01478676478125, label: "tbsp" },
  { names: ["fl oz", "fluid ounce"], dim: "volume", factor: 0.0295735295625, label: "fl oz" },
  { names: ["cup"], dim: "volume", factor: 0.2365882365, label: "cups" },
  { names: ["pint", "pt"], dim: "volume", factor: 0.473176473, label: "pt" },
  { names: ["quart", "qt"], dim: "volume", factor: 0.946352946, label: "qt" },
  { names: ["gallon", "gal"], dim: "volume", factor: 3.785411784, label: "gal" },
  // time (seconds)
  { names: ["ms", "millisecond"], dim: "time", factor: 0.001, label: "ms" },
  { names: ["s", "sec", "second"], dim: "time", factor: 1, label: "s" },
  { names: ["min", "minute"], dim: "time", factor: 60, label: "min" },
  { names: ["h", "hr", "hour"], dim: "time", factor: 3600, label: "h" },
  { names: ["day"], dim: "time", factor: 86400, label: "days" },
  { names: ["week", "wk"], dim: "time", factor: 604800, label: "weeks" },
  { names: ["year", "yr"], dim: "time", factor: 31557600, label: "years" },
  // speed (m/s)
  { names: ["m/s", "meters per second", "metres per second"], dim: "speed", factor: 1, label: "m/s" },
  { names: ["km/h", "kph", "kmh", "kilometers per hour", "kilometres per hour"], dim: "speed", factor: 1000 / 3600, label: "km/h" },
  { names: ["mph", "miles per hour"], dim: "speed", factor: 1609.344 / 3600, label: "mph" },
  { names: ["knot", "kn"], dim: "speed", factor: 1852 / 3600, label: "knots" },
  // data (bytes)
  { names: ["byte", "b"], dim: "data", factor: 1, label: "bytes" },
  { names: ["kb", "kilobyte"], dim: "data", factor: 1e3, label: "KB" },
  { names: ["mb", "megabyte"], dim: "data", factor: 1e6, label: "MB" },
  { names: ["gb", "gigabyte"], dim: "data", factor: 1e9, label: "GB" },
  { names: ["tb", "terabyte"], dim: "data", factor: 1e12, label: "TB" },
  { names: ["kib", "kibibyte"], dim: "data", factor: 1024, label: "KiB" },
  { names: ["mib", "mebibyte"], dim: "data", factor: 1024 ** 2, label: "MiB" },
  { names: ["gib", "gibibyte"], dim: "data", factor: 1024 ** 3, label: "GiB" },
  // area (m²)
  { names: ["m2", "m²", "square meter", "square metre", "sq m"], dim: "area", factor: 1, label: "m²" },
  { names: ["km2", "km²", "square kilometer", "square kilometre", "sq km"], dim: "area", factor: 1e6, label: "km²" },
  { names: ["ft2", "ft²", "square foot", "square feet", "sq ft"], dim: "area", factor: 0.09290304, label: "sq ft" },
  { names: ["acre"], dim: "area", factor: 4046.8564224, label: "acres" },
  { names: ["hectare", "ha"], dim: "area", factor: 10000, label: "hectares" },
  { names: ["sq mi", "square mile"], dim: "area", factor: 2589988.110336, label: "sq mi" },
  // temperature (handled specially)
  { names: ["c", "°c", "celsius", "centigrade", "degrees celsius", "degree celsius"], dim: "temperature", factor: 0, label: "°C" },
  { names: ["f", "°f", "fahrenheit", "degrees fahrenheit", "degree fahrenheit"], dim: "temperature", factor: 0, label: "°F" },
  { names: ["k", "kelvin"], dim: "temperature", factor: 0, label: "K" },
];

function findUnit(raw: string) {
  const s = raw.trim().toLowerCase().replace(/\.$/, "");
  const singular = s.replace(/(?<=[a-z]{3})s$/, "").replace(/(?<=inch)es$/, "").replace(/^degrees? /, (d) => (/celsius|fahrenheit/.test(s) ? d : ""));
  return UNITS.find((u) => u.names.includes(s) || u.names.includes(singular));
}

function convertTemperature(v: number, from: string, to: string): number {
  const c = from === "°C" ? v : from === "°F" ? ((v - 32) * 5) / 9 : v - 273.15;
  return to === "°C" ? c : to === "°F" ? (c * 9) / 5 + 32 : c + 273.15;
}

const units: Tool = (text) => {
  const t = clean(text).replace(/,(?=\d{3}\b)/g, "");
  const m =
    /(?:convert\s+)?(-?\d+(?:\.\d+)?)\s*([a-z°²/ ]+?)\s+(?:to|in|into|as)\s+([a-z°²/ ]+?)$/i.exec(t.replace(/^(?:what is|what's|how much is|how many)\s+/i, "")) ??
    /how many\s+([a-z°²/ ]+?)\s+(?:are\s+)?(?:there\s+)?in\s+(?:an?|one|(\d+(?:\.\d+)?))\s+([a-z°²/ ]+?)$/i.exec(t);
  if (!m) return null;
  let value: number, from, to;
  if (/^how many/i.test(t) && m.length === 4 && isNaN(Number(m[1]))) {
    value = m[2] ? Number(m[2]) : 1;
    from = findUnit(m[3]);
    to = findUnit(m[1]);
  } else {
    value = Number(m[1]);
    from = findUnit(m[2]);
    to = findUnit(m[3]);
  }
  if (!from || !to || from.dim !== to.dim || !Number.isFinite(value)) return null;
  const result = from.dim === "temperature" ? convertTemperature(value, from.label, to.label) : (value * from.factor) / to.factor;
  const shown = Math.abs(result) >= 0.01 || result === 0 ? Math.round(result * 1e4) / 1e4 : Number(result.toPrecision(4));
  const label = (u: { label: string }, v: number) => (v === 1 && /^(days|weeks|years|cups|acres|hectares|knots|bytes)$/.test(u.label) ? u.label.slice(0, -1) : u.label);
  return { tool: "unit conversion", answer: `${n(value)} ${label(from, value)} = **${n(shown)} ${label(to, shown)}**` };
};

// --- Dates ---

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HOLIDAYS: Record<string, [number, number]> = { christmas: [11, 25], "christmas day": [11, 25], "new year": [0, 1], "new year's day": [0, 1], "new years day": [0, 1], halloween: [9, 31], "valentine's day": [1, 14], "valentines day": [1, 14], "independence day": [6, 4] };

const utcDate = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(2000, m, d));
  date.setUTCFullYear(y); // years before 100 aren't mapped to 19xx
  return date;
};
const today = (now: Date) => utcDate(now.getFullYear(), now.getMonth(), now.getDate());
const fmtDate = (d: Date) => `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()][0].toUpperCase()}${MONTHS[d.getUTCMonth()].slice(1)} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
const dayDiff = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

/** Parses "July 4, 1776", "4 July 1776", "2026-12-25", "12/25/2026", "christmas", "today", "tomorrow"; month+day without a year means the next one. */
export function parseDate(raw: string, now: Date): Date | null {
  const s = raw.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/,/g, " ").replace(/\s+/g, " ").replace(/^the /, "");
  const base = today(now);
  if (s === "today" || s === "now") return base;
  if (s === "tomorrow") return utcDate(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + 1);
  if (s === "yesterday") return utcDate(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - 1);
  const nextOccurrence = (m: number, d: number) => {
    const thisYear = utcDate(base.getUTCFullYear(), m, d);
    return thisYear < base ? utcDate(base.getUTCFullYear() + 1, m, d) : thisYear;
  };
  const holiday = HOLIDAYS[s.replace(/^next /, "")];
  if (holiday) return nextOccurrence(...holiday);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return utcDate(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // US order
  if (m) return utcDate(+m[3], +m[1] - 1, +m[2]);
  const monthIdx = (w: string) => MONTHS.findIndex((x) => x === w || (w.length >= 3 && x.startsWith(w)));
  m = /^([a-z]+) (\d{1,2})(?: (\d{1,4}))?$/.exec(s);
  if (m && monthIdx(m[1]) >= 0) return m[3] ? utcDate(+m[3], monthIdx(m[1]), +m[2]) : nextOccurrence(monthIdx(m[1]), +m[2]);
  m = /^(\d{1,2}) ([a-z]+)(?: (\d{1,4}))?$/.exec(s);
  if (m && monthIdx(m[2]) >= 0) return m[3] ? utcDate(+m[3], monthIdx(m[2]), +m[1]) : nextOccurrence(monthIdx(m[2]), +m[1]);
  return null;
}

const dates: Tool = (text, now) => {
  const t = clean(text);
  let m = /^what(?:'s| is) (?:the date )?today(?:'s date)?$|^what(?:'s| is) the date(?: today)?$|^what day is (?:it )?today$/i.exec(t);
  if (m) return { tool: "date", answer: `Today is **${fmtDate(today(now))}**.` };
  m = /^what day(?: of the week)? (?:is|was|will be|does|did) (.+?)(?: (?:fall|land) on| be)?$/i.exec(t);
  if (m) {
    const d = parseDate(m[1], now);
    if (d) return { tool: "day of week", answer: `${fmtDate(d).replace(/^(\w+)/, "**$1**")}.` };
  }
  m = /^how many (days|weeks|months)(?: are there| is it| left)? (?:until|till|til|before|to) (.+)$/i.exec(t);
  if (m) {
    const d = parseDate(m[2], now);
    if (d) {
      const days = dayDiff(today(now), d);
      const unit = m[1].toLowerCase();
      const value = unit === "weeks" ? `${n(Math.round((days / 7) * 10) / 10)} weeks` : unit === "months" ? `about ${n(Math.round((days / 30.44) * 10) / 10)} months` : `${days} days`;
      return { tool: "date difference", answer: `**${value}** until ${fmtDate(d)}${unit === "days" ? "" : ` (${days} days)`}.` };
    }
  }
  m = /^how many days (?:are there )?(?:between|from) (.+?) (?:and|to|until) (.+)$/i.exec(t);
  if (m) {
    const a = parseDate(m[1], now);
    const b = parseDate(m[2], now);
    if (a && b) return { tool: "date difference", answer: `**${Math.abs(dayDiff(a, b))} days** between ${fmtDate(a)} and ${fmtDate(b)}.` };
  }
  m = /^(?:what (?:is|was|will be) )?(?:the date )?(\d+) (days?|weeks?|months?|years?) (from|after|before) (.+)$|^(?:what (?:is|will be) )?(?:the date )?(?:in )?(\d+) (days?|weeks?|months?|years?)(?: from (?:now|today))?$/i.exec(t);
  if (m) {
    const amount = Number(m[1] ?? m[5]);
    const unit = (m[2] ?? m[6]).toLowerCase().replace(/s$/, "");
    const sign = m[3]?.toLowerCase() === "before" ? -1 : 1;
    const start = m[4] ? parseDate(m[4], now) : today(now);
    if (start) {
      const d = new Date(start);
      if (unit === "day") d.setUTCDate(d.getUTCDate() + sign * amount);
      if (unit === "week") d.setUTCDate(d.getUTCDate() + sign * amount * 7);
      if (unit === "month") d.setUTCMonth(d.getUTCMonth() + sign * amount);
      if (unit === "year") d.setUTCFullYear(d.getUTCFullYear() + sign * amount);
      return { tool: "date arithmetic", answer: `**${fmtDate(d)}**` };
    }
  }
  m = /^is (\d{1,4}) a leap year$/i.exec(t);
  if (m) {
    const y = Number(m[1]);
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return { tool: "leap year", answer: `${leap ? "**Yes**" : "**No**"}, ${y} ${leap ? "is" : "isn't"} a leap year${y % 100 === 0 ? ` (century years are leap years only when divisible by 400)` : ""}.` };
  }
  m = /^how old (?:is|am|would be|will be) (?:someone|a person|i|he|she|they)? ?(?:if (?:i was|i'm|they were|he was|she was) )?born (?:on |in )?(.+)$/i.exec(t);
  if (m) {
    const born = parseDate(m[1], now) ?? (/^\d{4}$/.test(m[1].trim()) ? utcDate(+m[1], 0, 1) : null);
    if (born) {
      const t0 = today(now);
      let age = t0.getUTCFullYear() - born.getUTCFullYear();
      if (t0.getUTCMonth() < born.getUTCMonth() || (t0.getUTCMonth() === born.getUTCMonth() && t0.getUTCDate() < born.getUTCDate())) age--;
      return { tool: "age", answer: /^\d{4}$/.test(m[1].trim()) ? `About **${age}** (${age} or ${age + 1}, depending on the birthday).` : `**${age}** years old.` };
    }
  }
  return null;
};

const TOOLS: Tool[] = [letterCount, textStats, reverseText, compareNumbers, sortNumbers, primes, gcdLcm, percentages, units, dates, calculator];

/** An exact answer from a tool, or null if no tool fits the question. */
export function answerWithTools(text: string, now = new Date()): ToolAnswer | null {
  if (text.length > 300) return null;
  for (const tool of TOOLS) {
    try {
      const r = tool(text, now);
      if (r) return r;
    } catch {
      // a tool that can't handle the input just doesn't answer
    }
  }
  return null;
}
