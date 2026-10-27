import type { AgentFn } from "./base.js";
import { profileSigns, type Profile } from "../lib/decipher.js";
import { assertNotAborted, evidence, logAgentAction } from "./base.js";

interface ScriptRef {
  name: string;
  aliases: RegExp;
  type: "logographic" | "syllabic" | "alphabetic" | "undeciphered";
  region: string;
  approxDateRange: string;
  decipherment: "fully deciphered" | "partially deciphered" | "undeciphered";
  descendants: string[];
  note: string;
  uncertainty: string;
}

const REFERENCES: ScriptRef[] = [
  {
    name: "Egyptian Hieroglyphs",
    aliases: /hieroglyph/i,
    type: "logographic",
    region: "Ancient Egypt",
    approxDateRange: "c. 3200 BCE – 400 CE",
    decipherment: "fully deciphered",
    descendants: ["Hieratic", "Demotic", "indirectly influenced the Phoenician-derived alphabets via Proto-Sinaitic"],
    note: "Combines logograms, phonetic signs (uniliteral/biliteral/triliteral), and determinatives. Deciphered via the Rosetta Stone's trilingual text (Champollion, 1822).",
    uncertainty: "Precise vocalization of many words is reconstructed, not directly attested, since vowels were usually unwritten.",
  },
  {
    name: "Sumerian Cuneiform",
    aliases: /cuneiform|sumerian/i,
    type: "logographic",
    region: "Mesopotamia",
    approxDateRange: "c. 3400 BCE – 100 CE",
    decipherment: "fully deciphered",
    descendants: ["Akkadian cuneiform", "Elamite cuneiform", "Old Persian cuneiform (independently simplified)"],
    note: "Originated as pictographic tallies on clay, evolved into wedge-shaped logo-syllabic signs. Deciphered largely via the trilingual Behistun Inscription.",
    uncertainty: "Earliest proto-cuneiform tablets (c. 3400–3100 BCE) are largely administrative tallies whose full sign inventory and reading are still debated.",
  },
  {
    name: "Phoenician",
    aliases: /phoenician/i,
    type: "alphabetic",
    region: "Eastern Mediterranean (Levant)",
    approxDateRange: "c. 1050 BCE – 150 BCE",
    decipherment: "fully deciphered",
    descendants: ["Greek alphabet", "Aramaic (and onward to Hebrew, Arabic)", "indirectly Latin"],
    note: "Consonant-only (abjad) alphabet of 22 letters; widely considered the common ancestor of most modern alphabets through trade contact.",
    uncertainty: "The exact mechanism of transmission to Greek (direct contact vs. intermediary scripts) is debated among epigraphers.",
  },
  {
    name: "Greek Alphabet",
    aliases: /\bgreek\b/i,
    type: "alphabetic",
    region: "Greece / Aegean",
    approxDateRange: "c. 800 BCE – present",
    decipherment: "fully deciphered",
    descendants: ["Latin alphabet", "Cyrillic alphabet", "Coptic alphabet"],
    note: "First widely-used true alphabet with distinct vowel letters, adapted from Phoenician by repurposing unneeded consonant signs as vowels.",
    uncertainty: "Minimal — in continuous attested use into the modern alphabet.",
  },
  {
    name: "Linear B",
    aliases: /linear b/i,
    type: "syllabic",
    region: "Mycenaean Greece (Crete, mainland)",
    approxDateRange: "c. 1450 – 1200 BCE",
    decipherment: "fully deciphered",
    descendants: ["No direct descendant; Greek later adopted the Phoenician-derived alphabet instead"],
    note: "Used for administrative record-keeping of early Mycenaean Greek; deciphered by Michael Ventris in 1952 by recognizing it encoded an early Greek dialect.",
    uncertainty: "Many signs for rare words/names remain of uncertain reading.",
  },
  {
    name: "Linear A",
    aliases: /linear a/i,
    type: "undeciphered",
    region: "Minoan Crete",
    approxDateRange: "c. 1800 – 1450 BCE",
    decipherment: "undeciphered",
    descendants: ["Possibly influenced Linear B's sign shapes, language link unconfirmed"],
    note: "Shares sign shapes with Linear B but encodes an unknown, non-Greek language (\"Minoan\"); no bilingual text has been found to anchor a decipherment.",
    uncertainty: "High — proposed readings (e.g. as a form of Luwian or a Semitic language) are not broadly accepted.",
  },
  {
    name: "Brahmi",
    aliases: /brahmi/i,
    type: "syllabic",
    region: "Indian subcontinent",
    approxDateRange: "c. 300 BCE – 400 CE",
    decipherment: "fully deciphered",
    descendants: ["Devanagari", "Tamil script", "most modern Brahmic scripts of South/Southeast Asia"],
    note: "Abugida (consonant signs with inherent vowel, modified by diacritics); first securely dated via Ashokan edicts.",
    uncertainty: "Origin is debated: independent invention vs. derivation from a Semitic abjad via trade contact.",
  },
];

function findMentioned(text: string): ScriptRef[] {
  return REFERENCES.filter((r) => r.aliases.test(text));
}

/** "decipher this", "what kind of script is this", or text written in an ancient script. */
const DECIPHER = /\b(decipher\w*|decode|analy[sz]e|what (kind of |type of )?(script|writing|symbols)|unknown (script|writing|symbols)|mystery (script|writing|symbols)|transliterat\w*|read this)\b/i;

function decipherFindings(p: Profile): string[] {
  const out = [
    `**Sign count:** ${p.total} signs, ${p.distinct} different ones${p.script ? ` (written in ${p.script})` : ""}. Allowing for signs this text doesn't happen to use, the full script probably has about **${p.estimatedInventory}** signs, ${p.total < 40 ? `but that's ${p.likelyType}.` : `which points to **${p.likelyType}**.`}`,
    `**Most frequent signs:** ${p.top.map((t) => `${t.sign} ×${t.count}`).join(", ")}. In alphabets the most frequent signs are usually vowels or common consonants; in syllabaries, common syllables.`,
  ];
  if (p.total >= 40) out.splice(1, 0, `**Closest known writing systems by size:** ${p.closest.map((k) => `${k.name} (${k.signs} signs, ${k.type})`).join("; ")}.`);
  if (p.repeats.length) out.push(`**Repeated groups** (candidates for words, names, titles or numbers): ${p.repeats.map((r) => `${r.group} ×${r.count}`).join(", ")}.`);
  if (p.transliteration) out.push(`**Transliteration** (${p.script}): ${p.transliteration}`);
  out.push(
    "This is the statistical first step of decipherment, not a translation: real decipherments also needed bilingual texts (the Rosetta Stone, the Behistun inscription), known names, or a related language. A longer text gives a much better estimate."
  );
  return out;
}

export const scriptScholarAgent: AgentFn = async (input, ctx) => {
  assertNotAborted(ctx);
  // Text in an ancient script, or a request to decipher one: run the decipherment helper.
  const profile = profileSigns(input.requestText);
  if (profile && (DECIPHER.test(input.requestText) || profile.script)) {
    logAgentAction(input.runId, "ScriptScholar", "decipher", { signs: profile.total, distinct: profile.distinct, estimate: profile.estimatedInventory, script: profile.script }, "completed");
    return {
      status: "success",
      findings: decipherFindings(profile),
      evidence: [evidence("scriptscholar-decipher", `${profile.total} signs analysed`)],
      confidence: profile.total >= 100 ? 0.7 : 0.45,
      limitations: profile.total < 100 ? [`Only ${profile.total} signs: short texts make the sign-inventory estimate rough.`] : [],
      proposedActions: [],
    };
  }
  const mentioned = findMentioned(input.requestText);
  logAgentAction(input.runId, "ScriptScholar", "lookup_reference_set", { matched: mentioned.map((m) => m.name) }, "completed");

  if (mentioned.length === 0) {
    return {
      status: "partial_success",
      findings: [
        "No script in the supported reference set was named explicitly. Supported scripts: " +
          REFERENCES.map((r) => r.name).join(", ") + ".",
        "Not implemented: comparisons for scripts outside this curated reference set.",
        "To analyse an unknown script, paste the text (Unicode symbols, or sign codes like AB01-AB28) and ask me to decipher it: I'll count its signs, estimate what kind of writing system it is, and find repeated groups.",
      ],
      evidence: [],
      confidence: 0.3,
      limitations: ["ScriptScholar only compares scripts in its curated reference set; it does not have open-ended access to external epigraphic databases."],
      proposedActions: [],
    };
  }

  if (mentioned.length === 1) {
    const r = mentioned[0];
    return {
      status: "success",
      findings: [
        `${r.name}: ${r.type} script, ${r.region}, ${r.approxDateRange}, ${r.decipherment}.`,
        r.note,
        `Descendants / related scripts: ${r.descendants.join("; ")}.`,
        `Uncertainty: ${r.uncertainty}`,
      ],
      evidence: [evidence("scriptscholar-reference-set", r.name)],
      confidence: r.decipherment === "undeciphered" ? 0.4 : 0.8,
      limitations: ["Only one script was named, so this is a single-entry summary rather than a comparison."],
      proposedActions: [],
    };
  }

  const comparisons: string[] = [];
  for (let i = 0; i < mentioned.length; i++) {
    for (let j = i + 1; j < mentioned.length; j++) {
      const a = mentioned[i];
      const b = mentioned[j];
      comparisons.push(
        `${a.name} vs ${b.name}: types ${a.type} vs ${b.type}; dates ${a.approxDateRange} vs ${b.approxDateRange}; decipherment ${a.decipherment} vs ${b.decipherment}.` +
          (a.descendants.includes(b.name) || b.descendants.includes(a.name) ? " Direct lineage relationship documented." : " No direct lineage documented between them.")
      );
    }
  }

  const anyUndeciphered = mentioned.some((m) => m.decipherment !== "fully deciphered");

  return {
    status: "success",
    findings: [
      `Compared ${mentioned.length} scripts: ${mentioned.map((m) => m.name).join(", ")}.`,
      ...comparisons,
      ...mentioned.map((m) => `${m.name} uncertainty: ${m.uncertainty}`),
    ],
    evidence: mentioned.map((m) => evidence("scriptscholar-reference-set", `${m.name}: ${m.note}`)),
    confidence: anyUndeciphered ? 0.55 : 0.8,
    limitations: anyUndeciphered
      ? ["One or more compared scripts are only partially deciphered or undeciphered; claims about them are necessarily tentative."]
      : ["Comparison uses a curated reference set and standard dating ranges, which have some scholarly margin of error."],
    proposedActions: [],
  };
};
