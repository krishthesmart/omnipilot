"""ModelPilot: interactive 3D models you can explore part by part. Known molecules are built exactly (real
bond lengths and angles, no AI); everything else is designed by the AI as named parts (a hard job, so
Groq's stronger models first), then checked: floating parts and wrong overall proportions get one repair
round, kept only if better, and the model is placed on the floor. Each conversation remembers its latest
model, so "make it blue" edits it. (Ported from server/src/agents/modelPilot.ts.)"""
from __future__ import annotations

import json
import re

from ... import llm, store
from .. import model3d
from .base import evidence
from .jsfmt import js_str, to_fixed

EDIT = re.compile(r"^(now\s+|please\s+|can you\s+|also\s+)?(make|add|remove|delete|change|turn|move|resize|scale|color|colour|paint|rotate|put|give|replace|swap|bigger|smaller|taller|shorter)\b", re.I | re.A)
PART_SCHEMA = {"type": "object", "properties": {"id": {"type": "string"}, "name": {"type": "string"}, "description": {"type": "string"}, "shape": {"type": "string", "enum": model3d.SHAPES},
                                                "size": {"type": "array", "items": {"type": "number"}}, "position": {"type": "array", "items": {"type": "number"}}, "rotation": {"type": "array", "items": {"type": "number"}},
                                                "color": {"type": "string"}, "material": {"type": "string", "enum": model3d.MATERIALS}, "group": {"type": "string"}},
               "required": ["id", "name", "description", "shape", "size", "position", "rotation", "color", "material", "group"]}
MODEL_SCHEMA = {"type": "object", "properties": {"title": {"type": "string"}, "description": {"type": "string"}, "units": {"type": "string"}, "separate": {"type": "boolean"},
                                                 "notes": {"type": "array", "items": {"type": "string"}}, "real_size": {"type": "array", "items": {"type": "number"}}, "parts": {"type": "array", "items": PART_SCHEMA}},
                "required": ["title", "description", "units", "separate", "notes", "real_size", "parts"]}
DESIGN_SYSTEM = """You are an expert 3D modeller and engineer. Build the requested object from primitive parts so it is recognisable, well proportioned and educational to explore.
Coordinates: y is up, the object stands on y = 0, centred on x = 0, z = 0. Use real-world proportions in the stated units.
Shapes and size arrays: box [width, height, depth]; sphere [radius]; cylinder [radiusTop, height, radiusBottom] (axis along y); cone [radius, height] (axis along y, point up); torus [radius, tube] (ring in the x-y plane); capsule [radius, length] (axis along y).
rotation is [x, y, z] in degrees. Position is the part's centre.
Rules:
- 20 to 90 parts. Include the internal parts that make it interesting to explore (for devices: battery, circuit board, chips, fans, speakers; for machines: motor, gears, axles), each with a clear 1-2 sentence description of what it does.
- Every part must touch or overlap the part it attaches to: nothing floats unless the object is truly made of separate pieces (then set separate=true).
- Realistic colours (#rrggbb) and materials. Group parts into subsystems with a short group name.
- notes: 2-4 interesting facts about how the real object works.
- real_size: the real object's overall [width (x), height (y), depth (z)] in the stated units. The model's overall size must match it."""
EDIT_SYSTEM = """You edit an existing 3D model made of primitive parts (same format and rules as before: y up, standing on y = 0, size arrays per shape, rotation in degrees).
Apply exactly the requested change, keep every other part unchanged (same ids), keep attached parts touching, and return the COMPLETE updated model."""
DIMS_SCHEMA = {"type": "object", "properties": {"object": {"type": "string"}, "width": {"type": "number"}, "height": {"type": "number"}, "depth": {"type": "number"}, "units": {"type": "string", "enum": ["mm", "cm", "m"]},
                                                "known": {"type": "boolean"}}, "required": ["object", "width", "height", "depth", "units", "known"]}


def save_model(conversation_id: str | None, m: dict) -> None:
    if conversation_id:
        store.x("INSERT OR REPLACE INTO models3d (conversation_id, model, updated_at) VALUES (?, ?, ?)", conversation_id, json.dumps(m, ensure_ascii=False), store.now())


def last_model(conversation_id: str | None) -> dict | None:
    r = store.q1("SELECT model FROM models3d WHERE conversation_id = ?", conversation_id) if conversation_id else None
    return model3d.validate_model(json.loads(r["model"])) if r else None


def summary(m: dict) -> str:
    groups: dict[str, int] = {}
    for p in m["parts"]:
        groups[p["group"]] = groups.get(p["group"], 0) + 1
    b = model3d.model_bounds(m)
    dims = " × ".join(to_fixed(b["max"][k] - b["min"][k], 1) for k in range(3))
    return f"{len(m['parts'])} parts in {len(groups)} group{'' if len(groups) == 1 else 's'} ({', '.join(f'{g}: {n}' for g, n in groups.items())}); about {dims} {m['units']} (width × height × depth)."


async def design(system: str, user: str) -> dict | None:
    raw = await llm.generate_json(system, user, schema=MODEL_SCHEMA, temperature=0.3, max_tokens=14_000, hard=True, max_input=60_000)
    m = model3d.validate_model(raw)
    real = [float(n) for n in raw["real_size"] if isinstance(n, (int, float)) and not isinstance(n, bool) and n > 0] if isinstance(raw, dict) and isinstance(raw.get("real_size"), list) else []
    return {**m, **({"realSize": real} if len(real) == 3 else {})} if m else None


async def real_dimensions(request: str) -> dict | None:
    r = await llm.generate_json("What are the real overall dimensions of the object the user wants a 3D model of, as it normally stands or sits (width = left-right, height = up-down, depth = front-back)? Use well-known published dimensions when they exist. Choose sensible units (mm, cm or m). known=false if it's imaginary or has no typical size.",
                                request, schema=DIMS_SCHEMA, temperature=0, max_tokens=600, hard=True)
    if not isinstance(r, dict) or not r.get("known"):
        return None
    try:
        size = [float(r["width"]), float(r["height"]), float(r["depth"])]
    except (TypeError, ValueError, KeyError):
        return None
    return {"size": size, "units": r.get("units", "cm")} if all(n > 0 for n in size) else None


def proportion_problem(m: dict, real) -> str | None:
    if not real or len(real) != 3:
        return None
    b = model3d.model_bounds(m)
    have = [b["max"][k] - b["min"][k] for k in range(3)]
    hs, rs = sorted(have, reverse=True), sorted(real, reverse=True)
    off = any(abs(h - rs[i]) > rs[0] * 0.05 if rs[i] < rs[0] * 0.05 else abs(h / rs[i] - 1) > 0.25 for i, h in enumerate(hs))
    return f"The model measures {' x '.join(to_fixed(n, 1) for n in have)} {m['units']} (x by y by z), but the real object is {' x '.join(js_str(n) for n in real)} {m['units']}." if off else None


async def run(input: dict, ctx: dict) -> dict:
    text, run_id = input["requestText"], input["runId"]
    cid = (input.get("context") or {}).get("conversationId")
    cid = cid if isinstance(cid, str) else None
    molecule = model3d.molecule_in(text)
    if molecule:
        m = model3d.molecule_model(molecule)
        save_model(cid, m)
        store.audit(run_id, "ScienceLab", "molecule_model", {"molecule": molecule}, "completed")
        return {"status": "success", "findings": [f"**{m['title']}**: {m['description']}", "Drag to rotate, scroll to zoom, click an atom or bond to see what it is. Use the exploded view to pull the atoms apart."],
                "evidence": [evidence("molecule-geometry", "Measured bond lengths and angles (built exactly, not by the AI).")], "confidence": 0.95, "limitations": m["notes"], "proposedActions": [],
                "attachments": [{"type": "model-3d", "model": m}]}
    if not await llm.available():
        return {"status": "partial_success", "findings": ["Designing a 3D model needs the AI model (Groq), which isn't available right now. (Molecules like water, CO2, methane, ammonia and benzene work without it.)"],
                "evidence": [], "confidence": 0.1, "limitations": [], "proposedActions": []}
    previous = last_model(cid) if EDIT.search(text) else None
    target = None if previous else await real_dimensions(text)
    if previous:
        model = await design(EDIT_SYSTEM, f"Current model:\n{json.dumps(previous, separators=(',', ':'), ensure_ascii=False)}\n\nChange: {text}")
    else:
        model = await design(DESIGN_SYSTEM, text + (f"\n\nThe real object's overall size is {' x '.join(js_str(n) for n in target['size'])} {target['units']} (width x height x depth): match it." if target else ""))
    if model and target:
        model["units"], model["realSize"] = target["units"], target["size"]
    if not model:
        return {"status": "partial_success", "findings": ["The AI didn't return a usable 3D model this time. Try again, or describe the object in a little more detail."], "evidence": [], "confidence": 0.1, "limitations": [], "proposedActions": []}
    real = model.get("realSize")
    floating, proportion = model3d.floating_parts(model), proportion_problem(model, real)
    repairs: list[str] = []
    if floating or proportion:
        problems = ([f"These parts float without touching the rest of the object: {', '.join(p['id'] + ' (' + p['name'] + ')' for p in floating)}. Move or resize them so each touches the part it attaches to."] if floating else []) + \
                   ([f"{proportion} Scale and reposition parts so the overall size and proportions match the real object (keep it standing on y = 0)."] if proportion else [])
        fixed = await design(EDIT_SYSTEM, f"Current model:\n{json.dumps(model, separators=(',', ':'), ensure_ascii=False)}\n\nFix these problems and change nothing else:\n- " + "\n- ".join(problems))
        if fixed:
            f2, p2 = model3d.floating_parts(fixed), proportion_problem(fixed, real)
            if len(f2) + (1 if p2 else 0) < len(floating) + (1 if proportion else 0) or (len(f2) <= len(floating) and not p2 and proportion):
                if proportion and not p2:
                    repairs.append("corrected its size and proportions")
                if len(f2) < len(floating):
                    repairs.append("attached parts that were floating")
                model, floating, proportion = fixed, f2, p2
    model.pop("realSize", None)
    model = model3d.ground_model(model)
    save_model(cid, model)
    a = llm.last_answer.get() or {}
    store.audit(run_id, "ScienceLab", "edit_model" if previous else "design_model", {"parts": len(model["parts"]), "floating": len(floating), "proportionOk": not proportion, "repairs": repairs, "model": a.get("model")}, "completed")
    return {"status": "success",
            "findings": [f"**{model['title']}**{' (updated)' if previous else ''}: {model['description']}", summary(model),
                         *(["**How it works:**\n" + "\n".join(f"- {n}" for n in model["notes"])] if model.get("notes") else []),
                         "Drag to rotate, scroll to zoom, click any part (or pick it in the list) to see what it does, and slide **Explode** to take it apart. Download it as STL for 3D printing or GLB for other 3D apps. Ask for changes like \"make it blue\" or \"add a kickstand\"."
                         + (f" (Checked and {' and '.join(repairs)}.)" if repairs else "")],
            "evidence": [evidence(f"ai-model:{a.get('model')}", "Designed by the AI model from primitive shapes.")], "confidence": 0.55 if floating or proportion else 0.8,
            "limitations": ["Built from simple shapes (boxes, cylinders, spheres...), so it shows the structure and parts, not exact curved surfaces.",
                            *([f"{len(floating)} part(s) may not be attached: {', '.join(p['name'] for p in floating[:5])}."] if floating else []),
                            *([f"Its proportions may be off: {proportion}"] if proportion else []), *([f"Limited to {model3d.MAX_PARTS} parts."] if len(model["parts"]) >= model3d.MAX_PARTS else [])],
            "proposedActions": [], "attachments": [{"type": "model-3d", "model": model}]}
