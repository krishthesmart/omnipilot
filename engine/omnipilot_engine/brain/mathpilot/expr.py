"""A small, safe math-expression parser for MathPilot's identity checker ("is sin(x)^2 + cos(x)^2 = 1?"). It
builds a tree and evaluates it (never eval()), with + − × ÷ ^ !, implicit multiplication (2x, 3π), the usual
functions, and sum()/prod() over a range, including infinite sums by Richardson extrapolation. Trees are
compiled to Python closures once, so a 400,000-term infinite sum stays fast. Same parser, step budget and
answers as server/src/lib/math/expr.ts."""
from __future__ import annotations

import math
import re

from ..agents.jsfmt import JS_S, js_str
from . import jsmath as J

CONSTS = {"pi": math.pi, "e": math.e, "phi": (1 + math.sqrt(5)) / 2, "tau": 2 * math.pi, "inf": math.inf, "infinity": math.inf}


def gamma(x: float) -> float:
    if x < 0.5:
        return J.div(math.pi, J.sin(math.pi * x) * gamma(1 - x))
    g = 7
    c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
    x -= 1
    a = c[0]
    t = x + g + 0.5
    for i in range(1, g + 2):
        a += J.div(c[i], x + i)
    return math.sqrt(2 * math.pi) * J.pow_(t, x + 0.5) * J.exp(-t) * a


def factorial(n: float) -> float:
    if J.is_integer(n) and n > 170:
        return math.inf
    if J.is_integer(n) and n >= 0:
        r = 1.0
        for i in range(2, int(n) + 1):
            r *= i
        return r
    return gamma(n + 1)


FNS = {
    "sin": J.sin, "cos": J.cos, "tan": J.tan, "asin": J.asin, "acos": J.acos, "atan": J.atan, "arcsin": J.asin, "arccos": J.acos, "arctan": J.atan,
    "sinh": J.sinh, "cosh": J.cosh, "tanh": J.tanh,
    "sec": lambda x: J.div(1, J.cos(x)), "csc": lambda x: J.div(1, J.sin(x)), "cot": lambda x: J.div(1, J.tan(x)),
    "exp": J.exp, "ln": J.log, "log": J.log, "log10": J.log10, "log2": J.log2,
    "sqrt": J.sqrt, "cbrt": J.cbrt, "abs": abs, "floor": J.floor, "ceil": J.ceil,
    "round": lambda x, digits=0, *_: J.div(J.js_round(x * J.pow_(10, digits)), J.pow_(10, digits)),
    "min": J.js_min, "max": J.js_max, "mod": lambda a, b, *_: J.mod(J.mod(a, b) + b, b),
    "gamma": lambda x, *_: gamma(x),
    "binom": lambda n, k, *_: J.div(gamma(n + 1), gamma(k + 1) * gamma(n - k + 1)),
    "choose": lambda n, k, *_: J.div(gamma(n + 1), gamma(k + 1) * gamma(n - k + 1)),
}
ARITY = {"round": (1, 2), "min": (1, 99), "max": (1, 99), "mod": (2, 2), "binom": (2, 2), "choose": (2, 2)}


def normalize_math(s: str) -> str:
    for a, b in ((r"[−–—]", "-"), (r"[×·∙]", "*"), (r"÷", "/"), (r"π", "pi"), (r"φ", "phi"), (r"∞", "inf")):
        s = re.sub(a, b, s)
    s = re.sub(rf"√{JS_S}*\(", "sqrt(", s)
    s = re.sub(rf"√{JS_S}*([a-z0-9.]+)", r"sqrt(\1)", s, flags=re.I)
    s = s.replace("²", "^2").replace("³", "^3").replace("**", "^")
    s = re.sub(r"\bsquare root of\b", "sqrt", s, flags=re.I | re.A)
    return s.strip("\t\n\v\f\r                  　﻿")


NUM = re.compile(r"(\d+\.?\d*|\.\d+)(e[+-]?\d+)?", re.I | re.A)
ID = re.compile(r"[a-z_][a-z0-9_]*", re.I | re.A)


def tokenize(src: str) -> list[tuple[str, object]]:
    out, i = [], 0
    while i < len(src):
        ch = src[i]
        if re.match(JS_S, ch):
            i += 1
            continue
        if m := NUM.match(src, i):
            out.append(("num", float(m.group(0))))
            i = m.end()
            continue
        if m := ID.match(src, i):
            out.append(("id", m.group(0).lower()))
            i = m.end()
            continue
        if ch in "+-*/^(),!":
            out.append(("op", ch))
            i += 1
            continue
        raise ValueError(f'I can\'t read "{ch}" in that expression')
    return out


def split_identifier(id: str, known) -> list[str]:
    if known(id) or len(id) == 1 or re.search(r"[\d_]", id):
        return [id]
    for n in range(len(id) - 1, 0, -1):
        head = id[:n]
        if known(head) or n == 1:
            return [head, *split_identifier(id[n:], known)]
    return [id]


MAX_TERMS, MAX_DEPTH = 2_000_000, 250


def parse(text: str, names: set[str] | None = None) -> tuple:
    names = names or set()
    known = lambda s: s in names or s in CONSTS or s in FNS or s in ("sum", "prod")
    toks = []
    for t in tokenize(normalize_math(text)):
        toks += [("id", v) for v in split_identifier(t[1], known)] if t[0] == "id" else [t]
    st = {"pos": 0, "depth": 0}

    def enter():
        st["depth"] += 1
        if st["depth"] > MAX_DEPTH:
            raise ValueError("that expression is nested too deeply")

    peek = lambda: toks[st["pos"]] if st["pos"] < len(toks) else None
    is_op = lambda v: (p := peek()) is not None and p[0] == "op" and p[1] == v

    def expect(v):
        if not is_op(v):
            raise ValueError(f'expected "{v}"')
        st["pos"] += 1

    def expr():
        enter()
        left = term()
        while is_op("+") or is_op("-"):
            op = toks[st["pos"]][1]
            st["pos"] += 1
            left = ("bin", op, left, term())
        st["depth"] -= 1
        return left

    def term():
        left = unary()
        while True:
            if is_op("*") or is_op("/"):
                op = toks[st["pos"]][1]
                st["pos"] += 1
                left = ("bin", op, left, unary())
            elif (p := peek()) is not None and (p[0] in ("num", "id") or is_op("(")):
                left = ("bin", "*", left, unary())
            else:
                return left

    def unary():
        enter()
        try:
            if is_op("-"):
                st["pos"] += 1
                return ("neg", unary())
            if is_op("+"):
                st["pos"] += 1
                return unary()
            return power()
        finally:
            st["depth"] -= 1

    def power():
        base = postfix()
        if is_op("^"):
            st["pos"] += 1
            return ("bin", "^", base, unary())
        return base

    def postfix():
        n = atom()
        while is_op("!"):
            st["pos"] += 1
            n = ("fact", n)
        return n

    def atom():
        t = peek()
        if t is None:
            raise ValueError("the expression ends too early")
        if t[0] == "num":
            st["pos"] += 1
            return ("num", t[1])
        if is_op("("):
            st["pos"] += 1
            e = expr()
            expect(")")
            return e
        if t[0] == "id":
            st["pos"] += 1
            v = t[1]
            if v in ("sum", "prod"):
                expect("(")
                body = expr()
                expect(",")
                idx = peek()
                if not idx or idx[0] != "id":
                    raise ValueError(f"{v}(expression, n, from, to) needs an index letter")
                st["pos"] += 1
                expect(",")
                frm = expr()
                expect(",")
                to = expr()
                expect(")")
                return ("agg", v, body, idx[1], frm, to)
            if v in FNS:
                if is_op("("):
                    st["pos"] += 1
                    args = [expr()]
                    while is_op(","):
                        st["pos"] += 1
                        args.append(expr())
                    expect(")")
                    return ("call", v, args)
                return ("call", v, [power()])
            if v in CONSTS and v not in names:
                return ("num", CONSTS[v])
            return ("var", v)
        raise ValueError(f'unexpected "{js_str(t[1]) if t[0] == "num" else t[1]}"')

    tree = expr()
    if st["pos"] < len(toks):
        t = toks[st["pos"]]
        raise ValueError(f'unexpected "{js_str(t[1]) if t[0] == "num" else t[1]}"')
    return tree


def variables(n: tuple, bound: frozenset = frozenset()) -> list[str]:
    out: dict[str, None] = {}

    def walk(x, b):
        k = x[0]
        if k == "var":
            if x[1] not in b:
                out.setdefault(x[1])
        elif k in ("neg", "fact"):
            walk(x[1], b)
        elif k == "bin":
            walk(x[2], b)
            walk(x[3], b)
        elif k == "call":
            for a in x[2]:
                walk(a, b)
        elif k == "agg":
            walk(x[4], b)
            walk(x[5], b)
            walk(x[2], b | {x[3]})

    walk(n, bound)
    return list(out)


class BudgetExceeded(Exception):
    def __init__(self):
        super().__init__("that would take too much calculating")


class EvalBudget:
    def __init__(self, limit: int = 5_000_000):
        self.limit, self.used = limit, 0

    def step(self):
        self.used += 1
        if self.used > self.limit:
            raise BudgetExceeded()


def has_infinite_sum(n: tuple) -> bool:
    k = n[0]
    if k == "agg":
        to = None
        try:
            to = evaluate(n[5], {}, EvalBudget(100_000))
        except Exception:  # noqa: BLE001 -- the upper limit is a variable ("sum to n")
            pass
        return to == math.inf or has_infinite_sum(n[2])
    if k in ("neg", "fact"):
        return has_infinite_sum(n[1])
    if k == "bin":
        return has_infinite_sum(n[2]) or has_infinite_sum(n[3])
    if k == "call":
        return any(has_infinite_sum(a) for a in n[2])
    return False


def _call(fn: str, args: list[float]) -> float:
    f = FNS[fn]
    lo, hi = ARITY.get(fn, (1, 1))
    if fn in ("min", "max"):
        return f(*args)
    # JavaScript ignores extra arguments and passes undefined (-> NaN) for missing ones.
    if len(args) < lo:
        args = args + [math.nan] * (lo - len(args))
    return f(*args[:hi])


def compile_node(n: tuple, budget: EvalBudget):
    """A closure env -> value for the tree, charging one budget step per node evaluated (like the TypeScript walker)."""
    k = n[0]
    step = budget.step
    if k == "num":
        v = n[1]

        def f(env):
            step()
            return v
    elif k == "var":
        name = n[1]

        def f(env):
            step()
            if name not in env:
                raise ValueError(f"no value for {name}")
            return env[name]
    elif k == "neg":
        a = compile_node(n[1], budget)

        def f(env):
            step()
            return -a(env)
    elif k == "fact":
        a = compile_node(n[1], budget)

        def f(env):
            step()
            return factorial(a(env))
    elif k == "call":
        fn, args = n[1], [compile_node(x, budget) for x in n[2]]

        def f(env):
            step()
            return _call(fn, [g(env) for g in args])
    elif k == "bin":
        op, a, b = n[1], compile_node(n[2], budget), compile_node(n[3], budget)
        if op == "+":
            def f(env):
                step()
                return a(env) + b(env)
        elif op == "-":
            def f(env):
                step()
                return a(env) - b(env)
        elif op == "*":
            def f(env):
                step()
                x, y = a(env), b(env)
                return x * y
        elif op == "/":
            def f(env):
                step()
                x, y = a(env), b(env)
                return J.div(x, y)
        else:
            def f(env):
                step()
                x, y = a(env), b(env)
                return J.pow_(x, y)
    else:  # agg
        fn, body, index, frm, to = n[1], compile_node(n[2], budget), n[3], compile_node(n[4], budget), compile_node(n[5], budget)

        def f(env):
            step()
            start = J.js_round(frm(env))
            to_raw = to(env)
            if not math.isfinite(start):
                return math.nan
            if to_raw == math.inf:
                return _infinite(fn, body, index, env, start)
            end = J.js_round(to_raw)
            if end - start > MAX_TERMS:
                raise ValueError("that sum has too many terms to add up")
            acc = 0.0 if fn == "sum" else 1.0
            local = dict(env)
            i = start
            while i <= end:
                local[index] = i
                v = body(local)
                acc = acc + v if fn == "sum" else acc * v
                i += 1
            return acc
    return f


def _infinite(fn, body, index, env, start) -> float:
    N = 400_000
    local = dict(env)
    acc = 0.0 if fn == "sum" else 1.0
    at_half = at_quarter = 0.0
    i = start
    for count in range(1, N + 1):
        local[index] = i
        v = body(local)
        acc = acc + v if fn == "sum" else acc * v
        if count == N // 4:
            at_quarter = acc
        if count == N // 2:
            at_half = acc
        i += 1
    at_n = acc
    if fn == "prod":
        return 2 * at_n - at_half
    if not math.isfinite(at_n):
        return at_n
    d1, d2 = at_half - at_quarter, at_n - at_half
    if abs(d2) > abs(d1) * 0.9 and abs(d2) > 1e-6:
        return math.inf
    r1, r0 = 2 * at_n - at_half, 2 * at_half - at_quarter
    return (4 * r1 - r0) / 3


def evaluate(n: tuple, env: dict, budget: EvalBudget | None = None) -> float:
    return compile_node(n, budget or EvalBudget())(env)


def fmt(x: float) -> str:
    if J.is_integer(x) and abs(x) < 1e15:
        return js_str(x)
    return re.sub(r"\.?0+(e|$)", r"\1", J.to_precision(x, 15), count=1)


def check_identity(left: str, right: str) -> dict:
    budget = EvalBudget(20_000_000)
    try:
        return _check(left, right, budget)
    except BudgetExceeded:
        return {"verdict": "unclear", "left": left, "right": right, "detail": "That would take too much calculating to check here. Try smaller limits (for example fewer terms in a sum) or fewer nested sums."}


def _check(left: str, right: str, budget: EvalBudget) -> dict:
    L, R = parse(left), parse(right)
    vars_ = list(dict.fromkeys(variables(L) + variables(R)))
    if "i" in vars_:
        return {"verdict": "unclear", "left": left, "right": right, "detail": "That uses i (the imaginary unit). MathPilot only checks real-number identities for now."}
    infinite = has_infinite_sum(L) or has_infinite_sum(R)
    tol = 1e-7 if infinite else 1e-11
    close = lambda a, b: abs(a - b) <= tol * max(1, abs(a), abs(b))
    digits_of = lambda a, b: 15 if a == b else max(0, min(15, math.floor(-J.log10(abs(a - b) / max(1, abs(a))))))
    fl, fr = compile_node(L, budget), compile_node(R, budget)
    if not vars_:
        a, b = fl({}), fr({})
        if not math.isfinite(a) or not math.isfinite(b):
            return {"verdict": "unclear", "left": left, "right": right, "detail": f"One side doesn't have a finite value (left ≈ {fmt(a)}, right ≈ {fmt(b)})."}
        ok = close(a, b)
        d = digits_of(a, b)
        return {"verdict": "true" if ok else "false", "left": left, "right": right, "digits": d,
                "detail": (f"Both sides equal {fmt(a)}" + (" (the infinite sum was estimated, so this is about 8 digits)" if infinite else f" (they agree to {d} digits)") + ".") if ok else f"Left side ≈ {fmt(a)}, right side ≈ {fmt(b)}."}
    seed = 12345.0

    def rand():
        nonlocal seed
        seed = math.fmod(seed * 1103515245.0 + 12345.0, 2.0 ** 31)  # in doubles, exactly as JavaScript computes it
        return seed / 2.0 ** 31

    integerish = all(re.fullmatch(r"[nkmij]", v) for v in vars_)
    tested = 0
    nice = [1, 2, 3, 0.5, -1, -2, 1.5, 4, -0.5, 5]
    for attempt in range(400):
        if tested >= 40:
            break
        env = {}
        for i, v in enumerate(vars_):
            if attempt < len(nice):
                env[v] = float([1, 2, 3, 4, 5, 6, 7, 8, 9, 10][(attempt + i * 3) % 10]) if integerish else float(nice[(attempt + i * 3) % len(nice)])
            else:
                env[v] = 1 + J.floor(rand() * 12) if integerish else (rand() * 6 - 3 if attempt < 200 else rand() * 5 + 0.05)
        try:
            a, b = fl(env), fr(env)
        except BudgetExceeded:
            raise
        except Exception:  # noqa: BLE001 -- outside the domain at this point
            continue
        if not math.isfinite(a) or not math.isfinite(b):
            continue
        tested += 1
        if not close(a, b):
            return {"verdict": "false", "left": left, "right": right, "pointsTested": tested, "counterexample": {"values": env, "left": a, "right": b},
                    "detail": f"Not an identity: at {', '.join(f'{v} = {fmt(env[v])}' for v in vars_)} the left side is {fmt(a)} but the right side is {fmt(b)}."}
    if tested < 5:
        return {"verdict": "unclear", "left": left, "right": right, "pointsTested": tested, "detail": "I couldn't find enough values where both sides are defined to test it."}
    return {"verdict": "true", "left": left, "right": right, "pointsTested": tested,
            "detail": f"Holds at all {tested} {'whole-number' if integerish else 'different'} values I tried for {', '.join(vars_)}. That's strong evidence, not a proof."}


LEAD = re.compile(r"^\s*(?:hey\s+)?(?:mathpilot[,:]?|please|can you|could you|is it (?:true|correct|right) that|is it true|is|are|does|do|check|verify|prove|test|show|confirm|whether|that|if|me)\b\s*[:,]?\s*", re.I | re.A)


def extract_equation(text: str) -> dict | None:
    cleaned = re.sub(r"[?]+\s*$", "", text).replace("`", "")
    m = re.match(r"^(.*?[^<>!=])\s*(?:==?|≟)\s*([^=].*)$", cleaned, re.S)
    if not m:
        return None

    def strip_lead(s):
        prev = None
        while prev != s:
            prev, s = s, LEAD.sub("", s, count=1)
        return s

    left = strip_lead(m.group(1)).strip()
    right = re.sub(r"[.,;:]+$", "", re.sub(r"\s+(?:for all|for every|always|true|holds|correct|right)\b.*$", "", m.group(2), count=1, flags=re.I | re.A | re.S)).strip()
    return {"left": left, "right": right} if left and right else None
