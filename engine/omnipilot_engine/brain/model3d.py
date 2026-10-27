"""ModelPilot's 3D models: named parts (primitive shapes) the app renders with three.js (rotate, explode,
click part by part, export STL/GLB). Everything the AI writes is validated and clamped here and checked for
parts that float in the air. Known molecules are built exactly from measured bond lengths and angles.
(Ported from server/src/lib/model3d.ts.)"""
from __future__ import annotations

import math
import re

from .agents.jsfmt import js_round, to_fixed

SHAPES = ["box", "sphere", "cylinder", "cone", "torus", "capsule"]
MATERIALS = ["plastic", "metal", "glass", "rubber", "wood", "emissive", "matte"]
MAX_PARTS = 150
SIZE_LEN = {"box": 3, "sphere": 1, "cylinder": 3, "cone": 2, "torus": 2, "capsule": 2}
DEFAULT_SIZE = {"box": [1, 1, 1], "sphere": [0.5], "cylinder": [0.5, 1, 0.5], "cone": [0.5, 1], "torus": [0.5, 0.15], "capsule": [0.3, 1]}


def js_string(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        from .agents.jsfmt import js_str
        return js_str(v)
    if isinstance(v, list):
        return ",".join("" if x is None else js_string(x) for x in v)
    if isinstance(v, dict):
        return "[object Object]"
    return str(v)


def _js_number(v) -> float:
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if v is None:
        return 0.0
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return 0.0
        try:
            return float(int(s, 16)) if re.match(r"^0x[0-9a-f]+$", s, re.I) else float(s) if re.match(r"^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$|^[+-]?Infinity$", s, re.I) else math.nan
        except ValueError:
            return math.nan
    return math.nan


def num(v, fallback: float, lo: float = -1e4, hi: float = 1e4) -> float:
    n = _js_number(v) if not isinstance(v, (list, dict)) else (math.nan if isinstance(v, dict) else _js_number(js_string(v)))
    return min(hi, max(lo, n)) if math.isfinite(n) else fallback


def vec3(v, fallback: float) -> list[float]:
    a = v if isinstance(v, list) else []
    return [num(a[k] if k < len(a) else None, fallback) if k < len(a) else fallback for k in range(3)]


def validate_model(raw) -> dict | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("parts"), list):
        return None
    ids: set[str] = set()
    parts = []
    for i, p in enumerate(raw["parts"][:MAX_PARTS]):
        if not isinstance(p, dict):
            continue
        shape = p.get("shape") if p.get("shape") in SHAPES else "box"
        size_in = p.get("size") if isinstance(p.get("size"), list) else []
        size = [num(size_in[k] if k < len(size_in) else None, d, 0.001, 1e4) if k < len(size_in) else d for k, d in enumerate(DEFAULT_SIZE[shape])][:SIZE_LEN[shape]]
        base = p.get("id") if p.get("id") is not None else p.get("name") if p.get("name") is not None else f"part-{i + 1}"
        pid = re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9-]+", "-", js_string(base).lower()))[:40] or f"part-{i + 1}"
        while pid in ids:
            pid = f"{pid}-{i + 1}"
        ids.add(pid)
        color = js_string(p.get("color")) if "color" in p else "undefined"
        if re.match(r"^#[0-9a-f]{6}$", color, re.I):
            col = color
        elif re.match(r"^#[0-9a-f]{3}$", color, re.I):
            col = "#" + "".join(c + c for c in color[1:])
        else:
            col = "#9aa4b2"
        parts.append({"id": pid, "name": js_string(p.get("name") if p.get("name") is not None else pid)[:60], "description": js_string(p.get("description") if p.get("description") is not None else "")[:400],
                      "shape": shape, "size": size, "position": vec3(p.get("position"), 0), "rotation": [math.fmod(math.fmod(d, 360) + 360, 360) for d in vec3(p.get("rotation"), 0)],
                      "color": col, "material": p.get("material") if p.get("material") in MATERIALS else "plastic", "group": js_string(p.get("group") if p.get("group") is not None else "parts")[:40]})
    if not parts:
        return None
    s = lambda k, d: js_string(raw.get(k) if raw.get(k) is not None else d)
    return {"title": s("title", "3D model")[:80], "description": s("description", "")[:600], "units": s("units", "cm")[:10], "parts": parts, "separate": bool(raw.get("separate")),
            "notes": [js_string(n)[:300] for n in raw["notes"][:8]] if isinstance(raw.get("notes"), list) else []}


def rad(d: float) -> float:
    return d * math.pi / 180


def rotate(v, r):
    a, b, c = v
    rx, ry, rz = r
    a, b = a * math.cos(rad(rz)) - b * math.sin(rad(rz)), a * math.sin(rad(rz)) + b * math.cos(rad(rz))
    a, c = a * math.cos(rad(ry)) + c * math.sin(rad(ry)), -a * math.sin(rad(ry)) + c * math.cos(rad(ry))
    b, c = b * math.cos(rad(rx)) - c * math.sin(rad(rx)), b * math.sin(rad(rx)) + c * math.cos(rad(rx))
    return [a, b, c]


def half_extents(p) -> list[float]:
    s = p["size"]
    return {"box": lambda: [s[0] / 2, s[1] / 2, s[2] / 2], "sphere": lambda: [s[0]] * 3, "cylinder": lambda: [max(s[0], s[2]), s[1] / 2, max(s[0], s[2])],
            "cone": lambda: [s[0], s[1] / 2, s[0]], "torus": lambda: [s[0] + s[1], s[0] + s[1], s[1]], "capsule": lambda: [s[0], s[1] / 2 + s[0], s[0]]}[p["shape"]]()


def part_box(p) -> dict:
    hx, hy, hz = half_extents(p)
    mn, mx = [math.inf] * 3, [-math.inf] * 3
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                c = rotate([sx * hx, sy * hy, sz * hz], p["rotation"])
                for k in range(3):
                    mn[k] = min(mn[k], c[k] + p["position"][k])
                    mx[k] = max(mx[k], c[k] + p["position"][k])
    return {"min": mn, "max": mx}


def model_bounds(m) -> dict:
    boxes = [part_box(p) for p in m["parts"]]
    mn = [min(b["min"][k] for b in boxes) for k in range(3)]
    mx = [max(b["max"][k] for b in boxes) for k in range(3)]
    return {"min": mn, "max": mx, "size": max(mx[k] - mn[k] for k in range(3))}


def floating_parts(m) -> list[dict]:
    if m.get("separate") or len(m["parts"]) < 2:
        return []
    boxes = [part_box(p) for p in m["parts"]]
    tol = model_bounds(m)["size"] * 0.02
    touches = lambda a, b: all(boxes[a]["min"][k] - tol <= boxes[b]["max"][k] and boxes[b]["min"][k] - tol <= boxes[a]["max"][k] for k in range(3))
    n = len(m["parts"])
    piece, pieces = [-1] * n, 0
    for i in range(n):
        if piece[i] >= 0:
            continue
        stack, piece[i] = [i], pieces
        while stack:
            a = stack.pop()
            for b in range(n):
                if piece[b] < 0 and touches(a, b):
                    piece[b] = pieces
                    stack.append(b)
        pieces += 1
    if pieces < 2:
        return []
    sizes = [0] * pieces
    for p in piece:
        sizes[p] += 1
    main = sizes.index(max(sizes))
    return [p for i, p in enumerate(m["parts"]) if piece[i] != main]


def ground_model(m) -> dict:
    b = model_bounds(m)
    dx, dy, dz = -(b["min"][0] + b["max"][0]) / 2, -b["min"][1], -(b["min"][2] + b["max"][2]) / 2
    r = lambda n: js_round(n * 1e4) / 1e4
    return {**m, "parts": [{**p, "position": [r(p["position"][0] + dx), r(p["position"][1] + dy), r(p["position"][2] + dz)]} for p in m["parts"]]}


ATOMS = {"H": ("#f5f5f5", 0.31, "hydrogen"), "C": ("#333333", 0.7, "carbon"), "N": ("#3050f8", 0.65, "nitrogen"), "O": ("#ff0d0d", 0.6, "oxygen"),
         "Cl": ("#1ff01f", 0.99, "chlorine"), "Na": ("#ab5cf2", 1.0, "sodium"), "S": ("#ffff30", 1.0, "sulfur")}
TETRA = math.acos(-1 / 3)


def polar(length, theta, phi):
    return [length * math.sin(theta) * math.cos(phi), length * math.cos(theta), length * math.sin(theta) * math.sin(phi)]


def _benzene():
    atoms, bonds = [], []
    for i in range(6):
        a = i * math.pi / 3
        atoms.append(("C", [1.39 * math.cos(a), 0, 1.39 * math.sin(a)]))
    for i in range(6):
        a = i * math.pi / 3
        atoms.append(("H", [2.48 * math.cos(a), 0, 2.48 * math.sin(a)]))
        bonds += [(i, (i + 1) % 6, 1 if i % 2 else 2), (i, i + 6, 1)]
    return "Benzene", "C6H6", atoms, bonds, "A flat ring of six carbons; every C–C bond is 1.39 Å (between a single and a double bond, because the electrons are shared around the ring) and every angle is 120°."


def _water():
    half = rad(104.5 / 2)
    return "Water", "H2O", [("O", [0, 0, 0]), ("H", [0.958 * math.sin(half), -0.958 * math.cos(half), 0]), ("H", [-0.958 * math.sin(half), -0.958 * math.cos(half), 0])], [(0, 1, 1), (0, 2, 1)], \
        "Bent shape: the H–O–H angle is 104.5° and each O–H bond is 0.96 Å. The two lone pairs on oxygen push the hydrogens closer together than a perfect tetrahedron (109.5°)."


def _methane():
    atoms = [("C", [0, 0, 0]), ("H", [0, 1.09, 0])] + [("H", polar(1.09, TETRA, i * 2 * math.pi / 3)) for i in range(3)]
    return "Methane", "CH4", atoms, [(0, 1, 1), (0, 2, 1), (0, 3, 1), (0, 4, 1)], "Tetrahedral: four C–H bonds of 1.09 Å, all 109.5° apart -- as far from each other as four bonds can get."


def _ammonia():
    theta = math.pi - rad(68)
    return "Ammonia", "NH3", [("N", [0, 0, 0])] + [("H", polar(1.01, theta, i * 2 * math.pi / 3)) for i in range(3)], [(0, 1, 1), (0, 2, 1), (0, 3, 1)], \
        "Trigonal pyramid: three N–H bonds of 1.01 Å at about 107°, with a lone pair on top of the nitrogen."


MOLECULES = {
    "water": _water,
    "carbon dioxide": lambda: ("Carbon dioxide", "CO2", [("C", [0, 0, 0]), ("O", [1.16, 0, 0]), ("O", [-1.16, 0, 0])], [(0, 1, 2), (0, 2, 2)], "Linear (180°), with two C=O double bonds of 1.16 Å. The molecule is symmetric, so it has no overall polarity."),
    "methane": _methane,
    "ammonia": _ammonia,
    "oxygen": lambda: ("Oxygen", "O2", [("O", [-0.604, 0, 0]), ("O", [0.604, 0, 0])], [(0, 1, 2)], "Two oxygen atoms joined by a double bond 1.21 Å long."),
    "nitrogen": lambda: ("Nitrogen", "N2", [("N", [-0.55, 0, 0]), ("N", [0.55, 0, 0])], [(0, 1, 3)], "A triple bond (1.10 Å), one of the strongest bonds in chemistry, which is why nitrogen gas is so unreactive."),
    "hydrogen": lambda: ("Hydrogen", "H2", [("H", [-0.37, 0, 0]), ("H", [0.37, 0, 0])], [(0, 1, 1)], "The simplest molecule: two hydrogen atoms sharing two electrons, 0.74 Å apart."),
    "hydrogen chloride": lambda: ("Hydrogen chloride", "HCl", [("H", [-0.64, 0, 0]), ("Cl", [0.64, 0, 0])], [(0, 1, 1)], "A polar bond 1.27 Å long; dissolved in water it becomes hydrochloric acid."),
    "benzene": _benzene,
}
MOLECULE_NAMES = {"h2o": "water", "co2": "carbon dioxide", "ch4": "methane", "nh3": "ammonia", "o2": "oxygen", "n2": "nitrogen", "h2": "hydrogen", "hcl": "hydrogen chloride", "c6h6": "benzene"}


def molecule_in(text: str) -> str | None:
    if not re.search(r"\b(molecule|molecular|atoms?|bonds?|chemical|compound)\b", text, re.I | re.A) and not re.search(r"\b(h2o|co2|ch4|nh3|c6h6|hcl)\b", text, re.I | re.A):
        return None
    if m := re.search(r"\b(h2o|co2|ch4|nh3|o2|n2|h2|hcl|c6h6)\b", text, re.I | re.A):
        return MOLECULE_NAMES[m.group(1).lower()]
    return next((n for n in MOLECULES if re.search(rf"\b{n}\b", text, re.I | re.A)), None)


def align_y(v) -> list[float]:
    length = math.hypot(*v) or 1
    x, y, z = v[0] / length, v[1] / length, v[2] / length
    if y < -0.999999:
        q = [1, 0, 0, 0]
    else:
        axis = [z, 0, -x]
        w = 1 + y
        n = math.hypot(axis[0], axis[1], axis[2], w)
        q = [axis[0] / n, axis[1] / n, axis[2] / n, w / n]
    qx, qy, qz, qw = q
    m11, m12, m13 = 1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)
    m22, m23 = 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)
    m32, m33 = 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)
    ry = math.asin(max(-1, min(1, m13)))
    rx, rz = (math.atan2(-m23, m33), math.atan2(-m12, m11)) if abs(m13) < 0.9999999 else (math.atan2(m32, m22), 0)
    deg = lambda r: js_round(r * 180 / math.pi * 1000) / 1000
    return [deg(rx), deg(ry), deg(rz)]


def molecule_model(name: str) -> dict | None:
    make = MOLECULES.get(name)
    if not make:
        return None
    title, formula, atoms, bonds, facts = make()
    counts: dict[str, int] = {}
    parts = []
    for el, at in atoms:
        color, r, nm = ATOMS[el]
        counts[el] = counts.get(el, 0) + 1
        parts.append({"id": f"{el.lower()}{counts[el]}", "name": f"{nm[0].upper()}{nm[1:]} atom {counts[el]}", "description": f"A {nm} atom ({el}).", "shape": "sphere", "size": [r * 0.55],
                      "position": [js_round(n * 1e4) / 1e4 for n in at], "rotation": [0, 0, 0], "color": color, "material": "plastic", "group": "atoms"})
    for a, b, order in bonds:
        pa, pb = atoms[a][1], atoms[b][1]
        v = [pb[k] - pa[k] for k in range(3)]
        length = math.hypot(*v)
        rot = align_y(v)
        perp = rotate([1, 0, 0], rot)
        for k in range(order):
            off = (k - (order - 1) / 2) * 0.12
            parts.append({"id": f"bond-{a}-{b}-{k}", "name": f"{atoms[a][0]}{'=' if order == 2 else '≡' if order == 3 else '–'}{atoms[b][0]} bond",
                          "description": f"A {'single' if order == 1 else 'double' if order == 2 else 'triple'} bond, {to_fixed(length, 2)} Å long.", "shape": "cylinder", "size": [0.06, length, 0.06],
                          "position": [js_round(((pa[i] + pb[i]) / 2 + perp[i] * off) * 1e4) / 1e4 for i in range(3)], "rotation": rot, "color": "#b0b6c0", "material": "plastic", "group": "bonds"})
    return {"title": f"{title} ({formula})", "description": facts, "units": "Å", "parts": parts, "separate": True,
            "notes": ["Bond lengths and angles are real measured values; atom sizes are scaled down so the bonds are visible."]}
