"""Every specialist's manifest: what it does, the keyword patterns that route to it, whose results it
builds on, and its time budget. Routing, the model router's prompt, the coordinator's dependency graph and
the time limits all come from here. (Same patterns as server/src/agents/registry.ts; flags re.I | re.A so
\\w and \\b behave as in JavaScript.)"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

F = re.I | re.A


def rx(p: str) -> re.Pattern:
    return re.compile(p, F)


AGENT_NAMES = ["InfraPilot", "Helper", "CodePilot", "PromptPilot", "ScienceLab", "ScriptScholar", "LearnPilot", "WatcherPilot", "HardwarePilot", "MathPilot", "PicturePilot", "SchoolPilot", "ModelPilot"]
# The product plan: a Router and six specialists. The keyword rules below still score 13 abilities (the plan
# decision kept every working capability), but seven of them are skills of a specialist, not agents of their
# own: plans, steps, events, the activity log and results name only the owning specialist (docs/product D16).
SPECIALISTS = ["InfraPilot", "Helper", "CodePilot", "PromptPilot", "ScienceLab", "ScriptScholar"]
SKILL_OWNER = {"LearnPilot": "Helper", "SchoolPilot": "Helper", "PicturePilot": "Helper", "MathPilot": "ScienceLab", "ModelPilot": "ScienceLab",
               "HardwarePilot": "CodePilot", "WatcherPilot": "InfraPilot"}
SKILL_LABEL = {"LearnPilot": "lessons & quizzes", "SchoolPilot": "school planner", "PicturePilot": "pictures", "MathPilot": "math checks",
               "ModelPilot": "3D models", "HardwarePilot": "wiring guides", "WatcherPilot": "focus control"}


def owner(name: str) -> str:
    """The specialist that does this ability (itself, for the six specialists)."""
    return SKILL_OWNER.get(name, name)


def skill_of(name: str) -> str | None:
    return SKILL_LABEL.get(name)

REVIEW_INTENT = rx(r"\b(scan|review|audit)\b|\b(check|fix)\b[^.?!]*\b(my|the|this|our)\s+(code|file|repo|project|function|script)\b|\b(bugs?|vulnerab\w*|security (issues?|holes?|problems?|flaws?)|what'?s wrong)\b")

WEB_RESEARCH = rx("|".join([
    r"\b(visit|browse|open|go to|check)\b[^.?!]*\b(web ?sites?|sites?|pages?|docs|documentation)\b",
    r"\b(official|developer|product)\s+(web ?sites?|sites?|docs|documentation|pages?)\b",
    r"\b(on the web|online|on the internet|search the web|web search|look (it |this |that )?up( online)?|latest news)\b",
    r"\b(visit|browse|go to)\s+(the\s+)?(?!(the |this |that |my |your )?(file|folder|directory|line|function|step|section|settings)\b)[a-z0-9][\w.-]*",
    r"\b(search|google)\s+(for|it|the internet|online)\b",
    r"\b(all\s+(of\s+)?(their|its|the company's)\s+(products|services|apps)|current (price|pricing|ceo|version|release)|latest (version|release|update|price|news)|today'?s (news|price|weather)|stock price|news (about|on))\b",
    r"https?:\/\/",
    r"\bresearch\w*\b[^.?!]*\bfor \d+(\.\d+)?\s*(minutes?|mins?|hours?|seconds?)\b|\b(deep|thorough|in-depth|detailed|comprehensive|extensive) research\b",
]))

STRONG_TEACHING = rx(r"\b(teach|quiz|flashcards?|lesson|tutor|study plan|practice (problems|questions)|\d+(st|nd|rd|th) grader|grade \d+)\b")

HARDWARE_WORDS = "arduino|raspberry|rpi|esp32|breadboard|led|resistor|servo|motor|sensor|circuit|wiring|wires?|solder\\w*|gpio|pins?|hdmi|usb|monitor|cable|printer|keyboard|mouse|speakers?|headphones|router|motherboard|gpu|psu|desktop|tower"

BUILD_SOFTWARE = rx(r"\b(build|create|make|scaffold|develop|code|program)\b[^.?!]*\b(apps?|application|games?|platformer|shooter|roguelike|rpg|arcade|websites?|web ?pages?|web app|apis?|backend|server|cli|bot|program|script|dashboard|tracker|calculator|extension|library|package|codebase)\b|\b(python|javascript|typescript|node(\.?js)?|react|html|java|rust|golang|c\+\+|flask|express)\b[^.?!]*\b(project|app|program)\b")


@dataclass
class BuildsOn:
    agent: str
    reason: str
    when: re.Pattern | None = None


@dataclass
class Spec:
    description: str
    keywords: list[re.Pattern]
    timeout_s: float
    max_retries: int
    narrow: bool = False
    describes_one_thing: bool = False
    builds_on: list[BuildsOn] = field(default_factory=list)


SPECS: dict[str, Spec] = {
    "InfraPilot": Spec(
        "connecting integrations (Slack, GitHub, Notion, Google Calendar, Gmail, Google Drive) and doing things in them once approved (post a Slack message, open a GitHub issue, add to a Notion page, save a Gmail draft); reading and summarizing the user's Gmail; finding, reading and summarizing Google Drive files and saving new Google Docs; adding and using MCP servers and their tools; workflows; creating skills (\"/start_my_day\"), custom agents and daily routines; reading the user's calendar.",
        [rx(p) for p in [
            r"\bintegrat\w*\b", r"\bmcp\b", r"\bmodel context protocol\b", r"\bworkflow\b", r"\bschedule[sd]?\b",
            r"\b(e-?mails?|inbox|gmail)\b", r"\b(google drive|gdrive|google docs?|google sheets?|google slides)\b|\b(in|from|to) my drive\b",
            r"\b(docs|drive|sheets|slides)\.google\.com\/|\bgithub\.com\/[\w.-]+\/[\w.-]+|\bnotion\.(so|site)\/",
            r"\b(post|send|message|tell|announce)\b[^.?!]*\bslack\b|\bslack\b[^.?!]*\b(channel|message)\b",
            r"\b(open|create|file|make|submit)\b[^.?!]*\b(github\s+)?issue\b[^.?!]*\b(github|repo\w*|[\w.-]+\/[\w.-]+)\b", r"\bnotion\b",
            r"\bconnector\b", r"\bcustom agent\b", r"\bautomat\w*\b", r"\bskills?\b", r"\broutines?\b",
            r"\b(create|make|build|add)\b[^.?!]*\bagent\b", r"\bmy agents\b",
            r"\b(my |the )?(calendar|agenda)\b|\b(events|meetings|appointments)\b[^.?!]*\b(today|tomorrow|this week|next)\b",
            rf"\bconnect\b(?![^.?!]*\b({HARDWARE_WORDS})\b)",
        ]], 60, 0),
    "Helper": Spec(
        "general questions, facts, everyday math, and searching the user's own files/notes/docs. The DEFAULT for anything that doesn't clearly fit another specialist.",
        [rx(p) for p in [r"\bresearch\b", r"\bfind\b", r"\bsearch\b", r"\blocate\b", r"\block up\b", r"\bmy (project|notes|docs|files)\b", r"\bimprove my project\b", r"\bcontext\b", r"\bevidence\b"]]
        + [WEB_RESEARCH, rx(r"\bwhat (have )?you (learned|learnt)\b|\b(your|the) lessons\b|\bforget (lesson|everything you)\b")],
        120, 0),
    "CodePilot": Spec(
        "writing code (it runs and tests what it writes), scanning code for bugs/security issues and writing fixes to approve, and its always-on code alerts.",
        [rx(p) for p in [r"\bcode\b", r"\bbug\b", r"\bvulnerabilit\w*\b", r"\bsecurity\b", r"\bscan\b", r"\brefactor\b", r"\bcheck my code\b", r"\bfunction\b", r"\brepo\b"]]
        + [BUILD_SOFTWARE] + [rx(p) for p in [
            r"\b(run|execute|launch)\b[^.?!]*(`[^`]+`|\b(tests?|test suite|command|script|npm|pip|pytest|python3?|main\.py)\b)",
            r"\b(add|change|update|implement|extend|convert|rewrite|modify|upgrade)\b[^.?!]*\b(my|the|this|our)\s+(?:[\w-]+\s+){0,3}(codebase|code ?base|repo|app|game|website|program)\b",
            r"\b(code|security|codepilot) alerts?\b|\balert me\b[^.?!]*\b(issues?|bugs?|vulnerab\w*|problems?)\b",
        ]], 60, 0, builds_on=[BuildsOn("Helper", "scans the files Helper located", REVIEW_INTENT)]),
    "PromptPilot": Spec("rewriting/refining a prompt for an AI tool.", [rx(p) for p in [r"\bprompt\b", r"\bclarify\b", r"\bbetter prompt\b", r"\brephrase\b", r"\binstructions for\b"]], 25, 1),
    "ScienceLab": Spec(
        "ONLY science simulations: projectile motion, free fall, pendulums, population growth, predator–prey, radioactive decay, medicine levels in the body, cooling, soil moisture, and where a soil type is found.",
        [rx(p) for p in [
            r"\bsimulat\w*\b", r"\bexperiment\b", r"\bsoil\b", r"\benvironment\b", r"\bprojectile\b", r"\bpopulation growth\b", r"\bmoisture\b",
            r"\bpendulum\b", r"\bhalf[- ]?life\b|\bradioactive\b|\bcarbon[- ]14\b", r"\bfree[- ]?fall\b|\bdropped (from|off)\b|\bfalls? from\b",
            r"\b(predators?|prey|lotka)\b", r"\bnewton'?s law of cooling\b|\b(coffee|tea)\b[^.?!]*\bcool",
            r"\b(mg|dose|medicine|drug)\b[^.?!]*\b(in (my|the) body|bloodstream|half[- ]?life|every \d+ hours?)\b",
            r"\b(soil|dirt)\b[^.?!]*\b(where|location|region|which (place|part))\b|\bwhere\b[^.?!]*\b(soil|dirt)\b",
            r"\b(thrown|launched|kicked|fired|shot)\b[^.?!]*\b(m\/s|km\/h|degrees?|upward|in the air|how far|how high)\b",
        ]], 6, 1, narrow=True),
    "ScriptScholar": Spec(
        "ONLY ancient writing systems (hieroglyphs, cuneiform, Linear A/B, Phoenician, Brahmi, runes...): comparing them, and analysing/deciphering text in an unknown or ancient script.",
        [rx(p) for p in [
            r"\bancient script\b", r"\bcuneiform\b", r"\bhieroglyph\w*\b", r"\bphoenician\b", r"\blinear [ab]\b", r"\bbrahmi\b", r"\bepigraph\w*\b", r"\balphabet\b",
            r"\bdecipher\w*\b", r"\b(unknown|mystery|undeciphered|ancient) (script|writing|symbols|inscription)s?\b", r"\b(runes?|runic|ogham|inscription|transliterat\w*)\b",
        ]], 4, 1, narrow=True),
    "LearnPilot": Spec(
        "teaching -- explanations, lessons, quizzes, flashcards, study plans.",
        [rx(p) for p in [
            r"\bstudy\b", r"\blearn\b", r"\bexplain\b", r"\bquiz\b", r"\bflashcard\b", r"\blesson\b", r"\bconcept\b", r"\bgrade(r)?\b", r"\btutor\b", r"\bhomework\b", r"\bteach\b",
            r"\bhow (does|do) (it|this|that|they|these|those)\b[^?.!]*\bwork", r"\bwhy does (it|this|that) work\b",
        ]], 45, 0, builds_on=[
            BuildsOn("HardwarePilot", "explains the concepts behind HardwarePilot's wiring (voltage, ground, resistors...)"),
            BuildsOn("CodePilot", "teaches the concepts behind CodePilot's code or findings"),
            BuildsOn("ScienceLab", "explains ScienceLab's simulation results"),
            BuildsOn("ScriptScholar", "builds the lesson on ScriptScholar's comparison"),
            BuildsOn("InfraPilot", "teaches and quizzes from the Google Drive file InfraPilot reads", rx(r"\b(google drive|gdrive|my drive|google docs?)\b")),
        ]),
    "WatcherPilot": Spec(
        "parental focus control (like GoGuardian): sets up a focus session from a parent's instruction (e.g. \"learn math, no AI\"), blocks AI sites/extensions and off-task sites, answers whether a site is allowed.",
        [rx(p) for p in [
            r"\bno ai\b", r"\bblock (all )?(ai|sites?|websites?|apps?|youtube|games?|extensions?)\b", r"\bfocus (mode|time|session)\b",
            r"\bparental\b", r"\bscreen ?time\b", r"\bon[- ]task\b", r"\bdistract\w*\b", r"\bgoguardian\b", r"\bwatcher\b",
            r"\b(is|are) \S+(\s\S+)? (allowed|blocked)\b", r"\bunblock\b",
        ]], 20, 0, narrow=True),
    "HardwarePilot": Spec(
        "how to physically connect hardware: Arduino/Raspberry Pi circuits, sensors, LEDs, motors, and plugging in monitors, PCs and devices -- with an interactive step-by-step wiring diagram.",
        [rx(rf"\b({HARDWARE_WORDS})\b"), rx(r"\bhardware\b"), rx(r"\bplug (in|into)\b"), rx(r"\bhook (up|it up)\b")], 30, 0),
    "MathPilot": Spec(
        "checking whether a math identity/equation is true (e.g. \"is sin(x)^2 + cos(x)^2 = 1?\"), reporting its always-on search for new formulas for constants like pi, and teaching mental-math tricks (\"a quick way to do 34 × 11\").",
        [rx(p) for p in [
            r"\bmathpilot\b", r"\bidentit(y|ies)\b", r"\bconjectures?\b", r"\bcontinued fractions?\b", r"\bmath(s)? discover\w*\b",
            r"\b(math|maths|mental[- ]math|multiplication|arithmetic|divisibility) (tricks?|shortcuts?|hacks?)\b|\bmental math\b|\b(tricks?|shortcut) (for|to)\b[^.?!]*\b(multiply|multiplying|squar|divid|times|percent|\d)",
            r"\bquick(ly| way)\b[^.?!]*\b(multiply|multiplying|square|squaring|times|divide|dividing)\b|\bin (your|my) head\b",
            r"\b(new|undiscovered) (math|formulas?)\b", r"\b(formulas?|discoveries) for (pi|π|e|zeta|catalan)\b",
            r"^(?![^=]*\b(solve|find|what is|what's|how much|calculate)\b)(?![\s\S]*([;{}'\"`]|\b(const|let|var|function|def|return|select|import)\b))[^=]*\b(is it true|check|verify|prove|test|confirm|is|does)\b[^=]*[^<>!=]=(?!=)",
        ]], 25, 0, narrow=True),
    "PicturePilot": Spec(
        "making a picture or illustration (\"draw a cat in space\"). Still images only, no video.",
        [rx(p) for p in [
            r"\b(draw|sketch|paint|illustrate)\b(?![^.?!]*\b(diagram|circuit|wiring|schematic|graph|chart|conclusion)s?\b)",
            r"\b(make|create|generate|design|show)\b[^.?!]*\b(picture|image|drawing|illustration|painting|poster|artwork|wallpaper)\b",
            r"\b(picture|image|drawing|illustration|painting) of\b",
        ]], 45, 0, narrow=True, describes_one_thing=True),
    "SchoolPilot": Spec(
        "school stuff: keeping track of homework, projects and tests with due dates (\"I have a science project due Friday\", \"what's due?\"), planning big assignments and study sessions before a test, and helping with essays and homework step by step.",
        [rx(p) for p in [
            r"\b(homework|assignments?|worksheet|science fair|school project|book report|lab report)\b",
            r"\bwhat'?s due\b|\bdue (on |by |this |next )?(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|in \d+ days?)\b",
            # a test ON A DAY ("quiz on Friday", "test next week"), not a quiz ON A TOPIC ("a quiz on photosynthesis")
            r"\b(test|exam|quiz|midterm|final)s? (is |are )?(on |next |this )?(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|\d)",
            r"\b(essay|paper)\b[^.?!]*\b(outline|thesis|due|feedback|for (school|class))\b|\b(outline|thesis) for my (essay|paper)\b",
            r"\b(school|teacher|my class(es)?)\b",
        ]], 45, 0),
    "ModelPilot": Spec(
        "interactive 3D models you can rotate, take apart (exploded view) and click part by part, exported for 3D printing (\"build a 3D model of a game console you can explore through its parts\", \"a 3D water molecule\", then \"make it blue\"). Exact ball-and-stick molecules.",
        [rx(p) for p in [r"\b3-?d\b", r"\b(cad|stl|glb|3d print\w*)\b", r"\b(model|replica|mock-?up)\b[^.?!]*\b(explore|parts?|take apart|exploded|rotate)\b", r"\b(molecule|molecular model|ball[- ]and[- ]stick)\b"]],
        150, 0, describes_one_thing=True),
}


def search(p: re.Pattern, text: str) -> bool:
    return p.search(text) is not None


# Whole projects (CodePilot's project builder) and changes across an existing project.
_BUILD_VERB = r"\b(build|create|make|scaffold|generate|write|develop|code|set up|start)\b"
EXPLICIT_PROJECT = rx(_BUILD_VERB + r"[^.?!]*\b(project|multi[- ]?file|full[- ]?stack|codebase|several files|multiple files|backend|rest api|api server|web server|cli tool|command[- ]line (tool|app)|library|package|with (unit )?tests)\b")
APP_LIKE = rx(_BUILD_VERB + r"[^.?!]*\b(app|application|game|platformer|shooter|roguelike|rpg|website|web app|system|dashboard|tracker|manager|bot|simulator|platform|tool)\b")
SINGLE_FILE = rx(r"\b(function|snippet|regex|one[- ]liner|single (file|page)|web ?page|landing page|html page|browser game|script that)\b")
EDIT_PROJECT = rx(r"\b(add|change|update|refactor|rename|implement|improve|extend|convert|rewrite|migrate|modify|upgrade|restructure|split)\b[^.?!]*\b(my|the|this|our)\s+(?:[\w-]+\s+){0,3}(project|app|codebase|code ?base|repo|program|game|site|website)\b")


def is_project_request(text: str) -> bool:
    return bool(EXPLICIT_PROJECT.search(text)) or (bool(APP_LIKE.search(text)) and not SINGLE_FILE.search(text))
