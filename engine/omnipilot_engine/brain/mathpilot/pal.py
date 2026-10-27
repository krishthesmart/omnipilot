"""Program-aided answers for word problems: the model writes the calculation as steps ("total = price * 3")
and OmniPilot runs them exactly, so the arithmetic is never guessed. (Ported from server/src/lib/math/pal.ts.)"""
from __future__ import annotations

import json
import math
import re

from ..agents.jsfmt import js_round, js_str
from .expr import EvalBudget, evaluate, parse

PAL_SYSTEM = ("You solve word problems. Think briefly, then write the calculation as steps. "
              "Each step is `name = expression` using numbers and names from earlier steps, with + - * / ^ and parentheses "
              "(functions allowed: round, floor, ceil, min, max, sqrt). The last step must be `answer = ...`. "
              "Never do arithmetic in your head: write the expression and the computer will calculate it.")
PAL_SCHEMA = {"type": "object", "properties": {"reasoning": {"type": "string"}, "steps": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 16}}, "required": ["reasoning", "steps"]}
PAL_EXAMPLE = {"user": "A shirt costs $40 and is 25% off. Sam buys 3 of them. How much does Sam pay?",
               "assistant": json.dumps({"reasoning": "Each shirt is 25% off $40, so find the sale price, then multiply by 3.", "steps": ["discount = 40 * 0.25", "price = 40 - discount", "answer = price * 3"]}, separators=(",", ":"))}
STEP = re.compile(r"^\s*([a-z_][a-z0-9_]*)\s*=\s*(.+?)\s*$", re.I | re.S)


def run_steps(steps: list[str]) -> dict | None:
    env: dict[str, float] = {}
    trace = []
    budget = EvalBudget(2_000_000)
    for i, raw in enumerate(steps):
        m = STEP.match(re.sub(r"(\d),(?=\d{3}\b)", r"\1", re.sub(r"[`$]", "", raw)))
        name = m.group(1).lower() if m else ("answer" if i == len(steps) - 1 else None)
        expression = m.group(2) if m else raw
        if not name:
            return None
        try:
            value = evaluate(parse(expression, set(env)), env, budget)
        except Exception:  # noqa: BLE001 -- an unreadable step
            return None
        if not math.isfinite(value):
            return None
        env[name] = value
        trace.append({"name": name, "expression": expression, "value": value})
    return {"value": trace[-1]["value"], "trace": trace} if trace else None


def format_number(x: float) -> str:
    if abs(x - js_round(x)) < 1e-9:
        return js_str(js_round(x))
    return js_str(js_round(x * 10_000) / 10_000)


def is_word_problem(text: str) -> bool:
    numbers = len(re.findall(r"\d+(\.\d+)?", text)) + len(re.findall(r"\b(half|twice|double|triple|third|quarter|dozen|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand)\b", text, re.I))
    return numbers >= 2 and bool(re.search(r"\b(how (many|much|long|far|old)|what (is|was|will)|total|left|remain\w*|each|per|altogether|cost|pay|earn|percent|%|average|times)\b", text, re.I))
