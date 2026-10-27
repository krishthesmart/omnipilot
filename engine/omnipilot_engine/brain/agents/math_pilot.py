"""MathPilot: checks identities you give it (numerically, never by guessing; the AI model only explains a
verdict that's already computed, and an explanation contradicting it is dropped), teaches mental-math tricks
worked on your numbers, and reports its always-on search for new constant formulas. The search itself still
runs in the TypeScript engine (a CPU-heavy loop) and saves its findings to the shared database.
(Ported from server/src/agents/mathPilot.ts.)"""
from __future__ import annotations

import json
import os
import re
import time

import httpx

from ... import llm, store
from ..mathpilot import expr, tricks
from .base import evidence, model_limitation
from .jsfmt import js_round

F = re.I | re.A
ASKS_FOR_RESULTS = re.compile(r"\b(found|find(ings)?|discover\w*|results?|progress|status|search(ing)?|running|new (identit|formula)\w*|latest|so far)\b", F)
TRICK_INTENT = re.compile(r"\b(math|maths|mental[- ]math|multiplication|number|arithmetic|calculation|division|divisibility) (trick|shortcut|hack)s?\b|\btricks?\b|\bmental math\b|\bshortcut\b|\bquick(ly| way)\b[^.?!]*\b(multiply|square|work out|calculate|times|divide)|\bin your head\b", F)
CONSTANT_NAMES = {"π": "pi", "e": "Euler's number e", "ln2": "the natural log of 2", "ζ(3)": "Apéry's constant ζ(3)", "G": "Catalan's constant G", "√2": "the square root of 2", "φ": "the golden ratio φ", "π²": "pi squared"}
SUP = {"2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶"}


def poly_text(c: list[int]) -> str:
    terms = []
    for i in range(len(c) - 1, -1, -1):
        k = c[i]
        if k == 0:
            continue
        mag = abs(k)
        v = f"{mag}" if i == 0 else f"{'' if mag == 1 else mag}n{SUP.get(str(i), f'^{i}') if i > 1 else ''}"
        terms.append((f"−{v}" if k < 0 else v) if not terms else f"{'−' if k < 0 else '+'} {v}")
    return " ".join(terms) or "0"


SEARCH_LEVELS = [(1, 2, 3), (1, 2, 5), (2, 4, 2), (2, 4, 3), (1, 3, 4), (3, 6, 2), (1, 2, 9), (2, 4, 4), (1, 3, 6), (2, 4, 5), (3, 6, 3), (2, 4, 6)]  # (deg a, deg b, range), as in discovery.ts


def _has_table(name: str) -> bool:
    return store.q1("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name) is not None


def discoveries(limit: int = 5) -> list[dict]:
    rows = store.q("SELECT * FROM math_discoveries ORDER BY id DESC LIMIT ?", limit) if _has_table("math_discoveries") else []
    return [{**r, "a": json.loads(r["a_coeffs"]), "b": json.loads(r["b_coeffs"])} for r in rows]


def discoveries_markdown(limit: int = 5) -> str:
    found = discoveries(limit)
    if not found:
        return "Nothing verified yet. The search has only just started; check back in a few minutes."
    return "\n".join(f"- **{d['text'].split('   [')[0]}**\n  involves {CONSTANT_NAMES.get(d['constant'], d['constant'])}; verified to {d['digits']} digits; a(n) = {poly_text(d['a'])}, b(n) = {poly_text(d['b'])}"
                     + (f"; {d['variants'] - 1} related formula(s) found too" if d["variants"] > 1 else "") for d in found)


async def math_status() -> dict:
    """The search's status from the TypeScript engine that runs it; from its saved state if it can't be reached."""
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(f"{os.environ.get('OMNIPILOT_NODE_URL', 'http://127.0.0.1:8898')}/api/math/status",
                            headers={"x-omnipilot-internal": os.environ.get("OMNIPILOT_INTERNAL_TOKEN", ""), "x-omnipilot-client-local": "1"})
        if r.status_code == 200:
            return r.json()
    except httpx.HTTPError:
        pass
    row = store.q1("SELECT data FROM math_state WHERE id = 1") if _has_table("math_state") else None
    st = json.loads(row["data"]) if row else {"cursor": {"level": 0, "index": 0}, "checked": 0, "paused": False}
    finished = st["cursor"]["level"] >= len(SEARCH_LEVELS)
    da, db, rng = SEARCH_LEVELS[min(st["cursor"]["level"], len(SEARCH_LEVELS) - 1)]
    size = (2 * rng + 1) ** (da + db + 2)
    return {"running": False, "paused": st["paused"], "finished": finished, "enabled": os.environ.get("MATHPILOT") != "off", "checked": st["checked"], "perSecond": 0,
            "stage": len(SEARCH_LEVELS) if finished else st["cursor"]["level"] + 1, "stages": len(SEARCH_LEVELS), "stageProgress": 1 if finished else st["cursor"]["index"] / size,
            "stageLabel": f"a(n) degree {da}, b(n) degree {db}, coefficients ±{rng}", "discoveries": store.q1("SELECT COUNT(*) AS n FROM math_discoveries")["n"] if _has_table("math_discoveries") else 0}


def status_line(s: dict) -> str:
    state = ("is turned off on this computer (MATHPILOT=off)" if not s["enabled"] else "has finished every search stage" if s["finished"] else "is paused" if s["paused"] else "is running in the background")
    return f"The search {state}: {s['checked']:,} formulas checked so far, {s['discoveries']} verified identities found, now on stage {s['stage']} of {s['stages']} ({s['stageLabel']}, {js_round(s['stageProgress'] * 100):.0f}% done)."


def tidy_explanation(text: str) -> str:
    plain = re.sub(r"\$\$?([^$]+)\$\$?", r"`\1`", re.sub(r"\\\[\s*|\s*\\\]", "`", re.sub(r"\\\(\s*|\s*\\\)", "`", text)))
    m = re.match(r"^[\s\S]*[.!?](?=\s|$)", plain)
    return (m.group(0) if m else plain).strip()


def math_tricks(input: dict) -> dict:
    text = input["requestText"]
    applied = tricks.apply_trick(text)
    if applied:
        t = applied["trick"]
        action = t["id"]
        findings = [f"**Trick: {t['name']}**\n{t['how']}\n\n" + "\n".join(f"{i + 1}. {s}" for i, s in enumerate(applied["steps"])) + f"\n\n**Answer: {tricks.fmt(applied['answer'])}** (checked exactly)."]
    elif re.search(r"\bdivisib|\bdivisible\b", text, F):
        action, findings = "divisibility", [tricks.divisibility_text()]
    elif re.search(r"\b(all|list|every|some|more)\b[^.?!]*\btricks?\b", text, F):
        action = "list"
        findings = ["**Mental-math tricks**\n" + "\n".join(f"- **{t['name']}**: {t['example']}" for t in tricks.TRICKS)
                    + "\n\nGive me numbers (like \"34 × 11\" or \"65 squared\") and I'll show the trick step by step. Ask for \"divisibility tricks\" too."]
    else:
        named = tricks.tricks_named(text)
        pick = named[0] if named else tricks.TRICKS[int(time.time()) % len(tricks.TRICKS)]
        action = pick["id"] if named else "random"
        findings = [f"{tricks.trick_card(pick)}\n\nTry it: give me your own numbers and I'll work it with you, or ask for \"all math tricks\"."]
    store.audit(input["runId"], "ScienceLab", "math_trick", {"trick": action}, "completed")
    return {"status": "success", "findings": findings, "evidence": [evidence("mathpilot-tricks", "worked and checked with exact arithmetic" if applied else "built-in trick library")],
            "confidence": 0.95, "limitations": [], "proposedActions": []}


async def run(input: dict, ctx: dict) -> dict:
    text = input["requestText"]
    if TRICK_INTENT.search(text):
        return math_tricks(input)
    eq = expr.extract_equation(text)
    if eq:
        try:
            check = expr.check_identity(eq["left"], eq["right"])
        except Exception as err:  # noqa: BLE001 -- unreadable math
            return {"status": "partial_success", "findings": [f"I couldn't read that as math ({err}). Try writing it like `sin(x)^2 + cos(x)^2 = 1` or `sum(1/n^2, n, 1, inf) = pi^2/6`."],
                    "evidence": [], "confidence": 0.2, "limitations": [], "proposedActions": []}
        store.audit(input["runId"], "ScienceLab", "check_identity", {"left": eq["left"], "right": eq["right"]}, check["verdict"])
        headline = {"true": "✅ **True**", "false": "❌ **Not true**", "unclear": "⚠️ **Can't tell**"}[check["verdict"]]
        findings = [f"{headline}: `{eq['left']} = {eq['right']}`\n\n{check['detail']}"]
        if check["verdict"] != "unclear":
            why = await llm.generate_text("You are ScienceLab's math checker, a friendly math tutor. A numerical check has already decided whether the statement is true. Never contradict that verdict. In 2-3 short sentences explain WHY, for a student. If it's false, name the correct version if there's a well-known one.",
                                          f"Statement: {eq['left']} = {eq['right']}\nVerdict: {'TRUE' if check['verdict'] == 'true' else 'FALSE'}\nCheck details: {check['detail']}", max_tokens=160, temperature=0.2)
            contra = r"\b(is not true|isn't true|is false|not an identity)\b" if check["verdict"] == "true" else r"\b(is true|holds for all|is an identity)\b"
            if why and not re.search(contra, why, F):
                findings.append(f"**Why:** {tidy_explanation(why)}")
        return {"status": "partial_success" if check["verdict"] == "unclear" else "success", "findings": findings,
                "evidence": [evidence("mathpilot:numeric-check", f"{check['pointsTested']} test points" if check.get("pointsTested") else f"{check.get('digits') or 0} matching digits")],
                "confidence": 0.3 if check["verdict"] == "unclear" else 0.97 if check["verdict"] == "false" else 0.9 if check.get("pointsTested") else 0.95,
                "limitations": ["A counterexample proves it's not an identity." if check["verdict"] == "false" else "A numerical check is strong evidence, not a proof.", *([model_limitation()] if len(findings) > 1 else [])],
                "proposedActions": []}
    s = await math_status()
    wants = bool(ASKS_FOR_RESULTS.search(text))
    return {"status": "success",
            "findings": ([] if wants else ["ScienceLab's math checks do two things: it **checks identities** you give it (try \"is sin(x)^2 + cos(x)^2 = 1?\"), and it **searches for new formulas** for famous constants like π, e and ζ(3) all the time in the background."])
            + [status_line(s), f"**Latest verified identities**\n{discoveries_markdown()}",
               "Each one is a continued fraction that matches the constant to at least 20 digits at high precision. That makes it a strong conjecture, not a proof, and many turn out to be already known. Ask me for the latest discoveries any time."],
            "evidence": [evidence("mathpilot:search", f"{s['checked']} candidates checked")], "confidence": 0.9,
            "limitations": ["Discoveries are numerically verified conjectures; novelty isn't checked against the published literature."], "proposedActions": []}
