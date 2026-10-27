"""ScriptScholar: ancient writing systems. Compares scripts from a curated reference set, and takes the
statistical first steps of decipherment for text in an unknown or ancient script (sign counts, a Good-Turing
estimate of the whole sign inventory, the closest known systems, repeated groups, transliteration of
scripts it can read). Never claims a translation. No AI model. (Ported from server/src/agents/scriptScholar.ts
and lib/decipher.ts; identical output, including JavaScript's UTF-16 string lengths.)"""
from __future__ import annotations

import math
import re
import unicodedata

from ... import store
from .base import evidence
from .jsfmt import js_round

JS_SPACE = "\t\n\v\f\r    -     　﻿"  # JavaScript's \s


def is_js_space(c: str) -> bool:
    return re.match(f"[{JS_SPACE}]", c) is not None


def u16len(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


PHOENICIAN = "ʾ b g d h w z ḥ ṭ y k l m n s ʿ p ṣ q r š t".split(" ")
RUNES = {"ᚠ": "f", "ᚢ": "u", "ᚦ": "th", "ᚨ": "a", "ᚱ": "r", "ᚲ": "k", "ᚷ": "g", "ᚹ": "w", "ᚺ": "h", "ᚻ": "h", "ᚾ": "n", "ᛁ": "i", "ᛃ": "j", "ᛇ": "ei", "ᛈ": "p", "ᛉ": "z", "ᛊ": "s", "ᛋ": "s", "ᛏ": "t", "ᛒ": "b", "ᛖ": "e", "ᛗ": "m", "ᛚ": "l", "ᛜ": "ng", "ᛝ": "ng", "ᛞ": "d", "ᛟ": "o"}
OGHAM = {"ᚁ": "b", "ᚂ": "l", "ᚃ": "v", "ᚄ": "s", "ᚅ": "n", "ᚆ": "h", "ᚇ": "d", "ᚈ": "t", "ᚉ": "c", "ᚊ": "q", "ᚋ": "m", "ᚌ": "g", "ᚍ": "ng", "ᚎ": "z", "ᚏ": "r", "ᚐ": "a", "ᚑ": "o", "ᚒ": "u", "ᚓ": "e", "ᚔ": "i"}
GREEK = {"α": "a", "β": "b", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "ē", "θ": "th", "ι": "i", "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "x", "ο": "o", "π": "p", "ρ": "r", "σ": "s", "ς": "s", "τ": "t", "υ": "y", "φ": "ph", "χ": "ch", "ψ": "ps", "ω": "ō"}
BLOCKS = [("Phoenician", 0x10900, 0x1091F), ("Runic (Elder Futhark)", 0x16A0, 0x16FF), ("Ogham", 0x1680, 0x169F), ("Greek", 0x0370, 0x03FF), ("Linear B", 0x10000, 0x100FF),
          ("Old Italic", 0x10300, 0x1032F), ("Egyptian hieroglyphs", 0x13000, 0x1342F), ("Cuneiform", 0x12000, 0x123FF), ("Ugaritic", 0x10380, 0x1039F), ("Old Persian", 0x103A0, 0x103DF)]
KNOWN = [("Phoenician", 22, "abjad (consonants only)"), ("Greek", 24, "alphabet"), ("Elder Futhark runes", 24, "alphabet"), ("Ogham", 20, "alphabet"), ("Old Persian cuneiform", 36, "semi-syllabary"),
         ("Cherokee", 85, "syllabary"), ("Linear B", 89, "syllabary (plus logograms)"), ("Linear A (undeciphered)", 90, "probably a syllabary"), ("Rongorongo (undeciphered)", 120, "unclear: syllabary or logo-syllabic"),
         ("Mayan glyphs", 500, "logo-syllabic"), ("Sumerian cuneiform", 600, "logo-syllabic"), ("Egyptian hieroglyphs", 750, "logo-consonantal"), ("Chinese (common characters)", 3500, "logographic")]


def block_of(ch: str) -> str | None:
    c = ord(ch)
    return next((n for n, a, b in BLOCKS if a <= c <= b), None)


QUOTED = re.compile(f"[:\"“][{JS_SPACE}]*([^{JS_SPACE}A-Za-z0-9_\"”]{{4,}}(?:[{JS_SPACE}]+[^{JS_SPACE}A-Za-z0-9_\"”]+)*)")


def extract_signs(text: str) -> tuple[list[str], str | None]:
    chars = [ch for ch in text if block_of(ch)]
    if len(chars) >= 4:
        counts: dict[str, int] = {}
        for ch in chars:
            counts[block_of(ch)] = counts.get(block_of(ch), 0) + 1
        return chars, sorted(counts.items(), key=lambda x: -x[1])[0][0]
    codes = re.findall(r"\b(?:[A-Z]{1,2}\d{2,3}[a-z]?|\*\d{1,3})\b", text, re.A)
    if len(codes) >= 4:
        return codes, None
    m = QUOTED.search(text)
    quoted = m.group(1) if m else ""
    symbols = [c for c in quoted if not is_js_space(c) and not re.match(r"[,.;:!?'\"()\-]", c)]
    return (symbols if len(symbols) >= 4 else []), None


def transliterate(text: str, script: str | None) -> str | None:
    if script == "Phoenician":
        return "".join((PHOENICIAN[ord(c) - 0x10900] if ord(c) - 0x10900 < len(PHOENICIAN) else "?") if block_of(c) == "Phoenician" else (" " if c == " " else "") for c in text).strip(JS_SPACE_CHARS)
    if script and script.startswith("Runic"):
        return "".join(RUNES.get(c) or (" " if c in (" ", "᛫") else "") for c in text).strip(JS_SPACE_CHARS)
    if script == "Ogham":
        return "".join(OGHAM.get(c) or (" " if c in (" ", " ") else "") for c in text).strip(JS_SPACE_CHARS)
    if script == "Greek":
        norm = re.sub("[̀-ͯ]", "", unicodedata.normalize("NFD", text.lower()))
        out = "".join(GREEK.get(c) or (" " if is_js_space(c) else "") for c in norm)
        return re.sub(f"[{JS_SPACE}]+", " ", out).strip(JS_SPACE_CHARS)
    return None


JS_SPACE_CHARS = "\t\n\v\f\r   " + "".join(chr(c) for c in range(0x2000, 0x200B)) + "    　﻿"


def profile_signs(text: str) -> dict | None:
    signs, script = extract_signs(text)
    if len(signs) < 4:
        return None
    counts: dict[str, int] = {}
    for s in signs:
        counts[s] = counts.get(s, 0) + 1
    distinct = len(counts)
    hapax = sum(1 for n in counts.values() if n == 1)
    coverage = max(0.05, 1 - hapax / len(signs))
    est = js_round(distinct / coverage)
    if len(signs) < 40:
        likely = f"too little text to tell what kind of script it is (it has at least {distinct} different signs; an alphabet needs about 20-40, a syllabary 40-100)"
    else:
        likely = "an alphabet or abjad (about 20-40 signs)" if est <= 40 else "a syllabary (about 40-100 signs)" if est <= 110 else "a logo-syllabic or logographic system (hundreds of signs or more)"
    closest = sorted(KNOWN, key=lambda k: abs(math.log(k[1] / est)))[:3]
    grams: dict[str, int] = {}
    sep = "-" if u16len(signs[0]) > 1 else ""
    for n in (2, 3):
        for i in range(len(signs) - n + 1):
            g = sep.join(signs[i:i + n])
            grams[g] = grams.get(g, 0) + 1
    repeats = sorted([(g, c) for g, c in grams.items() if c >= 2], key=lambda x: (-x[1], -u16len(x[0])))[:6]
    return {"total": len(signs), "distinct": distinct, "estimatedInventory": est, "likelyType": likely,
            "closest": [{"name": n, "signs": s, "type": t} for n, s, t in closest],
            "top": [{"sign": s, "count": c} for s, c in sorted(counts.items(), key=lambda x: -x[1])[:8]],
            "repeats": [{"group": g, "count": c} for g, c in repeats], "script": script, "transliteration": transliterate(text, script)}


REFERENCES = [
    {"name": "Egyptian Hieroglyphs", "aliases": r"hieroglyph", "type": "logographic", "region": "Ancient Egypt", "approxDateRange": "c. 3200 BCE – 400 CE", "decipherment": "fully deciphered",
     "descendants": ["Hieratic", "Demotic", "indirectly influenced the Phoenician-derived alphabets via Proto-Sinaitic"],
     "note": "Combines logograms, phonetic signs (uniliteral/biliteral/triliteral), and determinatives. Deciphered via the Rosetta Stone's trilingual text (Champollion, 1822).",
     "uncertainty": "Precise vocalization of many words is reconstructed, not directly attested, since vowels were usually unwritten."},
    {"name": "Sumerian Cuneiform", "aliases": r"cuneiform|sumerian", "type": "logographic", "region": "Mesopotamia", "approxDateRange": "c. 3400 BCE – 100 CE", "decipherment": "fully deciphered",
     "descendants": ["Akkadian cuneiform", "Elamite cuneiform", "Old Persian cuneiform (independently simplified)"],
     "note": "Originated as pictographic tallies on clay, evolved into wedge-shaped logo-syllabic signs. Deciphered largely via the trilingual Behistun Inscription.",
     "uncertainty": "Earliest proto-cuneiform tablets (c. 3400–3100 BCE) are largely administrative tallies whose full sign inventory and reading are still debated."},
    {"name": "Phoenician", "aliases": r"phoenician", "type": "alphabetic", "region": "Eastern Mediterranean (Levant)", "approxDateRange": "c. 1050 BCE – 150 BCE", "decipherment": "fully deciphered",
     "descendants": ["Greek alphabet", "Aramaic (and onward to Hebrew, Arabic)", "indirectly Latin"],
     "note": "Consonant-only (abjad) alphabet of 22 letters; widely considered the common ancestor of most modern alphabets through trade contact.",
     "uncertainty": "The exact mechanism of transmission to Greek (direct contact vs. intermediary scripts) is debated among epigraphers."},
    {"name": "Greek Alphabet", "aliases": r"\bgreek\b", "type": "alphabetic", "region": "Greece / Aegean", "approxDateRange": "c. 800 BCE – present", "decipherment": "fully deciphered",
     "descendants": ["Latin alphabet", "Cyrillic alphabet", "Coptic alphabet"],
     "note": "First widely-used true alphabet with distinct vowel letters, adapted from Phoenician by repurposing unneeded consonant signs as vowels.",
     "uncertainty": "Minimal — in continuous attested use into the modern alphabet."},
    {"name": "Linear B", "aliases": r"linear b", "type": "syllabic", "region": "Mycenaean Greece (Crete, mainland)", "approxDateRange": "c. 1450 – 1200 BCE", "decipherment": "fully deciphered",
     "descendants": ["No direct descendant; Greek later adopted the Phoenician-derived alphabet instead"],
     "note": "Used for administrative record-keeping of early Mycenaean Greek; deciphered by Michael Ventris in 1952 by recognizing it encoded an early Greek dialect.",
     "uncertainty": "Many signs for rare words/names remain of uncertain reading."},
    {"name": "Linear A", "aliases": r"linear a", "type": "undeciphered", "region": "Minoan Crete", "approxDateRange": "c. 1800 – 1450 BCE", "decipherment": "undeciphered",
     "descendants": ["Possibly influenced Linear B's sign shapes, language link unconfirmed"],
     "note": "Shares sign shapes with Linear B but encodes an unknown, non-Greek language (\"Minoan\"); no bilingual text has been found to anchor a decipherment.",
     "uncertainty": "High — proposed readings (e.g. as a form of Luwian or a Semitic language) are not broadly accepted."},
    {"name": "Brahmi", "aliases": r"brahmi", "type": "syllabic", "region": "Indian subcontinent", "approxDateRange": "c. 300 BCE – 400 CE", "decipherment": "fully deciphered",
     "descendants": ["Devanagari", "Tamil script", "most modern Brahmic scripts of South/Southeast Asia"],
     "note": "Abugida (consonant signs with inherent vowel, modified by diacritics); first securely dated via Ashokan edicts.",
     "uncertainty": "Origin is debated: independent invention vs. derivation from a Semitic abjad via trade contact."},
]
DECIPHER = re.compile(r"\b(decipher\w*|decode|analy[sz]e|what (kind of |type of )?(script|writing|symbols)|unknown (script|writing|symbols)|mystery (script|writing|symbols)|transliterat\w*|read this)\b", re.I | re.A)


def decipher_findings(p: dict) -> list[str]:
    out = [f"**Sign count:** {p['total']} signs, {p['distinct']} different ones{' (written in ' + p['script'] + ')' if p['script'] else ''}. Allowing for signs this text doesn't happen to use, the full script probably has about **{p['estimatedInventory']}** signs, "
           + (f"but that's {p['likelyType']}." if p["total"] < 40 else f"which points to **{p['likelyType']}**."),
           f"**Most frequent signs:** {', '.join(f'{t['sign']} ×{t['count']}' for t in p['top'])}. In alphabets the most frequent signs are usually vowels or common consonants; in syllabaries, common syllables."]
    if p["total"] >= 40:
        out.insert(1, f"**Closest known writing systems by size:** {'; '.join(f'{k['name']} ({k['signs']} signs, {k['type']})' for k in p['closest'])}.")
    if p["repeats"]:
        out.append(f"**Repeated groups** (candidates for words, names, titles or numbers): {', '.join(f'{r['group']} ×{r['count']}' for r in p['repeats'])}.")
    if p["transliteration"]:
        out.append(f"**Transliteration** ({p['script']}): {p['transliteration']}")
    out.append("This is the statistical first step of decipherment, not a translation: real decipherments also needed bilingual texts (the Rosetta Stone, the Behistun inscription), known names, or a related language. A longer text gives a much better estimate.")
    return out


async def run(input: dict, ctx: dict) -> dict:
    text, run_id = input["requestText"], input["runId"]
    p = profile_signs(text)
    if p and (DECIPHER.search(text) or p["script"]):
        store.audit(run_id, "ScriptScholar", "decipher", {"signs": p["total"], "distinct": p["distinct"], "estimate": p["estimatedInventory"], "script": p["script"]}, "completed")
        return {"status": "success", "findings": decipher_findings(p), "evidence": [evidence("scriptscholar-decipher", f"{p['total']} signs analysed")],
                "confidence": 0.7 if p["total"] >= 100 else 0.45, "limitations": [] if p["total"] >= 100 else [f"Only {p['total']} signs: short texts make the sign-inventory estimate rough."], "proposedActions": []}
    mentioned = [r for r in REFERENCES if re.search(r["aliases"], text, re.I | re.A)]
    store.audit(run_id, "ScriptScholar", "lookup_reference_set", {"matched": [m["name"] for m in mentioned]}, "completed")
    if not mentioned:
        return {"status": "partial_success", "findings": ["No script in the supported reference set was named explicitly. Supported scripts: " + ", ".join(r["name"] for r in REFERENCES) + ".",
                                                         "Not implemented: comparisons for scripts outside this curated reference set.",
                                                         "To analyse an unknown script, paste the text (Unicode symbols, or sign codes like AB01-AB28) and ask me to decipher it: I'll count its signs, estimate what kind of writing system it is, and find repeated groups."],
                "evidence": [], "confidence": 0.3, "limitations": ["ScriptScholar only compares scripts in its curated reference set; it does not have open-ended access to external epigraphic databases."], "proposedActions": []}
    if len(mentioned) == 1:
        r = mentioned[0]
        return {"status": "success", "findings": [f"{r['name']}: {r['type']} script, {r['region']}, {r['approxDateRange']}, {r['decipherment']}.", r["note"], f"Descendants / related scripts: {'; '.join(r['descendants'])}.", f"Uncertainty: {r['uncertainty']}"],
                "evidence": [evidence("scriptscholar-reference-set", r["name"])], "confidence": 0.4 if r["decipherment"] == "undeciphered" else 0.8,
                "limitations": ["Only one script was named, so this is a single-entry summary rather than a comparison."], "proposedActions": []}
    comparisons = []
    for i, a in enumerate(mentioned):
        for b in mentioned[i + 1:]:
            lineage = " Direct lineage relationship documented." if a["name"] in b["descendants"] or b["name"] in a["descendants"] else " No direct lineage documented between them."
            comparisons.append(f"{a['name']} vs {b['name']}: types {a['type']} vs {b['type']}; dates {a['approxDateRange']} vs {b['approxDateRange']}; decipherment {a['decipherment']} vs {b['decipherment']}.{lineage}")
    undeciphered = any(m["decipherment"] != "fully deciphered" for m in mentioned)
    return {"status": "success", "findings": [f"Compared {len(mentioned)} scripts: {', '.join(m['name'] for m in mentioned)}.", *comparisons, *[f"{m['name']} uncertainty: {m['uncertainty']}" for m in mentioned]],
            "evidence": [evidence("scriptscholar-reference-set", f"{m['name']}: {m['note']}") for m in mentioned], "confidence": 0.55 if undeciphered else 0.8,
            "limitations": ["One or more compared scripts are only partially deciphered or undeciphered; claims about them are necessarily tentative."] if undeciphered else ["Comparison uses a curated reference set and standard dating ranges, which have some scholarly margin of error."],
            "proposedActions": []}
