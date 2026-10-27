"""JavaScript number semantics for MathPilot, so a check gives the same verdict in both engines: division by
zero is ±Infinity (not an error), (-8) ** (1/3) is NaN (not a complex number), log(0) is -Infinity, overflow is
Infinity, floor(Infinity) is Infinity, and Number.prototype.toPrecision's formatting."""
from __future__ import annotations

import math
from decimal import ROUND_HALF_UP, Decimal

INF, NAN = math.inf, math.nan


def div(a: float, b: float) -> float:
    try:
        return a / b
    except ZeroDivisionError:
        if math.isnan(a) or a == 0:
            return NAN
        neg = (a < 0) != (math.copysign(1, b) < 0)
        return -INF if neg else INF


def mod(a: float, b: float) -> float:
    """JavaScript %: the sign of the dividend."""
    if b == 0 or math.isinf(a) or math.isnan(a) or math.isnan(b):
        return NAN
    if math.isinf(b):
        return a
    return math.fmod(a, b)


def pow_(a: float, b: float) -> float:
    if math.isnan(b):
        return NAN
    if b == 0:
        return 1.0
    if math.isnan(a):
        return NAN
    if abs(a) == 1 and math.isinf(b):
        return NAN
    try:
        r = math.pow(a, b)
    except OverflowError:
        odd = float(b).is_integer() and int(b) % 2 == 1
        return -INF if a < 0 and odd else INF
    except ValueError:
        if a == 0 and b < 0:
            odd = float(b).is_integer() and int(b) % 2 == 1
            return -INF if (math.copysign(1, a) < 0 and odd) else INF
        return NAN
    return r


def _safe(fn):
    def wrapped(*args):
        try:
            return fn(*args)
        except (ValueError, OverflowError, TypeError):
            return NAN
    return wrapped


def log(x: float) -> float:
    if math.isnan(x) or x < 0:
        return NAN
    if x == 0:
        return -INF
    return math.log(x) if not math.isinf(x) else INF


def log10(x: float) -> float:
    if math.isnan(x) or x < 0:
        return NAN
    if x == 0:
        return -INF
    return math.log10(x) if not math.isinf(x) else INF


def log2(x: float) -> float:
    if math.isnan(x) or x < 0:
        return NAN
    if x == 0:
        return -INF
    return math.log2(x) if not math.isinf(x) else INF


def exp(x: float) -> float:
    try:
        return math.exp(x)
    except OverflowError:
        return INF


def sinh(x: float) -> float:
    try:
        return math.sinh(x)
    except OverflowError:
        return INF if x > 0 else -INF


def cosh(x: float) -> float:
    try:
        return math.cosh(x)
    except OverflowError:
        return INF


def floor(x: float) -> float:
    return x if not math.isfinite(x) else float(math.floor(x))


def ceil(x: float) -> float:
    return x if not math.isfinite(x) else float(math.ceil(x))


def js_round(x: float) -> float:
    """Math.round: halves round up (toward +Infinity)."""
    if not math.isfinite(x):
        return x
    r = float(math.floor(x + 0.5))
    return -0.0 if r == 0 and (x < 0 or math.copysign(1, x) < 0) else r


def sqrt(x: float) -> float:
    if math.isnan(x) or x < 0:
        return NAN
    return math.sqrt(x)


def js_min(*xs: float) -> float:
    if any(math.isnan(x) for x in xs):
        return NAN
    return min(xs) if xs else INF


def js_max(*xs: float) -> float:
    if any(math.isnan(x) for x in xs):
        return NAN
    return max(xs) if xs else -INF


sin, cos, tan = _safe(math.sin), _safe(math.cos), _safe(math.tan)
asin, acos, atan = _safe(math.asin), _safe(math.acos), _safe(math.atan)
tanh, cbrt = _safe(math.tanh), _safe(math.cbrt)


def is_integer(x: float) -> bool:
    return isinstance(x, (int, float)) and math.isfinite(x) and float(x).is_integer()


def to_precision(x: float, p: int) -> str:
    """Number.prototype.toPrecision(p)."""
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0" if p == 1 else "0." + "0" * (p - 1)
    sign = "-" if x < 0 else ""
    d = Decimal(abs(x))
    e = d.adjusted()
    q = d.scaleb(-e).quantize(Decimal(1).scaleb(-(p - 1)), rounding=ROUND_HALF_UP)
    if q >= 10:  # rounding carried into a new digit (9.99 -> 10.0)
        e += 1
        q = (q / 10).quantize(Decimal(1).scaleb(-(p - 1)), rounding=ROUND_HALF_UP)
    digits = str(q).replace(".", "")
    if e < -6 or e >= p:
        mant = digits[0] + ("." + digits[1:] if p > 1 else "")
        return f"{sign}{mant}e{'+' if e >= 0 else '-'}{abs(e)}"
    if e >= 0:
        whole, frac = digits[:e + 1], digits[e + 1:]
        return sign + whole + ("." + frac if frac else "")
    return sign + "0." + "0" * (-e - 1) + digits
