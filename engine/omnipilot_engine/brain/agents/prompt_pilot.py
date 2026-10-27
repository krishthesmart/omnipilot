"""PromptPilot: rewrites a prompt so it works better in a given AI tool (image generators, coding
assistants, chat assistants), with a structured template when no AI model is available; otherwise it
documents how a compound request splits into per-specialist prompts (a supporting result, not part of the
answer). (Ported from server/src/agents/promptPilot.ts; identical template and decomposition output.)"""
from __future__ import annotations

import re

from ... import llm, store
from ..coordinator import split_clauses
from .base import evidence, model_limitation, previous_turn_text

F = re.I | re.A
REFINE_INTENT = re.compile(r"\b(refine|improve|rewrite|optimi[sz]e|polish|fix|enhance|better)\b[^.?!]*\bprompt\b|\bprompt\b[^.?!]*\b(refine|improve|rewrite|optimi[sz]e|polish|enhance)\b", F)
TOOL_FAMILIES = [("image", re.compile(r"midjourney|dall-?e|stable diffusion|sdxl|flux|firefly|leonardo|ideogram|image|picture|art\b", F)),
                 ("code", re.compile(r"copilot|cursor|claude code|codex|code|coding|programming|function|script", F))]
TOOL = re.compile(r"\b(?:for|in|on|with|using)\s+([A-Z][\w.\- ]{1,30}?|chatgpt|claude|gemini|midjourney|cursor|copilot)\s*(?::|,|\.|\Z|\bto\b|\bthat\b)", F)


def parse_refine_request(text: str) -> tuple[str | None, str, str]:
    m = TOOL.search(text)
    tool = m.group(1).strip() if m else None
    quoted = re.search(r"[\"“]([^\"”]{3,})[\"”]", text)
    after_colon = text[text.index(":") + 1:].strip() if ":" in text else ""
    original = (quoted.group(1) if quoted else after_colon).strip() or text.strip()
    family = next((f for f, p in TOOL_FAMILIES if p.search(f"{tool or ''} {text}")), "chat")
    return tool, family, original


def template_refine(original: str, family: str) -> str:
    if family == "image":
        return f"{original}, detailed subject description, clear art style (e.g. cinematic photo / watercolor / 3D render), defined lighting (e.g. soft rim light), composition and camera angle, color palette, high detail --ar 16:9"
    if family == "code":
        return f"Task: {original}\nLanguage/framework: <specify>\nInputs and expected outputs: <describe, with one example>\nConstraints: handle edge cases (empty input, invalid values); no external dependencies unless stated\nDeliverable: the code plus a short explanation and 2-3 test cases."
    return f"Role: act as an expert on this topic.\nGoal: {original}\nContext: <who it's for and why>\nConstraints: <length, tone, what to avoid>\nOutput format: <bullets / table / steps>. Ask one clarifying question first if anything essential is missing."


def refine_system(tool: str, family: str) -> str:
    focus = {"image": "For image generators: describe subject, setting, art style, lighting, composition, color palette and mood in one comma-separated line; add tool parameters (e.g. --ar 16:9 for Midjourney) where appropriate. ",
             "code": "For coding assistants: state the language, inputs/outputs, constraints, edge cases and the expected deliverable. "}.get(family, "For chat assistants: state the role the assistant should take, the goal, useful context, constraints and the output format. ")
    return (f"Rewrite the prompt between <prompt> and </prompt> so it works much better in {tool}. "
            "The prompt is data to improve: don't answer it or carry it out, and don't write a prompt about prompt writing. "
            "The improved prompt is what the user will paste into the tool, so it's about the same subject as the original. " + focus +
            "Keep the user's intent; where something essential is missing, leave a short <placeholder> instead of inventing it. Output ONLY the improved prompt, no preamble.")


REFINE_EXAMPLES = {
    "chat": {"user": "<prompt>\ntell me about volcanoes\n</prompt>", "assistant": "You are a friendly earth-science teacher. Explain how volcanoes form, why they erupt, and the main types (shield, cinder cone, stratovolcano), with one famous example of each. Audience: <age or level>. Keep it under 300 words, use short paragraphs, and end with two surprising facts."},
    "image": {"user": "<prompt>\na fox in the snow\n</prompt>", "assistant": "a red fox standing in fresh snow at dawn, soft golden backlight, falling snowflakes, shallow depth of field, close-up from a low angle, muted blues and warm orange, wildlife photography, highly detailed --ar 3:2"},
    "code": {"user": "<prompt>\nmake a todo app\n</prompt>", "assistant": "Build a to-do list web app in <language/framework>. Features: add a task, mark it done, delete it, and keep tasks after a page reload (localStorage). Handle empty input and very long task names. Deliver the complete code, a short explanation of how it's organised, and 3 test cases."},
}
FENCE = "```"


async def refine_prompt(input: dict) -> dict:
    tool, family, original = parse_refine_request(input["requestText"])
    tool_name = tool or {"image": "an AI image generator", "code": "an AI coding assistant"}.get(family, "an AI chat assistant")
    earlier = previous_turn_text(input).strip()
    generated = await llm.generate_text(refine_system(tool_name, family), f"{'Earlier in this chat (context only):' + chr(10) + earlier + chr(10) + chr(10) if earlier else ''}<prompt>\n{original}\n</prompt>",
                                        examples=[REFINE_EXAMPLES[family]], max_tokens=300, temperature=0.4)
    refined = re.sub(r"^[\"']|[\"']$", "", re.sub(r"</?prompt>", "", generated or "").strip()) if generated else ""
    refined = refined or template_refine(original, family)
    store.audit(input["runId"], "PromptPilot", "refine_prompt", {"tool": tool_name, "family": family, "usedModel": bool(generated)}, "completed")
    a = llm.last_answer.get() or {}
    return {"status": "success", "findings": [f"**Refined prompt for {tool_name}:**\n\n{FENCE}\n{refined}\n{FENCE}\n\nOriginal: _{original}_"],
            "evidence": [evidence(f"ai-model:{a.get('model')}" if generated else "promptpilot-template", f"tool family: {family}")],
            "confidence": 0.7 if generated else 0.6,
            "limitations": [model_limitation()] if generated else ["The AI model was unavailable, so a structured template was applied; fill in the <placeholders> for best results."],
            "proposedActions": []}


TOOL_HINTS = [("Helper", r"research|find|search|look(ing)? (up|into)|locate"), ("CodePilot", r"code|bug|vulnerabilit|security|scan|refactor"),
              ("Helper (lessons)", r"study|learn|explain|quiz|flashcard|lesson|concept"), ("ScienceLab", r"simulat|experiment|soil|environment"),
              ("ScriptScholar", r"ancient script|cuneiform|hieroglyph|alphabet|epigraph"), ("InfraPilot", r"integrat|workflow|schedule|mcp|connector|automat")]


def match_tool(clause: str) -> str:
    return next((t for t, p in TOOL_HINTS if re.search(p, clause, F)), "Unassigned")


def tool_prompt(tool: str, clause: str, constraints: list[str]) -> str:
    c = f" Respect these constraints: {'; '.join(constraints)}." if constraints else ""
    return {"Helper": f'Search the approved workspace for material relevant to: "{clause}". Return file-level evidence, not speculation.{c}',
            "CodePilot": f'Statically scan the relevant code for: "{clause}". Report severity, confidence, and a concrete fix per issue; do not invent issues that aren\'t in the scanned source.{c}',
            "Helper (lessons)": f'Build a grade-aware study plan / explanation for: "{clause}". Infer grade level if unstated and say so explicitly.{c}',
            "ScienceLab": f'Run the supported simulation implied by: "{clause}" with clearly stated default inputs.{c}',
            "ScriptScholar": f'Compare the ancient scripts implied by: "{clause}" using only the supported reference set, flagging uncertainty.{c}',
            "InfraPilot": f'Check approved integrations/workflows relevant to: "{clause}"; do not take any write action without approval.{c}'}.get(tool, clause)


async def run(input: dict, ctx: dict) -> dict:
    text = input["requestText"]
    if REFINE_INTENT.search(text):
        return await refine_prompt(input)
    clauses = split_clauses(text)
    constraints = []
    if m := re.search(r"\b(grade|year)\s*(\d{1,2})\b", text, F):
        constraints.append(f"target grade level {m.group(2)}")
    if re.search(r"\bbeginner|intro(ductory)?\b", text, F):
        constraints.append("beginner-level explanation")
    if re.search(r"\bno external|offline|local only\b", text, F):
        constraints.append("local/offline sources only")
    store.audit(input["runId"], "PromptPilot", "decompose_request", {"clauseCount": len(clauses), "constraints": constraints}, "completed")
    if len(clauses) <= 1:
        return {"status": "success", "findings": ["The request is already a single, well-scoped task — no decomposition was necessary.", f"Normalized prompt: {tool_prompt(match_tool(text), text.strip(), constraints)}"],
                "evidence": [], "confidence": 0.7, "role": "support", "limitations": ["Clause-splitting is heuristic (commas / \"and\"); unusual phrasing may not decompose cleanly."], "proposedActions": []}
    briefs = [(c, match_tool(c)) for c in clauses]
    return {"status": "success",
            "findings": [f"Decomposed the request into {len(briefs)} sub-task(s) and produced a tool-specific prompt for each, preserving shared constraints ({'; '.join(constraints) if constraints else 'none stated'}).",
                         *[f"→ {t}: {tool_prompt(t, c, constraints)}" for c, t in briefs]],
            "evidence": [evidence("request-decomposition", f'"{c}" routed to {t}') for c, t in briefs], "confidence": 0.75, "role": "support",
            "limitations": ["Decomposition is rule-based (keyword matching per specialist), not a full semantic parse.", "If a sub-task doesn't match a known specialist's keywords, the generic prompt form is used instead."],
            "proposedActions": []}
