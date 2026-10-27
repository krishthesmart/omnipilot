"""The Router: decides which specialists a request needs. A deterministic keyword classifier first
(precise, instant, no network); the AI model is asked only when no keyword matched, and its picks are
guarded (narrow specialists only on-topic, PromptPilot only for compound requests). Same rules as
server/src/router/{decisionModel,route,routerModel}.ts."""
from __future__ import annotations

import json
import re

from .. import llm, patches, store
from .files import named_code_project
from .specs import AGENT_NAMES, BUILD_SOFTWARE, REVIEW_INTENT, SPECS, STRONG_TEACHING, WEB_RESEARCH, rx

TEACHING_ASK = rx(r"\b(explain|teach|quiz|flashcards?|lesson|tutor|help me (learn|understand))\b")
SKILL_CREATE = rx(r"\b(create|make|add|save|set up|setup|build)\b[^.?!]*\b(skill|agent|routine|command|shortcut)\b[^.?!]*\b(called|named)\b")
PROJECT_FIX = rx(r"\b(find|open|locate)\b[^.?!]*\bmy\s+(?:[\w-]+\s+){0,3}projects?\b[^.?!]*\b(fix|debug|problem|bug|not working|broken|doesn'?t work|won'?t|error|crash)\w*\b|\b(fix|debug)\b[^.?!]*\bmy\s+(?:[\w-]+\s+){0,3}projects?\b|\b(problem|bug|error|issue)s?\s+(in|with)\s+my\s+(?:[\w-]+\s+){0,3}projects?\b")
NAMED_INTEGRATION = rx(r"\b(slack|github|notion|google drive|gdrive|google calendar|google docs?|google sheets?|gmail|e-?mails?|inbox|mcp)\b|\b(docs|sheets|slides|drive)\.google\.com\/")
MATH_TRICK = rx(r"\b(math|maths|mental[- ]math|multiplication|arithmetic|number) (tricks?|shortcuts?|hacks?)\b|\bmental math\b")
EDIT_VERBS = rx(r"\b(add|change|update|refactor|rename|implement|improve|extend|convert|rewrite|migrate|modify|upgrade|restructure)\b[^.?!]*\b(my|the|this|our)\s+(?:[\w-]+\s+){0,3}(project|app|codebase|code ?base|repo|program|game|site|website)\b")
ACCOUNT_LINK = rx(r"\b(docs|drive|sheets|slides)\.google\.com\/|\bgithub\.com\/[\w.-]+\/[\w.-]+|\bnotion\.(so|site)\/")
# A request for a single 3D MODEL (ScienceLab's 3D-model skill), as opposed to building a game/app (CodePilot).
MODEL_INTENT = rx(r"\b(3-?d model|model of|a model\b|molecule|molecular|exploded view|take apart|take it apart|ball[- ]and[- ]stick|\bstl\b|\bglb\b|3d print\w*)\b|\bexplore\b[^.?!]*\bparts?\b")
HISTORIC_SCRIPT = re.compile("[ -᚟ᚠ-᛿\U00010000-\U000100FF\U00010300-\U0001032F\U00010380-\U000103DF\U00010900-\U0001091F\U00012000-\U000123FF\U00013000-\U0001342F]")


def keyword_scores(text: str) -> dict[str, int]:
    return {a: sum(1 for p in SPECS[a].keywords if p.search(text)) for a in AGENT_NAMES}


def code_project_named(text: str) -> str | None:
    if not EDIT_VERBS.search(text):
        return None
    try:
        p = named_code_project(patches.workspace_root(), text)
    except OSError:
        return None
    return p.name if p else None


def mentioned_server(text: str) -> str | None:
    for r in store.q("SELECT name FROM mcp_servers ORDER BY name"):
        if re.search(rf"\b{re.escape(r['name'])}\b", text, re.I):
            return r["name"]
    return None


def finalize_selection(text: str, selected: list[str], rationale: dict, scores: dict) -> tuple[list[str], dict, dict]:
    result = list(dict.fromkeys(selected))

    # CodePilot vs the 3D-model skill: a "3D model of X" / molecule is ModelPilot; a game or app (even a "3D
    # game") is a software build for CodePilot. Decide explicitly when both are in play.
    if "ModelPilot" in result and "CodePilot" in result:
        if MODEL_INTENT.search(text):
            result.remove("CodePilot")
            rationale["CodePilot"] = "Not selected: this asks for a 3D model (ScienceLab's 3D-model skill), not a software build."
        else:
            result.remove("ModelPilot")
            rationale["ModelPilot"] = "Not selected: this is a software/game build, which CodePilot does — not a single 3D model."

    if "CodePilot" in result and (BUILD_SOFTWARE.search(text) or code_project_named(text)) and not rx(r"\b(explain|teach|lesson|tutor|help me (learn|understand))\b").search(text):
        for a in ["LearnPilot", "Helper", "MathPilot", "ScienceLab", "SchoolPilot", "PicturePilot"]:
            if a in result:
                result.remove(a)
                rationale[a] = "Not selected: the request is to build software, which CodePilot does."

    if "WatcherPilot" in result and "LearnPilot" in result and not TEACHING_ASK.search(text):
        result.remove("LearnPilot")
        rationale["LearnPilot"] = 'Not selected: "learn ..." here describes the focus task InfraPilot\'s focus control enforces, not a request to be taught.'

    if ACCOUNT_LINK.search(text) and "InfraPilot" in result and "Helper" in result:
        result.remove("Helper")
        rationale["Helper"] = "Not selected: the link needs your account, so InfraPilot reads it through the integration."
    if WEB_RESEARCH.search(text) and "Helper" in result:
        def keep(a: str) -> bool:
            return (a == "Helper"
                    or (a == "CodePilot" and bool(REVIEW_INTENT.search(text)) and bool(rx(r"\b(my|our|this) (code|repo|project|file)").search(text)))
                    or (a == "LearnPilot" and bool(STRONG_TEACHING.search(text)))
                    or (a == "InfraPilot" and bool(rx(r"\b(connect|disconnect)\s+(slack|github|notion|google drive)|\bmcp server\b|\bschedule\b|\bworkflow\b").search(text))))
        droppable = ["CodePilot", "LearnPilot", "PromptPilot", "InfraPilot"]
        reasons = {"LearnPilot": "a lesson", "CodePilot": "a request about your code", "PromptPilot": "a prompt to rewrite", "InfraPilot": "a request to connect an integration"}
        for a in [x for x in result if not keep(x) and x in droppable]:
            rationale[a] = f"Not selected: this is web research for Helper's web tools, not {reasons[a]}."
        result = [a for a in result if keep(a) or a not in droppable]

    if SKILL_CREATE.search(text) and "InfraPilot" in result:
        for a in [x for x in result if x != "InfraPilot"]:
            rationale[a] = "Not selected: this request saves a skill or agent; its description isn't a task to run now."
        result = ["InfraPilot"]

    if "InfraPilot" in result and "Helper" in result and NAMED_INTEGRATION.search(text) and not WEB_RESEARCH.search(text):
        result.remove("Helper")
        rationale["Helper"] = "Not selected: this request is about an integration InfraPilot manages."

    if "Helper" in result and PROJECT_FIX.search(text) and rx(r"\bmy\b").search(text):
        for a in [x for x in result if x != "Helper"]:
            rationale[a] = "Not selected: Helper diagnoses the problem from your project's own code."
        result = ["Helper"]

    if "MathPilot" in result and "LearnPilot" in result and MATH_TRICK.search(text) and not rx(r"\b(quiz|lesson|flashcards?|study plan|practice (problems|questions))\b").search(text):
        result.remove("LearnPilot")
        rationale["LearnPilot"] = "Not selected: ScienceLab's math checks teach math tricks themselves."

    non_prompt = [a for a in result if a != "PromptPilot"]
    if len(non_prompt) >= 3 and "PromptPilot" not in result:
        result.append("PromptPilot")
        rationale["PromptPilot"] = f"Added automatically: the request spans {len(non_prompt)} specialists and benefits from decomposition into per-tool prompts."
        scores["PromptPilot"] = max(scores.get("PromptPilot", 0), 1)

    if not result:
        result = ["Helper"]
        rationale["Helper"] = "No specialist matched; defaulting to Helper as the safest read-only fallback."
        scores["Helper"] = max(scores.get("Helper", 0), 0.1)
    return result, rationale, scores


def decide_agents(text: str) -> dict:
    scores, rationale = {}, {}
    for a in AGENT_NAMES:
        n = sum(1 for p in SPECS[a].keywords if p.search(text))
        scores[a] = n
        rationale[a] = f"Matched {n} keyword pattern(s) for {a}." if n else f"No keyword pattern for {a} matched this request."
    if len(HISTORIC_SCRIPT.findall(text)) >= 4:
        scores["ScriptScholar"] += 1
        rationale["ScriptScholar"] = "The request contains text in a historic script (Phoenician, runes, Ogham, Linear B, hieroglyphs, cuneiform...)."
    project = code_project_named(text)
    if project:
        scores["CodePilot"] = max(scores["CodePilot"], 2)
        rationale["CodePilot"] = f'The request changes the user\'s code project "{project}".'
    server = mentioned_server(text)
    if server and not scores["InfraPilot"]:
        scores["InfraPilot"] = 1
        rationale["InfraPilot"] = f'The request names the MCP server "{server}".'
    selected, rationale, scores = finalize_selection(text, [a for a in AGENT_NAMES if scores[a] > 0], rationale, scores)
    return {"selectedAgents": selected, "rationale": rationale, "scores": scores, "routingMode": "heuristic-only"}


ROUTER_SYSTEM = (
    "You are the routing classifier inside OmniPilot, a multi-agent assistant. Your ONLY job is to decide which specialist agent(s) a user's request needs -- you never answer the request yourself.\n\n"
    f"Specialists (choose only from this exact list of names): {', '.join(AGENT_NAMES)}\n"
    + "\n".join(f"- {a}: {SPECS[a].description}" for a in AGENT_NAMES)
    + "\n\nRules:\n- Select every specialist the request genuinely needs, and no others. Most single questions need exactly one.\n"
    f"- {' and '.join(a for a in AGENT_NAMES if SPECS[a].narrow)} are narrow: never select them unless the request is clearly about their topic.\n- If unsure, choose Helper."
)
ROUTER_EXAMPLES = [
    ("Research how to improve my project, check my code for issues, and create a study plan.", ["Helper", "CodePilot", "LearnPilot"]),
    ("How many days are in a leap year?", ["Helper"]),
    ("If I earn $12 an hour for 30 hours, what do I make?", ["Helper"]),
    ("Write a function that reverses a linked list", ["CodePilot"]),
    ("Teach me how fractions work", ["LearnPilot"]),
    ("How far does a ball thrown at 20 m/s at 45 degrees travel?", ["ScienceLab"]),
    ("Make my Midjourney prompt better: a dog on a beach", ["PromptPilot"]),
    ("How do I wire a button to my Arduino and how does it work?", ["HardwarePilot", "LearnPilot"]),
    ("My kid should learn math for an hour with no AI", ["WatcherPilot"]),
    ("Draw a dragon flying over a castle", ["PicturePilot"]),
    ("Is it true that (a+b)^2 = a^2 + b^2?", ["MathPilot"]),
    ("Solve 3x + 4 = 19", ["Helper"]),
]
ROUTER_SCHEMA = {"type": "object", "properties": {"agents": {"type": "array", "items": {"type": "string", "enum": AGENT_NAMES}, "minItems": 1, "maxItems": 4}}, "required": ["agents"]}


async def call_router_model(text: str) -> list[str] | None:
    import os

    if os.environ.get("ROUTER_MODE") == "heuristic":
        return None
    reply = await llm.generate_json(ROUTER_SYSTEM, text[:2000], schema=ROUTER_SCHEMA, temperature=0, max_tokens=80,
                                    examples=[{"user": u, "assistant": json.dumps({"agents": a})} for u, a in ROUTER_EXAMPLES])
    raw = reply.get("agents") if isinstance(reply, dict) else None
    if not isinstance(raw, list):
        return None
    valid = list(dict.fromkeys(a for a in raw if isinstance(a, str) and a in AGENT_NAMES))
    return valid or None


async def route_request(text: str) -> dict:
    plan = decide_agents(text)
    if any(plan["scores"][a] >= 1 for a in AGENT_NAMES):
        return plan
    picked = await call_router_model(text)
    if not picked:
        return plan
    accepted = [a for a in picked if a != "PromptPilot" and not SPECS[a].narrow]
    rationale, scores = dict(plan["rationale"]), dict(plan["scores"])
    model = llm.local_model()
    for a in AGENT_NAMES:
        if a in accepted:
            scores[a] = max(scores.get(a, 0), 1)
            rationale[a] = f"Selected by {model} (AI model); no keyword pattern matched."
        elif a in picked:
            rationale[a] = f"{model} (AI model) suggested it, but it was not accepted: " + ("PromptPilot is only added for compound requests" if a == "PromptPilot" else "it only handles requests that clearly name its topic") + "."
    base = plan["selectedAgents"] if not accepted else []
    selected, rationale, scores = finalize_selection(text, list(dict.fromkeys(base + accepted)), rationale, scores)
    return {"selectedAgents": selected, "rationale": rationale, "scores": scores, "routingMode": "model", "modelUsed": model, "localModelAgents": picked}
