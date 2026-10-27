"""ScienceLab: science simulations from a plain-language request (projectile motion, free fall, pendulums,
population growth, predator-prey, radioactive decay, medicine levels, cooling, soil moisture) and where a
soil type is found. Pure maths, no AI model. (Ported from server/src/agents/scienceLab.ts; identical output.)"""
from __future__ import annotations

import math
import re

from ... import store
from .base import evidence
from .jsfmt import js_json, js_round, js_str, round2

F = re.I | re.A
N = r"(\d[\d,]*(?:\.\d+)?)"


def num(text: str, patterns, fallback: float) -> dict:
    for p in patterns if isinstance(patterns, list) else [patterns]:
        m = re.search(p, text, F)
        if m:
            return {"value": float(m.group(1).replace(",", "")), "inferred": False}
    return {"value": fallback, "inferred": True}


def fraction(text: str, patterns: list, fallback: float) -> dict:
    r = num(text, patterns, fallback)
    if r["inferred"]:
        return r
    m = next((m for p in patterns if (m := re.search(p, text, F))), None)
    percent = bool(re.search(r"%|percent", m.group(0) if m else "", re.I)) or r["value"] > 1
    return {"value": r["value"] / 100 if percent else r["value"], "inferred": False}


def t(rx: str, text: str) -> bool:
    return re.search(rx, text, F) is not None


def detect_sim(text: str) -> str:
    if t(r"\b(soil|dirt|earth|ground)\b", text) and t(r"\b(where|location|region|place|area|country|identify|which part)\b", text):
        return "soil_location"
    if t(r"\bpendulum\b", text):
        return "pendulum"
    if t(r"\b(half[- ]?life|radioactiv|decay|carbon[- ]14|isotope)\b", text) and not t(r"\b(dose|mg|medicine|drug|pill|tablet)\b", text):
        return "decay"
    if t(r"\b(dose|dosage|mg|medicine|medication|drug|pill|tablet|ibuprofen|paracetamol|acetaminophen|caffeine)\b", text) and t(r"\b(half[- ]?life|every|body|bloodstream|level|concentration|hours?)\b", text):
        return "medicine"
    if t(r"\b(predator|prey|lotka|foxes|wolves|hares)\b", text):
        return "predator_prey"
    if t(r"\b(cool(s|ing)?|newton'?s law of cooling|coffee|tea)\b", text) and t(r"°|degrees?|\btemp", text):
        return "cooling"
    if t(r"\b(free[- ]?fall|dropped|falls? from|fall(ing)? from)\b", text):
        return "free_fall"
    # "a ball thrown at 20 m/s", "kicked at 30 degrees": the same projectile maths (the router already sends these here).
    if t(r"projectile|launch|trajectory", text) or (t(r"\b(thrown|throws?|throwing|kicked|kicks?|fired|shot|tossed|hit|served)\b", text) and t(r"m\/s|km\/h|kph|mps|degrees?|°|how far|how high|range", text)):
        return "projectile"
    if t(r"population|growth rate|carrying capacity|logistic", text):
        return "population"
    if t(r"soil|moisture|evaporat", text):
        return "soil_moisture"
    return "unsupported"


def run_projectile(text):
    kmh = num(text, [rf"{N}\s*(?:km\/h|kph|kilometers? per hour)"], math.nan)
    speed = (num(text, [rf"{N}\s*(?:m\/s|mps|meters? per second|metres? per second)", rf"(?:speed|velocity)\s*(?:of|=|:|is)?\s*{N}"], 20)
             if kmh["inferred"] else {"value": round2(kmh["value"] / 3.6), "inferred": False})
    angle = num(text, [rf"{N}\s*(?:°|deg\b|degrees?)", rf"angle\s*(?:of|=|:|is)?\s*{N}"], 45)
    g = 9.81
    rad = angle["value"] * math.pi / 180
    v = speed["value"]
    return {"inputs": {"initialSpeedMs": v, "launchAngleDeg": angle["value"], "gravity": g},
            "inferred": {"initialSpeedMs": speed["inferred"], "launchAngleDeg": angle["inferred"]},
            "outputs": {"timeOfFlightSec": round2(2 * v * math.sin(rad) / g), "rangeMeters": round2(v ** 2 * math.sin(2 * rad) / g), "maxHeightMeters": round2(v ** 2 * math.sin(rad) ** 2 / (2 * g))},
            "note": f"Projectile launched at {js_str(v)} m/s, {js_str(angle['value'])}° (no air resistance, flat ground)."}


def run_population(text):
    initial = num(text, [rf"(?:initial|starting)(?: population)?\s*(?:of|=|:|is)?\s*{N}", rf"(?:start(?:s|ing)? (?:with|at)|begin(?:s|ning)? with)\s*{N}",
                         rf"{N}\s+(?:rabbits|deer|bacteria|cells|animals|fish|birds|people|individuals|organisms|insects|wolves|mice)"], 100)
    rate = fraction(text, [rf"(?:growth )?rate\s*(?:of|=|:|is)?\s*{N}\s*(?:%|percent)?", rf"(?:grows?|growing|increases?) (?:by|at)\s*{N}\s*(?:%|percent)?"], 0.1)
    cap = num(text, [rf"(?:carrying )?capacity\s*(?:of|=|:|is)?\s*{N}", rf"(?:max(?:imum)?|limit) (?:of|=|:|is)?\s*{N}"], 1000)
    steps, series = 10, [initial["value"]]
    for _ in range(steps):
        p = series[-1]
        series.append(round2(p + rate["value"] * p * (1 - p / cap["value"])))
    return {"inputs": {"initialPopulation": initial["value"], "growthRate": rate["value"], "carryingCapacity": cap["value"], "steps": steps},
            "inferred": {"initialPopulation": initial["inferred"], "growthRate": rate["inferred"], "carryingCapacity": cap["inferred"]},
            "outputs": {"series": series}, "note": f"Logistic growth over {steps} steps; population approaches carrying capacity {js_str(cap['value'])}."}


def run_soil_moisture(text):
    m0 = num(text, [rf"moisture\s*(?:of|=|:|is|at)?\s*{N}", rf"{N}\s*%\s*(?:soil )?moisture"], 35)
    evap = fraction(text, [rf"evaporat\w*\s*(?:rate)?\s*(?:of|=|:|is)?\s*{N}\s*(?:%|percent)?"], 0.05)
    rain = num(text, [rf"rain(?:fall)?\s*(?:of|=|:|is)?\s*{N}", rf"{N}\s*mm(?: of)? rain"], 0)
    days, series = 7, [m0["value"]]
    for _ in range(days):
        series.append(round2(max(0, series[-1] * (1 - evap["value"]) + rain["value"] * 0.3)))
    return {"inputs": {"initialMoisturePct": m0["value"], "evaporationRate": evap["value"], "rainfallMm": rain["value"], "days": days},
            "inferred": {"initialMoisturePct": m0["inferred"], "evaporationRate": evap["inferred"], "rainfallMm": rain["inferred"]},
            "outputs": {"moistureSeriesPct": series},
            "note": f"Soil moisture projected over {days} days with {js_str(rain['value'])}mm/day rainfall input; simplified single-layer bucket model."}


def gravity_for(text):
    for rx, g, where in ((r"\bmoon\b", 1.62, "the Moon"), (r"\bmars\b", 3.71, "Mars"), (r"\bjupiter\b", 24.79, "Jupiter")):
        if t(rx, text):
            return g, where
    return 9.81, "Earth"


METERS = r"\s*(?:m\b|meters?|metres?)"


def run_pendulum(text):
    L = num(text, [rf"{N}{METERS}", rf"(?:length|long)\s*(?:of|=|:|is)?\s*{N}"], 1)
    g, where = gravity_for(text)
    period = 2 * math.pi * math.sqrt(L["value"] / g)
    return {"inputs": {"lengthM": L["value"], "gravity": g}, "inferred": {"lengthM": L["inferred"]},
            "outputs": {"periodSec": round2(period), "swingsPerMinute": round2(60 / period), "frequencyHz": round2(1 / period)},
            "note": f"A {js_str(L['value'])} m pendulum on {where} (small swings, no friction): period T = 2π√(L/g).",
            "table": [["One full swing (there and back)", f"{js_str(round2(period))} s"], ["Swings per minute", js_str(round2(60 / period))], ["Frequency", f"{js_str(round2(1 / period))} Hz"]]}


def run_free_fall(text):
    h = num(text, [rf"(?:from|height of)\s*(?:a\s+)?{N}{METERS}", rf"{N}{METERS}\s*(?:high|tall|up|building|tower|cliff)", rf"{N}{METERS}"], 20)
    g, where = gravity_for(text)
    tt = math.sqrt(2 * h["value"] / g)
    v = g * tt
    return {"inputs": {"heightM": h["value"], "gravity": g}, "inferred": {"heightM": h["inferred"]},
            "outputs": {"fallTimeSec": round2(tt), "impactSpeedMs": round2(v), "impactSpeedKmh": round2(v * 3.6)},
            "note": f"Dropped from {js_str(h['value'])} m on {where}, no air resistance: t = √(2h/g), v = g·t.",
            "table": [["Time to hit the ground", f"{js_str(round2(tt))} s"], ["Speed at impact", f"{js_str(round2(v))} m/s ({js_str(round2(v * 3.6))} km/h)"]]}


def duration(text, pattern, fallback):
    m = re.search(pattern, text, F)
    if m:
        return {"value": float(m.group(1).replace(",", "")), "unit": re.sub(r"s$", "", (m.group(2) or fallback["unit"]).lower()), "inferred": False}
    return {**fallback, "inferred": True}


TIME_UNITS = r"(years?|days?|hours?|minutes?|seconds?)"


def run_decay(text):
    half = duration(text, rf"half[- ]?life\s*(?:of|=|:|is)?\s*{N}\s*{TIME_UNITS}", {"value": 5730, "unit": "year"})
    n0 = num(text, [rf"{N}\s*(?:g\b|grams?|kg|atoms?)", rf"(?:start(?:ing)? with|initial(?: amount)?(?: of)?)\s*{N}"], 100)
    elapsed = duration(text, rf"(?:after|in|over)\s*{N}\s*{TIME_UNITS}", {"value": half["value"] * 3, "unit": half["unit"]})
    rem = lambda x: n0["value"] * math.pow(0.5, x / half["value"])
    steps = [k * half["value"] for k in range(5)]
    e, hv, hu = elapsed, js_str(half["value"]), half["unit"]
    return {"inputs": {"halfLife": f"{hv} {hu}s", "initialAmount": n0["value"], "elapsed": f"{js_str(e['value'])} {e['unit']}s"},
            "inferred": {"halfLife": half["inferred"], "initialAmount": n0["inferred"], "elapsed": e["inferred"]},
            "outputs": {"remainingAfterElapsed": round2(rem(e["value"])), "percentLeft": round2(rem(e["value"]) / n0["value"] * 100)},
            "note": f"Radioactive decay: N(t) = N₀ · (1/2)^(t / half-life). Every {hv} {hu}s, half of what's left decays.",
            "table": [[f"Left after {js_str(e['value'])} {e['unit']}s", f"{js_str(round2(rem(e['value'])))} ({js_str(round2(rem(e['value']) / n0['value'] * 100))}%)"],
                      *[[f"After {js_str(x)} {hu}s", js_str(round2(rem(x)))] for x in steps]]}


def run_medicine(text):
    dose = num(text, [rf"{N}\s*mg\b"], 200)
    half = duration(text, rf"half[- ]?life\s*(?:of|=|:|is)?\s*{N}\s*(hours?|hrs?|h\b|minutes?)", {"value": 4, "unit": "hour"})
    half_h = half["value"] / 60 if "min" in half["unit"] else half["value"]
    every = num(text, [rf"every\s*{N}\s*(?:hours?|hrs?|h\b)"], math.nan)
    interval = None if math.isnan(every["value"]) else every["value"]
    k = math.log(2) / half_h
    hours = max(24, interval * 6) if interval else max(12, math.ceil(half_h * 5))
    step = max(1, js_round(hours / 12))

    def amount_at(x):
        if not interval:
            return dose["value"] * math.exp(-k * x)
        a, d = 0.0, 0.0
        while d <= x + 1e-9:
            a += dose["value"] * math.exp(-k * (x - d))
            d += interval
        return a

    points, x = [], 0
    while x <= hours:
        points.append([x, amount_at(x)])
        x += step
    peak = dose["value"] / (1 - math.exp(-k * interval)) if interval else dose["value"]
    trough = peak * math.exp(-k * interval) if interval else 0
    dv = js_str(dose["value"])
    return {"inputs": {"doseMg": dose["value"], "halfLifeHours": round2(half_h), "everyHours": interval},
            "inferred": {"doseMg": dose["inferred"], "halfLifeHours": half["inferred"]},
            "outputs": {"steadyStatePeakMg": round2(peak), "steadyStateTroughMg": round2(trough)} if interval else {"mgLeftAfter24h": round2(dose["value"] * math.exp(-k * 24))},
            "note": f"How much of a {dv} mg dose stays in the body (half-life {js_str(round2(half_h))} h{f', taken every {js_str(interval)} h' if interval else ', one dose'}). A simplified one-compartment model for learning only, not medical advice: follow the label and your doctor.",
            "table": ([["Highest level once it settles", f"{js_str(round2(peak))} mg"], ["Lowest level once it settles", f"{js_str(round2(trough))} mg"]] if interval else [])
                     + [[f"{js_str(p)} h", f"{js_str(round2(a))} mg"] for p, a in points]}


def run_predator_prey(text):
    prey = num(text, [rf"{N}\s*(?:rabbits|hares|prey|deer|mice|fish)"], 40)
    pred = num(text, [rf"{N}\s*(?:foxes|wolves|predators|lynx|owls|sharks)"], 9)
    a, b, c, d = 0.1, 0.02, 0.3, 0.01
    f = lambda x, y: (a * x - b * x * y, d * x * y - c * y)
    x, y, dt = prey["value"], pred["value"], 0.1
    rows = []
    max_x, max_y, min_x, min_y = x, y, x, y
    for i in range(2001):
        if i % 250 == 0:
            rows.append([f"t = {js_str(round2(i * dt))}", f"{js_str(js_round(x))} prey, {js_str(js_round(y))} predators"])
        k1x, k1y = f(x, y)
        k2x, k2y = f(x + dt / 2 * k1x, y + dt / 2 * k1y)
        k3x, k3y = f(x + dt / 2 * k2x, y + dt / 2 * k2y)
        k4x, k4y = f(x + dt * k3x, y + dt * k3y)
        x = max(0, x + dt / 6 * (k1x + 2 * k2x + 2 * k3x + k4x))
        y = max(0, y + dt / 6 * (k1y + 2 * k2y + 2 * k3y + k4y))
        max_x, max_y, min_x, min_y = max(max_x, x), max(max_y, y), min(min_x, x), min(min_y, y)
    r = lambda v: js_round(v)
    return {"inputs": {"prey": prey["value"], "predators": pred["value"], "preyBirth": a, "predation": b, "predatorDeath": c, "predatorGrowth": d},
            "inferred": {"prey": prey["inferred"], "predators": pred["inferred"]},
            "outputs": {"preyRange": [r(min_x), r(max_x)], "predatorRange": [r(min_y), r(max_y)]},
            "note": "Predator–prey cycles (Lotka–Volterra): prey grow, predators feast and multiply, prey crash, predators starve, and it repeats, with predators peaking just after prey.",
            "table": [["Prey swing between", f"{js_str(r(min_x))} and {js_str(r(max_x))}"], ["Predators swing between", f"{js_str(r(min_y))} and {js_str(r(max_y))}"], *rows]}


def run_cooling(text):
    temps = [float(m.group(1)) for m in re.finditer(r"(-?\d+(?:\.\d+)?)\s*(?:°\s*c?|degrees?(?:\s*c(?:elsius)?)?|c\b)", text, F)]
    t0 = {"value": temps[0] if temps else 90, "inferred": len(temps) < 1}
    room = {"value": temps[1], "inferred": False} if len(temps) > 1 else {"value": 20, "inferred": True}
    target = temps[2] if len(temps) > 2 else 60
    k = 0.05
    T = lambda x: room["value"] + (t0["value"] - room["value"]) * math.exp(-k * x)
    to_target = math.log((t0["value"] - room["value"]) / (target - room["value"])) / k if room["value"] < target < t0["value"] else None
    return {"inputs": {"startC": t0["value"], "roomC": room["value"], "coolingRatePerMin": k}, "inferred": {"startC": t0["inferred"], "roomC": room["inferred"]},
            "outputs": {"minutesToReachTarget": None if to_target is None else round2(to_target), "targetC": target},
            "note": "Newton's law of cooling: T(t) = room + (start − room)·e^(−kt). The hotter it is compared with the room, the faster it cools.",
            "table": ([[f"Reaches {js_str(target)}°C", f"after about {js_str(js_round(to_target))} min"]] if to_target is not None else [])
                     + [[f"{m} min", f"{js_str(round2(T(m)))}°C"] for m in (0, 5, 10, 20, 30, 60)]}


SOILS = [
    (r"\b(red|laterite|lateritic|rusty)\b", "Laterite / red soil (Oxisols, Ultisols)", "warm, wet tropics and subtropics: the southeastern US, Brazil, central Africa, southern India, northern Australia", "red or orange from iron oxides, often clayey, low in nutrients"),
    (r"\b(black|chernozem|prairie|crumbly)\b", "Chernozem / black prairie soil (Mollisols)", "temperate grasslands: the US Great Plains and Midwest, Ukraine, southern Russia, the Argentine Pampas", "very dark, crumbly and rich in organic matter"),
    (r"\b(sand|sandy)\b", "Sandy soil (Aridisols, Entisols)", "deserts and dry regions, coasts and river deltas: the Sahara, Arabian Peninsula, US Southwest, coastal dunes", "gritty, drains fast, pale, holds little water"),
    (r"\b(peat|peaty|bog|boggy|spongy)\b", "Peat (Histosols)", "cool, waterlogged places: Ireland, Scotland, Scandinavia, Canada, Siberia, wetlands", "dark brown, spongy, made of partly rotted plants"),
    (r"\b(chalk|chalky|limestone|white|pale)\b", "Chalky / limestone soil (Rendzina)", "over limestone: southern England, northern France, parts of Texas and Florida, the Mediterranean", "pale, stony, alkaline, fizzes with vinegar"),
    (r"\b(clay|sticky|cracked|cracks)\b", "Clay soil (Vertisols when it cracks)", "river floodplains and some dry regions: the Nile valley, Texas Blackland Prairie, India's Deccan, eastern Australia", "sticky when wet, cracks when dry, holds water"),
    (r"\b(silt|silty|loess|powdery|floury)\b", "Silt / loess", "river valleys and wind-blown deposits: the Mississippi valley, China's Loess Plateau, the Rhine and Danube basins", "smooth and floury, very fertile, erodes easily"),
    (r"\b(loam|loamy)\b", "Loam (Alfisols)", "temperate forests and farmland: much of Europe, the eastern and midwestern US, eastern China", "a balanced mix of sand, silt and clay; good for farming"),
    (r"\b(frozen|permafrost|tundra)\b", "Tundra / permafrost soil (Gelisols)", "the Arctic: northern Alaska, Canada, Greenland, Siberia, Scandinavia's far north", "frozen below the surface all year"),
    (r"\b(ash|volcanic|andisol)\b", "Volcanic ash soil (Andisols)", "near volcanoes: Japan, Indonesia, the Pacific Northwest, Iceland, the Andes, Hawaii", "light, porous, very fertile, often dark"),
]


def soil_location(text: str) -> dict:
    hits = [s for s in SOILS if t(s[0], text)]
    if not hits:
        return {"findings": [f"Describe the soil (colour, feel, what it's made of) and I'll suggest where it's typically found. For example: \"red clay dirt\", \"black crumbly soil\", \"pale chalky soil with stones\". Types I know: {', '.join(s[1].split(' (')[0] for s in SOILS)}."], "matched": 0}
    return {"findings": ["**Where this kind of soil is typically found**\n" + "\n".join(f"- **{s[1]}**: {s[2]}. _Clues: {s[3]}._" for s in hits),
                         "Soil narrows the region down, but it can't pinpoint a location by itself: combine it with climate, plants and landforms (and a soil map such as the USDA Web Soil Survey or the FAO World Soil Map) to get closer."],
            "matched": len(hits)}


RUNNERS = {"projectile": run_projectile, "population": run_population, "soil_moisture": run_soil_moisture, "pendulum": run_pendulum, "free_fall": run_free_fall,
           "decay": run_decay, "medicine": run_medicine, "predator_prey": run_predator_prey, "cooling": run_cooling}


async def run(input: dict, ctx: dict) -> dict:
    text, run_id = input["requestText"], input["runId"]
    kind = detect_sim(text)
    store.audit(run_id, "ScienceLab", "select_simulation", {"kind": kind}, "selected")
    if kind == "soil_location":
        r = soil_location(text)
        store.audit(run_id, "ScienceLab", "soil_location", {"matched": r["matched"]}, "completed")
        return {"status": "success" if r["matched"] else "partial_success", "findings": r["findings"], "evidence": [evidence("sciencelab-soil-reference", "USDA soil orders and where they occur")],
                "confidence": 0.75 if r["matched"] else 0.4, "limitations": [], "proposedActions": []}
    if kind == "unsupported":
        store.audit(run_id, "ScienceLab", "run_simulation", {"kind": kind}, "not_implemented")
        return {"status": "failed_safe", "findings": ["Not implemented: ScienceLab supports projectile motion, free fall, pendulums, population growth, predator–prey cycles, radioactive decay, how medicine levels change in the body, cooling, soil moisture, and where a soil type is found; the requested simulation isn't one of those."],
                "evidence": [], "confidence": 1, "limitations": ["No simulation was run because the requested type is outside the supported set."], "proposedActions": []}
    sim = RUNNERS[kind](text)
    store.audit(run_id, "ScienceLab", "run_simulation", {"kind": kind, "inputs": sim["inputs"]}, "completed")
    inferred = [k for k, v in sim["inferred"].items() if v]
    limitations = ["Model is simplified (no air resistance / predator limits / multi-layer soil physics, as applicable) and intended for educational exploration, not field-accurate prediction."]
    if inferred:
        limitations.append(f"No explicit value was given for: {', '.join(inferred)}; sensible defaults were used — adjust and re-run for different inputs.")
    findings = [f"Ran {kind.replace('_', ' ', 1)} simulation. {sim['note']}", f"Inputs: {js_json(sim['inputs'])}", f"Outputs: {js_json(sim['outputs'])}"]
    if sim.get("table"):
        findings.append("| | |\n|---|---|\n" + "\n".join(f"| {k} | {v} |" for k, v in sim["table"]))
    return {"status": "partial_success" if inferred else "success", "findings": findings,
            "evidence": [evidence("sciencelab-simulation-log", f"{kind}: inputs={js_json(sim['inputs'])} outputs={js_json(sim['outputs'])}")],
            "confidence": 0.6 if inferred else 0.85, "limitations": limitations, "proposedActions": []}
