// ScriptScholar's decipherment helper: the first steps epigraphers take with an unknown script.
//   1. Count the signs: how many different ones, and how often each appears.
//   2. Estimate the whole sign inventory (a short text never shows every sign) and compare it with
//      known writing systems: alphabets/abjads use about 20-40 signs, syllabaries about 40-100,
//      logo-syllabic systems hundreds or more.
//   3. Find repeated sign groups (likely words, names, titles or numbers).
// Text in a script it can read (Phoenician, runes, Ogham, Greek) is also transliterated. It never
// claims a translation: a statistical profile narrows the possibilities, it doesn't decipher.

const PHOENICIAN = "ʾ b g d h w z ḥ ṭ y k l m n s ʿ p ṣ q r š t".split(" ");
const RUNES: Record<string, string> = { ᚠ: "f", ᚢ: "u", ᚦ: "th", ᚨ: "a", ᚱ: "r", ᚲ: "k", ᚷ: "g", ᚹ: "w", ᚺ: "h", ᚻ: "h", ᚾ: "n", ᛁ: "i", ᛃ: "j", ᛇ: "ei", ᛈ: "p", ᛉ: "z", ᛊ: "s", ᛋ: "s", ᛏ: "t", ᛒ: "b", ᛖ: "e", ᛗ: "m", ᛚ: "l", ᛜ: "ng", ᛝ: "ng", ᛞ: "d", ᛟ: "o" };
const OGHAM: Record<string, string> = { ᚁ: "b", ᚂ: "l", ᚃ: "v", ᚄ: "s", ᚅ: "n", ᚆ: "h", ᚇ: "d", ᚈ: "t", ᚉ: "c", ᚊ: "q", ᚋ: "m", ᚌ: "g", ᚍ: "ng", ᚎ: "z", ᚏ: "r", ᚐ: "a", ᚑ: "o", ᚒ: "u", ᚓ: "e", ᚔ: "i" };
const GREEK: Record<string, string> = { α: "a", β: "b", γ: "g", δ: "d", ε: "e", ζ: "z", η: "ē", θ: "th", ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x", ο: "o", π: "p", ρ: "r", σ: "s", ς: "s", τ: "t", υ: "y", φ: "ph", χ: "ch", ψ: "ps", ω: "ō" };

const BLOCKS: { name: string; from: number; to: number }[] = [
  { name: "Phoenician", from: 0x10900, to: 0x1091f },
  { name: "Runic (Elder Futhark)", from: 0x16a0, to: 0x16ff },
  { name: "Ogham", from: 0x1680, to: 0x169f },
  { name: "Greek", from: 0x0370, to: 0x03ff },
  { name: "Linear B", from: 0x10000, to: 0x100ff },
  { name: "Old Italic", from: 0x10300, to: 0x1032f },
  { name: "Egyptian hieroglyphs", from: 0x13000, to: 0x1342f },
  { name: "Cuneiform", from: 0x12000, to: 0x123ff },
  { name: "Ugaritic", from: 0x10380, to: 0x1039f },
  { name: "Old Persian", from: 0x103a0, to: 0x103df },
];

/** Known inventories, for comparison. */
export const KNOWN_INVENTORIES: { name: string; signs: number; type: string }[] = [
  { name: "Phoenician", signs: 22, type: "abjad (consonants only)" },
  { name: "Greek", signs: 24, type: "alphabet" },
  { name: "Elder Futhark runes", signs: 24, type: "alphabet" },
  { name: "Ogham", signs: 20, type: "alphabet" },
  { name: "Old Persian cuneiform", signs: 36, type: "semi-syllabary" },
  { name: "Cherokee", signs: 85, type: "syllabary" },
  { name: "Linear B", signs: 89, type: "syllabary (plus logograms)" },
  { name: "Linear A (undeciphered)", signs: 90, type: "probably a syllabary" },
  { name: "Rongorongo (undeciphered)", signs: 120, type: "unclear: syllabary or logo-syllabic" },
  { name: "Mayan glyphs", signs: 500, type: "logo-syllabic" },
  { name: "Sumerian cuneiform", signs: 600, type: "logo-syllabic" },
  { name: "Egyptian hieroglyphs", signs: 750, type: "logo-consonantal" },
  { name: "Chinese (common characters)", signs: 3500, type: "logographic" },
];

const cp = (ch: string) => ch.codePointAt(0) ?? 0;
const blockOf = (ch: string) => BLOCKS.find((b) => cp(ch) >= b.from && cp(ch) <= b.to)?.name ?? null;

/** The signs in the text: historic-script characters, or sign codes written as transliteration ("AB01-AB28", "*31 *57"). */
export function extractSigns(text: string): { signs: string[]; script: string | null } {
  const chars = Array.from(text).filter((ch) => blockOf(ch));
  if (chars.length >= 4) {
    const counts = new Map<string, number>();
    for (const ch of chars) counts.set(blockOf(ch)!, (counts.get(blockOf(ch)!) ?? 0) + 1);
    const script = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    return { signs: chars, script };
  }
  // Sign codes: AB01, A301, *31, or symbols separated by dashes/dots.
  const codes = text.match(/\b(?:[A-Z]{1,2}\d{2,3}[a-z]?|\*\d{1,3})\b/g) ?? [];
  if (codes.length >= 4) return { signs: codes, script: null };
  // Last resort: a quoted run of unusual symbols ("decipher this: ◇△○△◇").
  const quoted = /[:"“]\s*([^\s\w"”]{4,}(?:\s+[^\s\w"”]+)*)/u.exec(text)?.[1] ?? "";
  const symbols = Array.from(quoted).filter((c) => /\S/u.test(c) && !/[,.;:!?'"()\-]/.test(c));
  return { signs: symbols.length >= 4 ? symbols : [], script: null };
}

export interface Profile {
  total: number;
  distinct: number;
  /** Good-Turing coverage estimate of how many signs the whole script probably has. */
  estimatedInventory: number;
  likelyType: string;
  closest: { name: string; signs: number; type: string }[];
  top: { sign: string; count: number }[];
  repeats: { group: string; count: number }[];
  script: string | null;
  transliteration: string | null;
}

function transliterate(text: string, script: string | null): string | null {
  if (script === "Phoenician") return Array.from(text).map((c) => (blockOf(c) === "Phoenician" ? (PHOENICIAN[cp(c) - 0x10900] ?? "?") : c === " " ? " " : "")).join("").trim();
  if (script?.startsWith("Runic")) return Array.from(text).map((c) => RUNES[c] ?? (c === " " || c === "᛫" ? " " : "")).join("").trim();
  if (script === "Ogham") return Array.from(text).map((c) => OGHAM[c] ?? (c === " " || c === " " ? " " : "")).join("").trim();
  if (script === "Greek") return Array.from(text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")).map((c) => GREEK[c] ?? (/\s/.test(c) ? " " : "")).join("").replace(/\s+/g, " ").trim();
  return null;
}

export function profileSigns(text: string): Profile | null {
  const { signs, script } = extractSigns(text);
  if (signs.length < 4) return null;
  const counts = new Map<string, number>();
  for (const s of signs) counts.set(s, (counts.get(s) ?? 0) + 1);
  const distinct = counts.size;
  const hapax = [...counts.values()].filter((n) => n === 1).length;
  // Good-Turing: the share of the text made of signs seen once estimates how much is still unseen.
  const coverage = Math.max(0.05, 1 - hapax / signs.length);
  const estimatedInventory = Math.round(distinct / coverage);
  const likelyType =
    signs.length < 40
      ? `too little text to tell what kind of script it is (it has at least ${distinct} different signs; an alphabet needs about 20-40, a syllabary 40-100)`
      : estimatedInventory <= 40 ? "an alphabet or abjad (about 20-40 signs)" : estimatedInventory <= 110 ? "a syllabary (about 40-100 signs)" : "a logo-syllabic or logographic system (hundreds of signs or more)";
  const closest = [...KNOWN_INVENTORIES].sort((a, b) => Math.abs(Math.log(a.signs / estimatedInventory)) - Math.abs(Math.log(b.signs / estimatedInventory))).slice(0, 3);
  const grams = new Map<string, number>();
  for (const n of [2, 3]) for (let i = 0; i + n <= signs.length; i++) {
    const g = signs.slice(i, i + n).join(signs[0].length > 1 ? "-" : "");
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  const repeats = [...grams].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 6).map(([group, count]) => ({ group, count }));
  return {
    total: signs.length,
    distinct,
    estimatedInventory,
    likelyType,
    closest,
    top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([sign, count]) => ({ sign, count })),
    repeats,
    script,
    transliteration: transliterate(text, script),
  };
}
