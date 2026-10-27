"""Mental-math tricks: each knows when it fits the numbers in a request, works the example step by step, and
is checked against exact arithmetic, so a trick is never shown with a wrong answer. No AI model.
(Ported from server/src/lib/math/tricks.ts.)"""
from __future__ import annotations

import re

from ..agents.jsfmt import js_round, js_str

F = re.I | re.A


def _digits(n: float) -> list[int]:
    return [int(c) for c in js_str(n)]


def _is_int(n) -> bool:
    return n is not None and float(n).is_integer() and n >= 0


s = js_str


def _times11(a, b):
    n = a if b == 11 else b if a == 11 else None
    if n is None or not _is_int(n) or n < 10 or n > 99:
        return None
    x, y = _digits(n)
    mid = x + y
    third = f"Put {mid} in the middle: {x}{mid}{y}." if mid < 10 else f"{mid} is 10 or more, so write {mid % 10} in the middle and carry 1 onto the {x}: {x + 1}{mid % 10}{y}."
    return {"steps": [f"Split {s(n)} into {x} and {y}.", f"Add them: {x} + {y} = {mid}.", third], "answer": n * 11}


def _square5(a, b):
    if (b is not None and b != a and b != 2) or not _is_int(a) or a % 10 != 5 or a < 15 or a > 995:
        return None
    t = (a - 5) / 10
    return {"steps": [f"Drop the 5: {s(t)}.", f"Multiply by the next number up: {s(t)} × {s(t + 1)} = {s(t * (t + 1))}.", f"Write 25 after it: {s(t * (t + 1))}25."], "answer": a * a}


def _near_round(a, b):
    if b is None or not _is_int(a) or not _is_int(b) or a == b or (a + b) % 2 != 0:
        return None
    r, d = (a + b) / 2, abs(a - b) / 2
    if r % 10 != 0 or d > 9:
        return None
    return {"steps": [f"Both are {s(d)} away from {s(r)}: {s(min(a, b))} = {s(r)} − {s(d)} and {s(max(a, b))} = {s(r)} + {s(d)}.", f"{s(r)}² = {s(r * r)} and {s(d)}² = {s(d * d)}.", f"{s(r * r)} − {s(d * d)} = {s(r * r - d * d)}."], "answer": a * b}


def _near100(a, b):
    if b is None or not _is_int(a) or not _is_int(b) or a < 90 or b < 90 or a > 99 or b > 99:
        return None
    da, db = 100 - a, 100 - b
    front = a - db
    return {"steps": [f"{s(a)} is {s(da)} below 100 and {s(b)} is {s(db)} below 100.", f"{s(a)} − {s(db)} = {s(front)} (the first part).", f"{s(da)} × {s(db)} = {s(da * db)} (the last two digits): {s(front)}{s(da * db).rjust(2, '0')}."], "answer": a * b}


def _times(k, name10):
    def apply(a, b):
        n = a if b == k else b if a == k else None
        if n is None or not _is_int(n) or n < (4 if k == 25 else 10):
            return None
        if k == 5:
            return {"steps": [f"{s(n)} × 10 = {s(n * 10)}.", f"Halve it: {s(n * 10)} ÷ 2 = {s(n * 5)}."], "answer": n * 5}
        if k == 9:
            return {"steps": [f"{s(n)} × 10 = {s(n * 10)}.", f"Subtract {s(n)}: {s(n * 10)} − {s(n)} = {s(n * 9)}."], "answer": n * 9}
        return {"steps": [f"{s(n)} × 100 = {s(n * 100)}.", f"Divide by 4: {s(n * 100)} ÷ 4 = {s(n * 25)}."], "answer": n * 25}
    return apply


def _halve_double(a, b):
    if b is None or not _is_int(a) or not _is_int(b):
        return None
    x, y = (a, b) if a % 2 == 0 else (b, a)
    if x % 2 != 0 or y % 5 != 0 or x < 4:
        return None
    steps = []
    while x % 2 == 0 and y % 10 != 0 and len(steps) < 4:
        steps.append(f"Halve {s(x)} and double {s(y)}: {s(x / 2)} × {s(y * 2)}.")
        x, y = x / 2, y * 2
    if not steps:
        return None
    steps.append(f"{s(x)} × {s(y)} = {s(x * y)}.")
    return {"steps": steps, "answer": a * b}


def _percent_swap(a, b):
    if b is None or not _is_int(a) or not _is_int(b) or a == b:
        return None
    easy = [10, 20, 25, 50, 100, 200]
    if b not in easy or a in easy:
        return None
    return {"steps": [f"{s(a)}% of {s(b)} is the same as {s(b)}% of {s(a)}.", f"{s(b)}% of {s(a)} = {s((b * a) / 100)}."], "answer": (a * b) / 100}


def _from1000(a, b):
    if a != 1000 or b is None or not _is_int(b) or b < 100 or b > 999 or b % 10 == 0:
        return None
    x, y, z = _digits(b)
    return {"steps": [f"9 − {x} = {9 - x}, 9 − {y} = {9 - y}, 10 − {z} = {10 - z}.", f"Together: {9 - x}{9 - y}{10 - z}."], "answer": 1000 - b}


TRICKS = [
    {"id": "times11", "name": "Multiply a two-digit number by 11", "how": "Split the digits apart and put their sum in the middle. If the sum is 10 or more, carry the 1 to the first digit.",
     "example": "34 × 11: 3 _ 4, and 3 + 4 = 7 goes in the middle: 374.", "names": r"\b(by|times|x|×)\s*11\b|\b11\s*(×|x|times)", "apply": _times11},
    {"id": "square5", "name": "Square a number ending in 5", "how": "Take the digits before the 5, multiply them by the next number up, then write 25 after it.",
     "example": "65²: 6 × 7 = 42, then 25: 4225.", "names": r"\bend(s|ing)? in (a )?5\b|\bsquar(e|ing)\b[^.?!]*\b5\b", "apply": _square5},
    {"id": "nearRound", "name": "Multiply two numbers the same distance from a round number", "how": "If the numbers are r − d and r + d, the product is r² − d² (difference of squares).",
     "example": "48 × 52 = (50 − 2)(50 + 2) = 2500 − 4 = 2496.", "names": r"\bdifference of squares\b|\bsame distance\b", "apply": _near_round},
    {"id": "near100", "name": "Multiply two numbers just under 100", "how": "Find how far each is below 100. Subtract one distance from the other number for the first two digits; multiply the distances for the last two.",
     "example": "97 × 96: 3 and 4 below 100. 97 − 4 = 93, 3 × 4 = 12: 9312.", "names": r"\bnear 100\b|\bclose to 100\b|\bunder 100\b", "apply": _near100},
    {"id": "times5", "name": "Multiply by 5", "how": "Multiply by 10, then halve it (5 is half of 10).", "example": "68 × 5: 680 ÷ 2 = 340.", "names": r"\b(by|times|x|×)\s*5\b(?!\d)", "apply": _times(5, True)},
    {"id": "times9", "name": "Multiply by 9", "how": "Multiply by 10, then subtract the number once (9 is one less than 10).", "example": "47 × 9: 470 − 47 = 423.", "names": r"\b(by|times|x|×)\s*9\b(?!\d)", "apply": _times(9, True)},
    {"id": "times25", "name": "Multiply by 25", "how": "Multiply by 100, then divide by 4 (25 is a quarter of 100).", "example": "36 × 25: 3600 ÷ 4 = 900.", "names": r"\b(by|times|x|×)\s*25\b", "apply": _times(25, False)},
    {"id": "halveDouble", "name": "Halve one number and double the other", "how": "The product doesn't change if you halve one factor and double the other. Keep going until it's easy.",
     "example": "16 × 35 = 8 × 70 = 560.", "names": r"\bhalv(e|ing)\b|\bdoubl(e|ing)\b", "apply": _halve_double},
    {"id": "percentSwap", "name": "Swap a percentage", "how": "x% of y is the same as y% of x, so pick whichever is easier.", "example": "8% of 50 = 50% of 8 = 4.", "names": r"\bpercent(age)?\b|%", "apply": _percent_swap},
    {"id": "from1000", "name": "Subtract from 1000", "how": "Take every digit from 9, except the last one, which you take from 10.", "example": "1000 − 372: 9−3, 9−7, 10−2 → 628.",
     "names": r"\b1000\s*(−|-|minus)\b|\bsubtract(ing)? from 1000\b", "apply": _from1000},
]
DIVISIBILITY = ["**By 2:** the last digit is even.", "**By 3:** the digits add up to a multiple of 3 (372: 3 + 7 + 2 = 12, so yes).", "**By 4:** the last two digits make a multiple of 4 (1,316: 16, so yes).",
                "**By 5:** it ends in 0 or 5.", "**By 6:** it passes the tests for 2 and for 3.", "**By 9:** the digits add up to a multiple of 9.", "**By 10:** it ends in 0.",
                "**By 11:** alternately add and subtract the digits; the result is a multiple of 11 (918,082: 9−1+8−0+8−2 = 22, so yes)."]


def numbers_in(text: str) -> dict | None:
    t = re.sub(r",(?=\d{3})", "", text)
    N = r"(\d+(?:\.\d+)?)"
    sq = re.search(rf"{N}\s*(?:²|\^2|squared)", t, F) or re.search(r"\bsquare (?:of )?(\d+)", t, F)
    if sq:
        return {"a": float(sq.group(1)), "b": float(sq.group(1))}
    for rx in (rf"{N}\s*%\s*of\s*{N}", rf"\bmultiply(?:ing)?\s+{N}\s+(?:by|and|with)\s+{N}", rf"{N}\s*(?:×|x|\*|times|multiplied by|−|-|minus)\s*{N}"):
        if m := re.search(rx, t, F):
            return {"a": float(m.group(1)), "b": float(m.group(2))}
    return None


def tricks_named(text: str) -> list[dict]:
    return [t for t in TRICKS if re.search(t["names"], text, F)]


def fmt(n: float) -> str:
    return f"{int(n):,}" if float(n).is_integer() else js_str(js_round(n * 1e6) / 1e6)


def apply_trick(text: str) -> dict | None:
    nums = numbers_in(text)
    if not nums:
        return None
    named = tricks_named(text)
    order = named + [t for t in TRICKS if t not in named]
    is_sub = bool(re.search(r"(−|-|minus)", text)) and nums["a"] == 1000
    for trick in order:
        if is_sub != (trick["id"] == "from1000"):
            continue
        r = trick["apply"](nums["a"], nums["b"])
        if not r:
            continue
        b = nums["b"] if nums["b"] is not None else 0
        exact = nums["a"] - b if trick["id"] == "from1000" else (nums["a"] * b) / 100 if trick["id"] == "percentSwap" else nums["a"] * (nums["b"] if nums["b"] is not None else nums["a"])
        if abs(r["answer"] - exact) > 1e-9:
            continue
        return {"trick": trick, **r}
    return None


def divisibility_text() -> str:
    return "**Divisibility tricks**\n" + "\n".join(f"- {d}" for d in DIVISIBILITY)


def trick_card(t: dict) -> str:
    return f"**{t['name']}**\n{t['how']}\n\nExample: {t['example']}"
