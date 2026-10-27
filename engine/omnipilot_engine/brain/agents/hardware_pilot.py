"""HardwarePilot: how to physically connect things, as an interactive step-by-step wiring diagram with plain
steps, safety notes, starter code and a link to real how-to videos. Hand-checked guides come first; anything
else is drafted by the AI model, and every wire is checked against real pins (and for shorts) before it's
drawn; a draft that still fails after one retry is never shown. (Ported from server/src/agents/hardwarePilot.ts.)"""
from __future__ import annotations

import json
import re
from urllib.parse import quote

from ... import llm, store
from .. import circuits
from .base import evidence, model_limitation, previous_turn_text

DRAFT_SYSTEM = ("You are CodePilot's wiring guide, a patient electronics and computer-hardware guide for beginners. Describe how to connect what the user asks about as a wiring diagram: "
                "components with named pins, wires that join two pins as \"componentId.pinId\", and short steps in order (each lists the indexes of the wires it adds). "
                "Use correct, standard pin names and voltages. Include safety notes. Keep it to the parts actually needed.")
DRAFT_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "components": {"type": "array", "items": {"type": "object", "properties": {"id": {"type": "string"}, "label": {"type": "string"}, "kind": {"type": "string", "enum": circuits.KINDS},
                                                                               "pins": {"type": "array", "items": {"type": "object", "properties": {"id": {"type": "string"}, "label": {"type": "string"}}, "required": ["id", "label"]}}},
                                                  "required": ["id", "label", "kind", "pins"]}, "minItems": 2, "maxItems": 6},
        "wires": {"type": "array", "items": {"type": "object", "properties": {"from": {"type": "string"}, "to": {"type": "string"}, "color": {"type": "string"}, "label": {"type": "string"}}, "required": ["from", "to", "color"]}, "minItems": 1, "maxItems": 10},
        "steps": {"type": "array", "items": {"type": "object", "properties": {"text": {"type": "string"}, "wires": {"type": "array", "items": {"type": "integer"}}, "tip": {"type": "string"}}, "required": ["text", "wires"]}, "minItems": 1, "maxItems": 8},
        "safety": {"type": "array", "items": {"type": "string"}},
        "videoQuery": {"type": "string"},
    },
    "required": ["title", "components", "wires", "steps", "safety", "videoQuery"],
}
_servo = {k: v for k, v in circuits.guide("arduino-servo").items() if k not in ("id", "code", "verified")}
EXAMPLE = {"user": "How do I connect a servo to my Arduino?", "assistant": json.dumps(_servo, separators=(",", ":"), ensure_ascii=False)}
TITLE_PREFIX = re.compile(r"^(Connect an? |Blink |Read |Make |Measure |Control |Light |Set up )", re.I)


def enc(s: str) -> str:
    """encodeURIComponent."""
    return quote(s, safe="-_.!~*'()")


def steps_markdown(spec: dict) -> str:
    return "\n".join(f"{i + 1}. {s['text']}" + (f"\n   _Tip: {s['tip']}_" if s.get("tip") else "") for i, s in enumerate(spec["steps"]))


async def run(input: dict, ctx: dict) -> dict:
    text = input["requestText"]
    spec = circuits.find_circuit(text)
    rejected = None
    if not spec:
        feedback = ""
        for attempt in range(2):
            raw = await llm.generate_json(DRAFT_SYSTEM, text + previous_turn_text(input) + feedback, schema=DRAFT_SCHEMA, examples=[EXAMPLE], temperature=0.2 if attempt == 0 else 0.5, max_tokens=1200)
            draft = circuits.validate_spec(raw)
            if not draft:
                continue
            copied = not re.search(r"\bservo\b", text, re.I) and re.search(r"\bservo|orange\/yellow\b", json.dumps(draft), re.I)
            rejected = circuits.electrical_problem(draft) or circuits.steps_inconsistent(draft) or ("it copied the servo example instead of this part's real pins" if copied else None)
            if rejected:
                feedback = f"\n\nYour previous answer was rejected: {rejected}. Use this part's real pins, and connect each part pin to exactly one board pin."
            else:
                spec = draft
                break
    a = llm.last_answer.get() or {}
    store.audit(input["runId"], "CodePilot", "build_guide", {"guide": (spec or {}).get("id"), "verified": bool((spec or {}).get("verified")), "model": None if (spec or {}).get("verified") else a.get("model")}, "completed" if spec else "no_guide")
    if not spec:
        guides = "; ".join(TITLE_PREFIX.sub("", g["title"]).lower() for g in circuits.all_guides())
        return {"status": "partial_success",
                "findings": ([f"I drafted a wiring plan but held it back because it wasn't reliable ({rejected})."] if rejected else []) + [
                    "I don't have a checked wiring guide for that, and I won't guess at wiring that could damage your parts. Tell me the exact parts (for example \"Arduino Uno + HC-SR04 sensor\" or \"laptop with USB-C + HDMI monitor\").",
                    f"Guides I know well: {guides}.", f"**Watch it done:** [how-to videos](https://www.youtube.com/results?search_query={enc(text[:80])})"],
                "evidence": [], "confidence": 0.2, "limitations": ["Without a known guide or the AI model, CodePilot can't draw a diagram."], "proposedActions": []}
    findings = [f"**{spec['title']}**\n\n{steps_markdown(spec)}", "**Safety**\n" + "\n".join(f"- {s}" for s in spec["safety"])]
    if spec.get("code"):
        findings.append(f"**Starter code**\n\n```{spec['code']['language']}\n{spec['code']['source']}\n```")
    findings.append(f"**Watch it done:** [how-to videos for \"{spec['videoQuery']}\"](https://www.youtube.com/results?search_query={enc(spec['videoQuery'])})")
    return {"status": "success", "findings": findings, "evidence": [evidence(f"hardware-guide:{spec['id']}" if spec["verified"] else f"ai-model:{a.get('model')}", spec["title"])],
            "confidence": 0.9 if spec["verified"] else 0.5,
            "limitations": ["Pin names follow the most common board/module versions; check the labels printed on your parts."] if spec["verified"]
            else [model_limitation(), "This guide was drafted by the AI model: compare each connection with your parts' datasheet or labels before powering on."],
            "proposedActions": [], "attachments": [{"type": "wiring-diagram", "spec": spec}]}
