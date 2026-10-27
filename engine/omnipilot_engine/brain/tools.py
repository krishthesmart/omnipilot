"""Exact answers for the questions language models are famously bad at: counting letters, comparing decimals,
primes, percentages, unit conversions, dates and plain arithmetic. Each tool answers exactly or returns None.
(Ported from server/src/lib/tools.ts, including JavaScript's Date rules.)"""
from __future__ import annotations

import math
import re
from datetime import date, timedelta

from .agents.jsfmt import js_round, js_str
from .mathpilot import jsmath as J
from .mathpilot.expr import evaluate, parse
from .mathpilot.pal import format_number as n

F = re.I | re.A


def clean(s: str) -> str:
    return re.sub(r"[?!.]+$", "", s.strip()).strip()


def quoted(s: str) -> str | None:
    m = re.search(r"[\"“'‘]([^\"”'’]+)[\"”'’]", s)
    return m.group(1) if m else None


def letter_count(text, now):
    t = clean(text)
    m = re.search(r"how many (?:times does (?:the letter )?)?[\"'‘“]?([a-z])[\"'’”]?(?:'s|s)?\b(?: (?:letters?|are|appear|occur|is))*(?: there)? in (?:the word )?[\"'‘“]?([a-z][a-z'\- ]*?)[\"'’”]?(?: appear| occur)?\s*$", t, F) \
        or re.search(r"count (?:the )?(?:letter )?[\"'‘“]?([a-z])[\"'’”]?(?:'s|s)? in (?:the word )?[\"'‘“]?([a-z][a-z'\- ]*?)[\"'’”]?\s*$", t, F)
    if not m:
        return None
    letter, word = m.group(1).lower(), m.group(2).strip()
    count = sum(1 for c in word.lower() if c == letter)
    marked = re.sub(f"({re.escape(letter)}+)", r"**\1**", word, flags=re.I)
    return {"tool": "letter count", "answer": f"There {'is' if count == 1 else 'are'} **{count}** \"{letter}\"{'' if count == 1 else 's'} in \"{word}\": {marked}"}


def text_stats(text, now):
    m = re.search(r"how many (letters|characters|words|vowels|consonants) (?:are )?(?:there )?in (.+)$", clean(text), F | re.S)
    if not m:
        return None
    target = quoted(m.group(2)) or re.sub(r"^(the word|the sentence|the phrase)\s+", "", m.group(2), flags=re.I).strip()
    if not target or len(target) > 500:
        return None
    kind = m.group(1).lower()
    letters = [c for c in target if c.isalpha()]
    value = (len([w for w in re.split(r"\s+", target) if w]) if kind == "words" else len(target) if kind == "characters"
             else sum(1 for c in letters if c.lower() in "aeiou") if kind == "vowels"
             else sum(1 for c in letters if re.match(r"[a-z]", c, re.I) and c.lower() not in "aeiou") if kind == "consonants" else len(letters))
    return {"tool": "text count", "answer": f"\"{target}\" has **{value}** {kind}{' (including spaces)' if kind == 'characters' else ''}."}


def reverse_text(text, now):
    t = clean(text)
    m = re.search(r"^(?:reverse|spell)\s+(?:the word\s+)?(.+?)(?:\s+backwards?)?$", t, F | re.S) or re.search(r"^(?:what is|what's)\s+(.+?)\s+(?:spelled\s+)?backwards?$", t, F | re.S)
    if not m or (not re.match(r"^reverse", text, re.I) and not re.search(r"backwards?", text, re.I)):
        return None
    target = quoted(m.group(1)) or re.sub(r"^[\"']|[\"']$", "", m.group(1))
    if not target or len(target) > 300:
        return None
    return {"tool": "reverse", "answer": f"\"{target}\" backwards is **{target[::-1]}**."}


NUM = r"-?\d+(?:,\d{3})*(?:\.\d+)?"


def num(s: str) -> float:
    return float(s.replace(",", ""))


def compare_numbers(text, now):
    m = re.search(rf"(?:which is|what is|what's)\s+(bigger|larger|greater|smaller|less|higher|lower)[:,]?\s*({NUM})\s+or\s+({NUM})", text, F) \
        or re.search(rf"^is\s+({NUM})\s+(bigger|larger|greater|smaller|less|more|higher|lower)\s+than\s+({NUM})", clean(text), F)
    if not m:
        return None
    if re.match(r"^is", clean(text), re.I):
        a, word, b = num(m.group(1)), m.group(2).lower(), num(m.group(3))
        bigger = bool(re.search(r"bigger|larger|greater|more|higher", word))
        yes = a > b if bigger else a < b
        rel = "equal to" if a == b else "bigger than" if a > b else "smaller than"
        return {"tool": "compare", "answer": f"{'**Yes**' if yes else '**No**'}: {m.group(1)} is {rel} {m.group(3)}."}
    word, a, b = m.group(1).lower(), num(m.group(2)), num(m.group(3))
    if a == b:
        return {"tool": "compare", "answer": f"They're equal: {m.group(2)} = {m.group(3)}."}
    bigger = bool(re.search(r"bigger|larger|greater|higher", word))
    pick = m.group(2) if (a > b if bigger else a < b) else m.group(3)
    hint = f" (compare place by place: {m.group(2)} vs {m.group(3)})" if re.search(r"\.\d", m.group(2) + m.group(3)) else ""
    return {"tool": "compare", "answer": f"**{pick}** is {'bigger' if bigger else 'smaller'}{hint}."}


def sort_numbers(text, now):
    order = r"(descending|largest to smallest|biggest to smallest|high to low|ascending|smallest to largest|low to high)"
    m = re.search(rf"^(?:sort|order|arrange)\b[^:\d-]*?{order}?[^:\d-]*:?\s*((?:-?\d[\d.,]*\s*(?:,|and|\s)\s*)+-?\d[\d.]*)\s*(?:from |in )?{order}?(?: order)?$", clean(text), F)
    if not m:
        return None
    parts = [p for p in re.split(r"\s*(?:,(?!\d{3}\b)|\band\b|\s)\s*", m.group(2)) if p]
    try:
        values = [J.div(float(p), 1) if re.fullmatch(r"-?(\d+\.?\d*|\.\d+)", p) else math.nan for p in parts]
    except ValueError:
        return None
    if len(values) < 2 or any(not math.isfinite(v) for v in values):
        return None
    desc = bool(re.search(r"desc|largest to|biggest to|high(est)? to", text, re.I))
    return {"tool": "sort", "answer": f"{'Largest to smallest' if desc else 'Smallest to largest'}: **{', '.join(js_str(v) for v in sorted(values, reverse=desc))}**"}


def factorize(x: int) -> list[int]:
    out, p = [], 2
    while p * p <= x:
        while x % p == 0:
            out.append(p)
            x //= p
        p += 1
    if x > 1:
        out.append(x)
    return out


def _nth_prime(k: int) -> int:
    limit = max(20, int(k * (math.log(k) + math.log(math.log(k)))) + 10) if k > 5 else 20
    while True:
        sieve = bytearray([1]) * (limit + 1)
        sieve[0:2] = b"\x00\x00"
        for i in range(2, int(limit ** 0.5) + 1):
            if sieve[i]:
                sieve[i * i::i] = bytearray(len(sieve[i * i::i]))
        count = 0
        for i, is_p in enumerate(sieve):
            if is_p:
                count += 1
                if count == k:
                    return i
        limit *= 2


def primes(text, now):
    t = clean(text)
    if m := re.search(r"^is\s+(\d[\d,]*)\s+(?:a\s+)?prime(?:\s+number)?$", t, F):
        x = num(m.group(1))
        if not x.is_integer() or x > 1e15:
            return None
        x = int(x)
        if x < 2:
            return {"tool": "prime check", "answer": f"**No**: {x} isn't prime (primes start at 2)."}
        f = factorize(x)
        return {"tool": "prime check", "answer": f"**Yes**, {x} is prime." if len(f) == 1 else f"**No**, {x} isn't prime: {x} = {' × '.join(map(str, f))}."}
    if m := re.search(r"(?:prime factors?|prime factori[sz]ation|factori[sz]e)\s+(?:of\s+)?(\d[\d,]*)", t, F):
        x = num(m.group(1))
        if not x.is_integer() or x < 2 or x > 1e15:
            return None
        return {"tool": "prime factors", "answer": f"{int(x)} = **{' × '.join(map(str, factorize(int(x))))}**"}
    if m := re.search(r"(?:what is |what's )?the\s+(\d+)(?:st|nd|rd|th)\s+prime(?:\s+number)?$", t, F):
        k = int(m.group(1))
        if k < 1 or k > 100_000:
            return None
        suffix = re.search(r"(st|nd|rd|th)", m.group(0), re.I).group(1)
        return {"tool": "nth prime", "answer": f"The {m.group(1)}{suffix} prime is **{_nth_prime(k)}**."}
    return None


def gcd_lcm(text, now):
    m = re.search(r"(gcd|gcf|hcf|greatest common (?:divisor|factor)|highest common factor|lcm|least common multiple|lowest common multiple)\s+(?:of\s+)?([\d,\s]+(?:and\s+\d+)?)$", clean(text), F)
    if not m:
        return None
    values = [int(v) for v in re.split(r"[\s,]+|and", m.group(2)) if v]
    if len(values) < 2 or any(v <= 0 or v > 2 ** 53 for v in values):
        return None
    is_gcd = bool(re.search(r"gcd|gcf|hcf|greatest|highest", m.group(1), re.I))
    value = values[0]
    for v in values[1:]:
        value = math.gcd(value, v) if is_gcd else value // math.gcd(value, v) * v
    return {"tool": "gcd" if is_gcd else "lcm", "answer": f"The {'greatest common divisor' if is_gcd else 'least common multiple'} of {', '.join(map(str, values))} is **{value}**."}


def percentages(text, now):
    t = clean(text).replace("$", "")
    if m := re.search(rf"(?:what is |what's |calculate )?({NUM})\s*(?:%|percent)\s+of\s+({NUM})", t, F):
        return {"tool": "percent", "answer": f"{m.group(1)}% of {m.group(2)} is **{n(num(m.group(1)) / 100 * num(m.group(2)))}**."}
    if m := re.search(rf"what (?:percent|percentage) (?:of ({NUM}) is ({NUM})|is ({NUM}) of ({NUM}))", t, F):
        part, whole = (num(m.group(2)), num(m.group(1))) if m.group(1) else (num(m.group(3)), num(m.group(4)))
        return {"tool": "percent", "answer": f"{n(part)} is **{n(J.div(part, whole) * 100)}%** of {n(whole)}."}
    if m := re.search(rf"(increase|raise|decrease|reduce|discount)\s+({NUM})\s+by\s+({NUM})\s*(?:%|percent)", t, F):
        up = bool(re.search(r"increase|raise", m.group(1), re.I))
        value = num(m.group(2)) * (1 + ((1 if up else -1) * num(m.group(3))) / 100)
        return {"tool": "percent", "answer": f"{m.group(2)} {'increased' if up else 'decreased'} by {m.group(3)}% is **{n(value)}**."}
    if m := re.search(rf"({NUM})\s*(?:%|percent)\s+tip\s+(?:on|for)\s+(?:a\s+)?({NUM})", t, F):
        tip = num(m.group(1)) / 100 * num(m.group(2))
        return {"tool": "percent", "answer": f"A {m.group(1)}% tip on {m.group(2)} is **{n(js_round(tip * 100) / 100)}**, for a total of {n(js_round((num(m.group(2)) + tip) * 100) / 100)}."}
    return None


WORD_OPS = [(r"\bmultiplied by\b|\btimes\b", "*", F), (r"\bdivided by\b|\bover\b", "/", F), (r"\bplus\b|\badded to\b", "+", F), (r"\bminus\b", "-", F),
            (r"\bto the power of\b|\braised to\b", "^", F), (r"\bsquared\b", "^2", F), (r"\bcubed\b", "^3", F), (r"\b(?:the )?square root of\b", "sqrt", F), (r"\bx\b", "*", re.A)]


def calculator(text, now):
    t = re.sub(r"\s*=\s*$", "", re.sub(r"^(?:what is|what's|whats|calculate|compute|evaluate|solve|how much is)\s+", "", clean(text), flags=F))
    for rx, op, fl in WORD_OPS:
        t = re.sub(rx, f" {op} ", t, flags=fl)
    t = re.sub(r"(\d),(?=\d{3}\b)", r"\1", t)
    if not re.search(r"^[\d\s.+\-*/^()!%×÷√πe]+$|^[\d\s.+\-*/^()!×÷√π]*(sqrt|sin|cos|tan|ln|log|abs|round|floor|ceil)[\d\s.+\-*/^()!×÷√π a-z]*$", t, re.I):
        return None
    if not re.search(r"[+\-*/^!×÷√]|sqrt|sin|cos|tan|ln|log|abs|round|floor|ceil", t) or not re.search(r"\d", t):
        return None
    t = re.sub(r"(\d+(?:\.\d+)?)\s*%", r"(\1/100)", t)
    try:
        value = evaluate(parse(t), {})
    except Exception:  # noqa: BLE001
        return None
    if not math.isfinite(value):
        return None
    return {"tool": "calculator", "answer": f"{re.sub(r'\s+', ' ', t).strip()} = **{n(value)}**"}


UNITS = [
    (["mm", "millimeter", "millimetre"], "length", 0.001, "mm"), (["cm", "centimeter", "centimetre"], "length", 0.01, "cm"), (["m", "meter", "metre"], "length", 1, "m"),
    (["km", "kilometer", "kilometre"], "length", 1000, "km"), (["in", "inch", "inche"], "length", 0.0254, "in"), (["ft", "foot", "feet"], "length", 0.3048, "ft"),
    (["yd", "yard"], "length", 0.9144, "yd"), (["mi", "mile"], "length", 1609.344, "mi"), (["nautical mile", "nmi"], "length", 1852, "nautical mi"),
    (["mg", "milligram"], "mass", 1e-6, "mg"), (["g", "gram"], "mass", 0.001, "g"), (["kg", "kilogram", "kilo"], "mass", 1, "kg"), (["oz", "ounce"], "mass", 0.028349523125, "oz"),
    (["lb", "lbs", "pound"], "mass", 0.45359237, "lb"), (["st", "stone"], "mass", 6.35029318, "st"), (["ton", "tonne", "metric ton"], "mass", 1000, "t"),
    (["ml", "milliliter", "millilitre"], "volume", 0.001, "mL"), (["l", "liter", "litre"], "volume", 1, "L"), (["tsp", "teaspoon"], "volume", 0.00492892159375, "tsp"),
    (["tbsp", "tablespoon"], "volume", 0.01478676478125, "tbsp"), (["fl oz", "fluid ounce"], "volume", 0.0295735295625, "fl oz"), (["cup"], "volume", 0.2365882365, "cups"),
    (["pint", "pt"], "volume", 0.473176473, "pt"), (["quart", "qt"], "volume", 0.946352946, "qt"), (["gallon", "gal"], "volume", 3.785411784, "gal"),
    (["ms", "millisecond"], "time", 0.001, "ms"), (["s", "sec", "second"], "time", 1, "s"), (["min", "minute"], "time", 60, "min"), (["h", "hr", "hour"], "time", 3600, "h"),
    (["day"], "time", 86400, "days"), (["week", "wk"], "time", 604800, "weeks"), (["year", "yr"], "time", 31557600, "years"),
    (["m/s", "meters per second", "metres per second"], "speed", 1, "m/s"), (["km/h", "kph", "kmh", "kilometers per hour", "kilometres per hour"], "speed", 1000 / 3600, "km/h"),
    (["mph", "miles per hour"], "speed", 1609.344 / 3600, "mph"), (["knot", "kn"], "speed", 1852 / 3600, "knots"),
    (["byte", "b"], "data", 1, "bytes"), (["kb", "kilobyte"], "data", 1e3, "KB"), (["mb", "megabyte"], "data", 1e6, "MB"), (["gb", "gigabyte"], "data", 1e9, "GB"),
    (["tb", "terabyte"], "data", 1e12, "TB"), (["kib", "kibibyte"], "data", 1024, "KiB"), (["mib", "mebibyte"], "data", 1024 ** 2, "MiB"), (["gib", "gibibyte"], "data", 1024 ** 3, "GiB"),
    (["m2", "m²", "square meter", "square metre", "sq m"], "area", 1, "m²"), (["km2", "km²", "square kilometer", "square kilometre", "sq km"], "area", 1e6, "km²"),
    (["ft2", "ft²", "square foot", "square feet", "sq ft"], "area", 0.09290304, "sq ft"), (["acre"], "area", 4046.8564224, "acres"), (["hectare", "ha"], "area", 10000, "hectares"),
    (["sq mi", "square mile"], "area", 2589988.110336, "sq mi"),
    (["c", "°c", "celsius", "centigrade", "degrees celsius", "degree celsius"], "temperature", 0, "°C"), (["f", "°f", "fahrenheit", "degrees fahrenheit", "degree fahrenheit"], "temperature", 0, "°F"),
    (["k", "kelvin"], "temperature", 0, "K"),
]


def find_unit(raw: str):
    s = re.sub(r"\.$", "", raw.strip().lower())
    singular = re.sub(r"(?<=[a-z]{3})s$", "", s)
    singular = re.sub(r"(?<=inch)es$", "", singular)
    singular = re.sub(r"^degrees? ", lambda d: d.group(0) if re.search(r"celsius|fahrenheit", s) else "", singular)
    return next((u for u in UNITS if s in u[0] or singular in u[0]), None)


def _temp(v, frm, to):
    c = v if frm == "°C" else (v - 32) * 5 / 9 if frm == "°F" else v - 273.15
    return c if to == "°C" else c * 9 / 5 + 32 if to == "°F" else c + 273.15


def units(text, now):
    t = re.sub(r",(?=\d{3}\b)", "", clean(text))
    m = re.search(r"(?:convert\s+)?(-?\d+(?:\.\d+)?)\s*([a-z°²/ ]+?)\s+(?:to|in|into|as)\s+([a-z°²/ ]+?)$", re.sub(r"^(?:what is|what's|how much is|how many)\s+", "", t, flags=F), F)
    how_many = None if m else re.search(r"how many\s+([a-z°²/ ]+?)\s+(?:are\s+)?(?:there\s+)?in\s+(?:an?|one|(\d+(?:\.\d+)?))\s+([a-z°²/ ]+?)$", t, F)
    if not m and not how_many:
        return None
    if how_many:
        value = float(how_many.group(2)) if how_many.group(2) else 1.0
        frm, to = find_unit(how_many.group(3)), find_unit(how_many.group(1))
    else:
        value, frm, to = float(m.group(1)), find_unit(m.group(2)), find_unit(m.group(3))
    if not frm or not to or frm[1] != to[1] or not math.isfinite(value):
        return None
    result = _temp(value, frm[3], to[3]) if frm[1] == "temperature" else value * frm[2] / to[2]
    shown = js_round(result * 1e4) / 1e4 if abs(result) >= 0.01 or result == 0 else float(J.to_precision(result, 4))
    lab = lambda u, v: u[3][:-1] if v == 1 and re.match(r"^(days|weeks|years|cups|acres|hectares|knots|bytes)$", u[3]) else u[3]
    return {"tool": "unit conversion", "answer": f"{n(value)} {lab(frm, value)} = **{n(shown)} {lab(to, shown)}**"}


MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
HOLIDAYS = {"christmas": (11, 25), "christmas day": (11, 25), "new year": (0, 1), "new year's day": (0, 1), "new years day": (0, 1), "halloween": (9, 31),
            "valentine's day": (1, 14), "valentines day": (1, 14), "independence day": (6, 4)}


def _rollover(y: int, m0: int, d: int) -> date:
    y += m0 // 12
    return date(y, m0 % 12 + 1, 1) + timedelta(days=d - 1)


def utc_date(y: int, m0: int, d: int) -> date:
    """Date.UTC(2000, m, d) then setUTCFullYear(y): the day/month overflow happens in the year 2000."""
    base = _rollover(2000, m0, d)
    return _rollover(y, base.month - 1, base.day)


def _today(now: date) -> date:
    return now


def fmt_date(d: date) -> str:
    return f"{DAYS[(d.weekday() + 1) % 7]}, {MONTHS[d.month - 1].capitalize()} {d.day}, {d.year}"


def parse_date(raw: str, now: date) -> date | None:
    s = re.sub(r"^the ", "", re.sub(r"\s+", " ", re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", raw.strip().lower()).replace(",", " ")))
    base = now
    if s in ("today", "now"):
        return base
    if s == "tomorrow":
        return base + timedelta(days=1)
    if s == "yesterday":
        return base - timedelta(days=1)

    def nxt(m0, d):
        this = utc_date(base.year, m0, d)
        return utc_date(base.year + 1, m0, d) if this < base else this

    if (h := HOLIDAYS.get(re.sub(r"^next ", "", s))):
        return nxt(*h)
    try:
        if m := re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", s):
            return utc_date(int(m.group(1)), int(m.group(2)) - 1, int(m.group(3)))
        if m := re.match(r"^(\d{1,2})\/(\d{1,2})\/(\d{4})$", s):
            return utc_date(int(m.group(3)), int(m.group(1)) - 1, int(m.group(2)))
        idx = lambda w: next((i for i, x in enumerate(MONTHS) if x == w or (len(w) >= 3 and x.startswith(w))), -1)
        if (m := re.match(r"^([a-z]+) (\d{1,2})(?: (\d{1,4}))?$", s)) and idx(m.group(1)) >= 0:
            return utc_date(int(m.group(3)), idx(m.group(1)), int(m.group(2))) if m.group(3) else nxt(idx(m.group(1)), int(m.group(2)))
        if (m := re.match(r"^(\d{1,2}) ([a-z]+)(?: (\d{1,4}))?$", s)) and idx(m.group(2)) >= 0:
            return utc_date(int(m.group(3)), idx(m.group(2)), int(m.group(1))) if m.group(3) else nxt(idx(m.group(2)), int(m.group(1)))
    except (ValueError, OverflowError):  # year 0 and earlier: JavaScript handles them, Python's dates don't
        return None
    return None


def _add_months(d: date, k: int) -> date:
    return _rollover(d.year, d.month - 1 + k, d.day)


def dates(text, now):
    t = clean(text)
    if re.search(r"^what(?:'s| is) (?:the date )?today(?:'s date)?$|^what(?:'s| is) the date(?: today)?$|^what day is (?:it )?today$", t, F):
        return {"tool": "date", "answer": f"Today is **{fmt_date(now)}**."}
    if m := re.search(r"^what day(?: of the week)? (?:is|was|will be|does|did) (.+?)(?: (?:fall|land) on| be)?$", t, F):
        if d := parse_date(m.group(1), now):
            return {"tool": "day of week", "answer": re.sub(r"^(\w+)", r"**\1**", fmt_date(d), count=1) + "."}
    if m := re.search(r"^how many (days|weeks|months)(?: are there| is it| left)? (?:until|till|til|before|to) (.+)$", t, F):
        if d := parse_date(m.group(2), now):
            days = (d - now).days
            unit = m.group(1).lower()
            value = f"{n(js_round(days / 7 * 10) / 10)} weeks" if unit == "weeks" else f"about {n(js_round(days / 30.44 * 10) / 10)} months" if unit == "months" else f"{days} days"
            return {"tool": "date difference", "answer": f"**{value}** until {fmt_date(d)}{'' if unit == 'days' else f' ({days} days)'}."}
    if m := re.search(r"^how many days (?:are there )?(?:between|from) (.+?) (?:and|to|until) (.+)$", t, F):
        a, b = parse_date(m.group(1), now), parse_date(m.group(2), now)
        if a and b:
            return {"tool": "date difference", "answer": f"**{abs((b - a).days)} days** between {fmt_date(a)} and {fmt_date(b)}."}
    if m := re.search(r"^(?:what (?:is|was|will be) )?(?:the date )?(\d+) (days?|weeks?|months?|years?) (from|after|before) (.+)$|^(?:what (?:is|will be) )?(?:the date )?(?:in )?(\d+) (days?|weeks?|months?|years?)(?: from (?:now|today))?$", t, F):
        amount = int(m.group(1) or m.group(5))
        unit = re.sub(r"s$", "", (m.group(2) or m.group(6)).lower())
        sign = -1 if (m.group(3) or "").lower() == "before" else 1
        start = parse_date(m.group(4), now) if m.group(4) else now
        if start:
            try:
                d = start + timedelta(days=sign * amount) if unit == "day" else start + timedelta(days=sign * amount * 7) if unit == "week" \
                    else _add_months(start, sign * amount) if unit == "month" else _rollover(start.year + sign * amount, start.month - 1, start.day)
            except (ValueError, OverflowError):
                return None
            return {"tool": "date arithmetic", "answer": f"**{fmt_date(d)}**"}
    if m := re.search(r"^is (\d{1,4}) a leap year$", t, F):
        y = int(m.group(1))
        leap = (y % 4 == 0 and y % 100 != 0) or y % 400 == 0
        return {"tool": "leap year", "answer": f"{'**Yes**' if leap else '**No**'}, {y} {'is' if leap else "isn't"} a leap year{' (century years are leap years only when divisible by 400)' if y % 100 == 0 else ''}."}
    if m := re.search(r"^how old (?:is|am|would be|will be) (?:someone|a person|i|he|she|they)? ?(?:if (?:i was|i'm|they were|he was|she was) )?born (?:on |in )?(.+)$", t, F):
        year_only = re.fullmatch(r"\d{4}", m.group(1).strip())
        born = parse_date(m.group(1), now) or (utc_date(int(m.group(1)), 0, 1) if year_only else None)
        if born:
            age = now.year - born.year - (1 if (now.month, now.day) < (born.month, born.day) else 0)
            return {"tool": "age", "answer": f"About **{age}** ({age} or {age + 1}, depending on the birthday)." if year_only else f"**{age}** years old."}
    return None


TOOLS = [letter_count, text_stats, reverse_text, compare_numbers, sort_numbers, primes, gcd_lcm, percentages, units, dates, calculator]


def answer_with_tools(text: str, now: date | None = None) -> dict | None:
    if len(text) > 300:
        return None
    now = now or date.today()
    for tool in TOOLS:
        try:
            r = tool(text, now)
        except Exception:  # noqa: BLE001 -- a tool that can't handle the input just doesn't answer
            continue
        if r:
            return r
    return None
