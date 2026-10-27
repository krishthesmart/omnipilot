"""PicturePilot makes pictures for free: the AI model plans a scene and OmniPilot draws it as an
illustration (with no model, a keyword planner does). Still pictures only, and nothing unsafe or realistic
pictures of real people. (Ported from server/src/agents/picturePilot.ts.)"""
from __future__ import annotations

import json
import re

from ... import llm, store
from .. import picture
from .base import evidence, model_limitation, previous_turn_text

PLAN_SYSTEM = ("You are Helper's picture planner. Plan a simple, friendly illustration for the user's request. Pick a scene and place objects from the allowed list. "
               "x and y are the object's centre as a percent of the picture's width and height (y=0 is the top; the ground starts at y=72, so ground objects sit around y=60-80 and sky objects around y=10-40). "
               "size is the object's height as a percent of the picture's height. Use the colours the user mentions. Include only what fits the request, 2-10 objects.")
PLAN_SCHEMA = {"type": "object", "properties": {"title": {"type": "string"}, "scene": {"type": "string", "enum": picture.SCENES},
                                                "objects": {"type": "array", "items": {"type": "object", "properties": {"kind": {"type": "string", "enum": picture.KINDS}, "x": {"type": "number"}, "y": {"type": "number"},
                                                                                                                       "size": {"type": "number"}, "color": {"type": "string"}}, "required": ["kind", "x", "y", "size"]}, "minItems": 1, "maxItems": 12},
                                                "caption": {"type": "string"}}, "required": ["title", "scene", "objects", "caption"]}
EXAMPLE = {"user": "Draw a red car next to a house on a sunny day", "assistant": json.dumps({"title": "Red car by the house", "scene": "day", "objects": [
    {"kind": "sun", "x": 85, "y": 15, "size": 20}, {"kind": "cloud", "x": 30, "y": 15, "size": 14}, {"kind": "house", "x": 35, "y": 58, "size": 38},
    {"kind": "car", "x": 70, "y": 72, "size": 18, "color": "red"}, {"kind": "tree", "x": 10, "y": 58, "size": 40}], "caption": "A red car parked beside a cosy house under a bright sun."}, separators=(",", ":"))}
WANTS_VIDEO = re.compile(r"\b(video|animation|animated|movie|clip|gif)\b", re.I | re.A)


async def run(input: dict, ctx: dict) -> dict:
    prompt, run_id = input["requestText"], input["runId"]
    unsafe = picture.unsafe_reason(prompt)
    if unsafe:
        store.audit(run_id, "Helper", "make_picture", {"prompt": prompt[:200]}, "refused")
        return {"status": "failed_safe", "findings": [f"{unsafe} I'm happy to draw something else: an animal, a place, a robot, a space scene…"], "evidence": [], "confidence": 0.9, "limitations": [], "proposedActions": []}
    notes = ["I make still pictures only: video generation isn't offered."] if WANTS_VIDEO.search(prompt) else []
    raw = await llm.generate_json(PLAN_SYSTEM, prompt + previous_turn_text(input), schema=PLAN_SCHEMA, examples=[EXAMPLE], temperature=0.4, max_tokens=700)
    planned = picture.validate_plan(raw, prompt)
    spec = planned or picture.plan_from_words(prompt)
    src = picture.svg_data_uri(picture.render_svg(spec))
    a = llm.last_answer.get() or {}
    store.audit(run_id, "Helper", "make_picture", {"mode": "illustration", "planner": a.get("model") if planned else "keywords", "objects": len(spec["objects"])}, "completed")
    return {"status": "success", "findings": [f"Here's your picture: **{spec['title']}**." + (f" {spec['caption']}" if spec["caption"] else ""), *notes],
            "evidence": [evidence(f"ai-model:{a.get('model')}" if planned else "picturepilot:keywords", f"{len(spec['objects'])} objects, {spec['scene']} scene")],
            "confidence": 0.7 if planned else 0.55,
            "limitations": ["This is a simple illustration drawn from a set of shapes, not a photo-style image.", *([model_limitation()] if planned else [])],
            "proposedActions": [], "attachments": [{"type": "picture", "title": spec["title"], "caption": spec["caption"], "src": src, "mode": "illustration"}]}
