"""HardwarePilot's library of hand-checked wiring guides (data/circuits.json, generated from the TypeScript
engine's) and the checks every model-drafted diagram must pass before it's drawn: wires only between real
pins, steps that wire the pins they mention, and no shorts (power to ground, a rail to a signal pin, two
signal pins together). (Ported from server/src/lib/circuits.ts.)"""
from __future__ import annotations

import json
import re
from pathlib import Path

_DATA = json.loads((Path(__file__).parent / "data" / "circuits.json").read_text(encoding="utf-8"))
F = re.I | re.A
CIRCUITS = [(re.compile(c["match"], F), c["spec"]) for c in _DATA["circuits"]]
MODULES = [(re.compile(m["match"], F), m["spec"]) for m in _DATA["modules"]]
KINDS = ["board", "breadboard", "led", "resistor", "button", "sensor", "motor", "device", "port", "power"]


def find_circuit(text: str) -> dict | None:
    return next((s for p, s in CIRCUITS if p.search(text)), None) or next((s for p, s in MODULES if p.search(text)), None)


def all_guides() -> list[dict]:
    return [s for _, s in CIRCUITS] + [s for _, s in MODULES]


def guide(id: str) -> dict:
    return next(s for s in all_guides() if s["id"] == id)


def steps_inconsistent(spec: dict) -> str | None:
    label = {f"{c['id']}.{p['id']}": f"{p['id']} {p['label']}" for c in spec["components"] for p in c["pins"]}
    for step in spec["steps"]:
        mentioned = re.findall(r"\b(?:D\d{1,2}|A\d|5V|3\.3V|GND)\b", step["text"], re.A)
        wired = " ".join(label.get(ref, ref) for i in step["wires"] for ref in (spec["wires"][i]["from"], spec["wires"][i]["to"])).lower()
        missing = [m for m in mentioned if m.lower() not in wired and not (m == "3.3V" and "3v3" in wired)]
        if missing:
            return f"step \"{step['text']}\" mentions {', '.join(missing)} but doesn't wire it"
    return None


def validate_spec(raw) -> dict | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("components"), list) or not isinstance(raw.get("wires"), list):
        return None
    components = [{"id": c["id"], "label": c["label"], "kind": c.get("kind") if c.get("kind") in KINDS else "device",
                   "pins": [{"id": p["id"], "label": p["label"] if isinstance(p.get("label"), str) else p["id"]} for p in c["pins"] if isinstance(p, dict) and isinstance(p.get("id"), str)]}
                  for c in raw["components"] if isinstance(c, dict) and isinstance(c.get("id"), str) and isinstance(c.get("label"), str) and isinstance(c.get("pins"), list)]
    pin_ids = {f"{c['id']}.{p['id']}" for c in components for p in c["pins"]}
    wire_map: dict[int, int] = {}
    wires = []
    for i, w in enumerate(raw["wires"]):
        if isinstance(w, dict) and w.get("from") in pin_ids and w.get("to") in pin_ids and w["from"] != w["to"]:
            wire_map[i] = len(wires)
            color = w.get("color") if isinstance(w.get("color"), str) and re.match(r"^#[0-9a-f]{6}$", w["color"], re.I) else "#6366f1"
            wires.append({"from": w["from"], "to": w["to"], "color": color, **({"label": w["label"]} if isinstance(w.get("label"), str) else {})})
    if not wires:
        return None
    steps = []
    for s in raw.get("steps") if isinstance(raw.get("steps"), list) else []:
        if isinstance(s, dict) and isinstance(s.get("text"), str):
            idx = [wire_map[i] for i in (s.get("wires") if isinstance(s.get("wires"), list) else []) if isinstance(i, int) and not isinstance(i, bool) and i in wire_map]
            steps.append({"text": s["text"], "wires": idx, **({"tip": s["tip"]} if isinstance(s.get("tip"), str) else {})})
    title = raw["title"] if isinstance(raw.get("title"), str) else None
    return {"id": "drafted", "title": title or "How to connect it", "components": components, "wires": wires,
            "steps": steps or [{"text": f"Connect {w['from']} to {w['to']}.", "wires": [i]} for i, w in enumerate(wires)],
            "safety": [x for x in raw["safety"] if isinstance(x, str)] if isinstance(raw.get("safety"), list) else [],
            "videoQuery": raw["videoQuery"] if isinstance(raw.get("videoQuery"), str) else (title or "how to connect"), "verified": False}


def _pin_role(kind: str, pin: dict) -> str:
    text = f"{pin['id']} {pin['label']}"
    if re.search(r"\b(gnd|ground|vss|0v)\b", text, F):
        return "ground"
    if re.search(r"\b(5v|3v3|3\.3v|vcc|vin|vdd|12v|power)\b", text, F) and kind not in ("device", "port"):
        return "power"
    if kind == "board" and re.search(r"\b(d\d+|a\d+|gpio\s?\d+|io\d+|pin\s?\d+)\b", text, F):
        return "io"
    return "other"


def electrical_problem(spec: dict) -> str | None:
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        while parent.get(x) and parent[x] != x:
            x = parent[x]
        return x

    roles: dict[str, tuple[str, str]] = {}
    for c in spec["components"]:
        for p in c["pins"]:
            ref = f"{c['id']}.{p['id']}"
            parent[ref] = ref
            roles[ref] = (_pin_role(c["kind"], p), f"{c['label']} {p['label']}")
    for w in spec["wires"]:
        if w["from"] in parent and w["to"] in parent:
            parent[find(w["from"])] = find(w["to"])
    nets: dict[str, list[tuple[str, str]]] = {}
    for ref, r in roles.items():
        nets.setdefault(find(ref), []).append(r)
    for net in nets.values():
        of = lambda role: [n for n in net if n[0] == role]
        if of("power") and of("ground"):
            return f"{of('power')[0][1]} is connected to {of('ground')[0][1]}: that's a short circuit."
        if of("power") and of("io"):
            return f"{of('io')[0][1]} is tied directly to {of('power')[0][1]}; a signal pin must not be wired to a power rail."
        if len(of("io")) > 1:
            return f"{of('io')[0][1]} and {of('io')[1][1]} are wired together; each part's pin should go to one board pin."
    return None
