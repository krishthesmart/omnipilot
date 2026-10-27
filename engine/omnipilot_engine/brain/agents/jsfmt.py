"""Numbers written the way the TypeScript agents write them, so ported agents give identical answers:
JavaScript's String(n) / JSON.stringify (no ".0" on whole numbers, exponents only outside 1e-6..1e21) and
Math.round (halves round up, unlike Python's round-half-to-even)."""
from __future__ import annotations

import json
import math
from decimal import Decimal


def js_round(x: float) -> float:
    return math.floor(x + 0.5)


def round2(x: float) -> float:
    return js_round(x * 100) / 100


def js_str(x) -> str:
    if isinstance(x, bool):
        return "true" if x else "false"
    if x is None:
        return "null"
    if isinstance(x, int):
        return str(x)
    if isinstance(x, float):
        if math.isnan(x):
            return "NaN"
        if math.isinf(x):
            return "Infinity" if x > 0 else "-Infinity"
        if x == 0:
            return "0"
        if x.is_integer() and abs(x) < 1e21:
            return str(int(x))
        r = repr(x)  # shortest round-trip digits, like JavaScript
        if "e" not in r:
            return r
        if 1e-6 <= abs(x) < 1e21:
            return format(Decimal(r), "f")
        mant, exp = r.split("e")
        return f"{mant}e{'+' if int(exp) > 0 else '-'}{abs(int(exp))}"
    return str(x)


def js_json(v) -> str:
    """JSON.stringify(v) for plain data."""
    if isinstance(v, dict):
        return "{" + ",".join(f"{json.dumps(k)}:{js_json(x)}" for k, x in v.items()) + "}"
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(js_json(x) for x in v) + "]"
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return "null"
    if isinstance(v, (int, float, bool)) or v is None:
        return js_str(v)
    return json.dumps(v, ensure_ascii=False)


JS_SPACE = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"  # JavaScript's \s, for character classes
JS_S = f"[{JS_SPACE}]"
JS_NOT_S = f"[^{JS_SPACE}]"


def to_fixed(x: float, digits: int) -> str:
    """Number.prototype.toFixed: exact halves round away from zero (Python's format rounds them to even)."""
    from decimal import ROUND_HALF_UP

    return str(Decimal(x).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))
