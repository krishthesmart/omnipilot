"""PicturePilot's renderer. The AI model only plans a picture (a scene type plus objects from a fixed
vocabulary, with positions, sizes and colours); this draws it as an SVG illustration. The model never writes
SVG, so it can't inject markup, and with no model a keyword planner still makes a sensible picture.
(Ported from server/src/lib/picture.ts; identical SVG output.)"""
from __future__ import annotations

import base64
import json
import math
import re
from pathlib import Path

from .agents.jsfmt import js_str, to_fixed

SCENES = ["day", "night", "sunset", "space", "underwater", "indoor", "snow"]
KINDS = ["sun", "moon", "star", "cloud", "rainbow", "bird", "butterfly", "balloon", "planet", "rocket", "tree", "pine", "flower", "mountain", "house", "castle", "car", "boat",
         "cat", "dog", "fish", "person", "robot", "dinosaur", "snowman", "heart", "apple", "book", "ball", "cake", "umbrella"]
W, H, GROUND_Y = 800, 500, 0.72
NAMED_COLORS = {"red", "orange", "yellow", "gold", "green", "lime", "teal", "cyan", "blue", "navy", "purple", "violet", "magenta", "pink",
                "brown", "tan", "black", "white", "gray", "grey", "silver", "maroon", "olive", "coral", "salmon", "turquoise", "indigo", "beige"}
_SHAPES = json.loads((Path(__file__).parent / "data" / "picture_shapes.json").read_text(encoding="utf-8"))["shapes"]


def safe_color(c, fallback: str) -> str:
    if not isinstance(c, str):
        return fallback
    v = c.strip().lower()
    return v if re.match(r"^#[0-9a-f]{3}([0-9a-f]{3})?$", v) or v in NAMED_COLORS else fallback


DEFAULT_COLOR = {"sun": "#ffd23f", "moon": "#f4f1c9", "star": "#ffe66d", "cloud": "#ffffff", "rainbow": "#ff5e5e", "bird": "#3d5a80", "butterfly": "#c77dff",
                 "balloon": "#ef476f", "planet": "#f4a261", "rocket": "#e63946", "tree": "#2a9d8f", "pine": "#1b7a43", "flower": "#ff70a6", "mountain": "#8d99ae",
                 "house": "#e76f51", "castle": "#adb5bd", "car": "#1d70b8", "boat": "#8b5e34", "cat": "#f4a259", "dog": "#a0522d", "fish": "#ff9f1c",
                 "person": "#457b9d", "robot": "#90a4ae", "dinosaur": "#52b788", "snowman": "#ffffff", "heart": "#e5383b", "apple": "#d62828",
                 "book": "#3a86ff", "ball": "#ff595e", "cake": "#ffafcc", "umbrella": "#7209b7"}
SKY = {"sun", "moon", "star", "cloud", "rainbow", "bird", "butterfly", "balloon", "planet", "rocket"}
SIZE = {"sun": 22, "moon": 20, "star": 7, "cloud": 16, "rainbow": 45, "bird": 8, "butterfly": 10, "balloon": 20, "planet": 24, "rocket": 34, "tree": 40, "pine": 42, "flower": 14,
        "mountain": 50, "house": 36, "castle": 48, "car": 18, "boat": 26, "cat": 20, "dog": 22, "fish": 12, "person": 32, "robot": 34, "dinosaur": 40, "snowman": 34,
        "heart": 20, "apple": 14, "book": 16, "ball": 12, "cake": 22, "umbrella": 30}

UNSAFE = re.compile(r"\b(nude|naked|nsfw|porn\w*|sex\w*|erotic|lingerie|topless|gore|gory|blood(y)?|decapitat\w*|dismember\w*|corpse|suicide|self[- ]harm|swastika|nazi|kkk|beheading|torture)\b", re.I | re.A)
REAL_PERSON = re.compile(r"\b(photo|picture|image|deepfake)\s+of\s+(?:president\s+|the\s+)?[A-Z][a-z]+\s+[A-Z][a-z]+", re.A)


def unsafe_reason(prompt: str) -> str | None:
    if UNSAFE.search(prompt):
        return "I can't make that kind of picture."
    if REAL_PERSON.search(prompt):
        return "I don't make realistic pictures of real people."
    return None


SYNONYMS = [("sun|sunny|sunshine", "sun"), ("moon", "moon"), ("stars?|starry", "star"), ("clouds?|cloudy", "cloud"), ("rainbows?", "rainbow"), ("birds?|seagulls?|parrots?", "bird"),
            ("butterfl(?:y|ies)", "butterfly"), ("balloons?", "balloon"), ("planets?|saturn|jupiter|mars", "planet"), ("rockets?|spaceships?|space ship", "rocket"),
            ("pine trees?|christmas trees?|pines?|firs?", "pine"), ("(?<!pine )(?<!christmas )trees?|forest|park", "tree"), ("flowers?|roses?|tulips?|garden", "flower"),
            ("mountains?|hills?", "mountain"), ("houses?|home|cottage|cabin", "house"), ("castles?|palace|kingdom", "castle"), ("cars?|trucks?|vehicles?", "car"),
            ("boats?|ships?|sailboats?|sailing", "boat"), ("cats?|kittens?|kitty", "cat"), ("dogs?|pupp(?:y|ies)|doggy", "dog"), ("fish(?:es)?|goldfish", "fish"),
            ("people|person|kids?|child(?:ren)?|boys?|girls?|man|woman|men|women|family|friends?|astronauts?", "person"), ("robots?", "robot"), ("dinosaurs?|dino|t-?rex", "dinosaur"),
            ("snowm[ae]n", "snowman"), ("hearts?|love", "heart"), ("apples?|fruit", "apple"), ("books?|reading|library", "book"), ("balls?|soccer|football|basketball", "ball"),
            ("cakes?|birthday", "cake"), ("umbrellas?|rainy|raining|rain", "umbrella")]
COUNT_WORDS = {"two": 2, "three": 3, "four": 4, "five": 5, "couple": 2, "few": 3, "many": 5, "several": 4, "lots": 5}
F = re.I | re.A


def scene_from_words(text: str) -> str:
    if re.search(r"\b(space|galaxy|outer space|astronaut|planets?|rocket)\b", text, F):
        return "space"
    if re.search(r"\b(underwater|under the sea|ocean floor|coral|aquarium)\b", text, F) or (re.search(r"\bfish\b", text, F) and not re.search(r"\b(boat|ship)\b", text, F)):
        return "underwater"
    for rx, scene in ((r"\b(snow\w*|winter|snowman|ice|frozen)\b", "snow"), (r"\b(sunset|sunrise|dusk|dawn|evening)\b", "sunset"), (r"\b(night|moon|starry|stars|dark)\b", "night"),
                      (r"\b(room|bedroom|kitchen|classroom|inside|indoors?|table|desk)\b", "indoor")):
        if re.search(rx, text, F):
            return scene
    return "day"


def kinds_from_words(text: str) -> list[dict]:
    out: list[dict] = []
    for words, kind in SYNONYMS:
        m = re.search(rf"(?:\b(\d+|{'|'.join(COUNT_WORDS)})\s+(?:[a-z]+\s+)?)?\b(?:{words})\b", text, F)
        if not m or any(o["kind"] == kind for o in out):
            continue
        whole = m.group(0)
        if m.group(1):
            n = COUNT_WORDS.get(m.group(1).lower(), None) or int(m.group(1))
        elif re.search(r"\bforest\b", whole, F):
            n = 4
        elif re.search(r"(?:s|ren|men|ies)$", whole, F) and not re.search(r"(?:fish|ss|grass)$", whole, F):
            n = 2
        else:
            n = 1
        out.append({"kind": kind, "count": max(1, min(5, n or 1))})
    return out


def layout_kinds(items: list[dict], scene: str) -> list[dict]:
    flat = [i["kind"] for i in items for _ in range(i["count"])]
    open_ = scene in ("space", "underwater")
    sky = [k for k in flat if k in SKY or open_]
    ground = [k for k in flat if k not in sky]
    objs = []
    for i, kind in enumerate(sky):
        objs.append({"kind": kind, "x": 12 + ((i * 37 + 20) % 78), "y": 25 + ((i * 29) % 50) if open_ else 14 + ((i * 17) % 26), "size": SIZE[kind]})
    for i, kind in enumerate(ground):
        size = SIZE[kind]
        objs.append({"kind": kind, "x": 50 if len(ground) == 1 else 12 + (76 * i) / (len(ground) - 1), "y": GROUND_Y * 100 + 6 - size / 2, "size": size})
    return objs


def arrange(objects: list[dict], scene: str) -> None:
    open_ = scene in ("space", "underwater")
    ground = GROUND_Y * 100
    for o in objects:
        o["size"] = max(o["size"], SIZE[o["kind"]] * 0.6)
        half = o["size"] / 2
        half_w = (o["size"] * H) / W / 2
        if not open_ and o["kind"] in SKY:
            o["y"] = min(o["y"], ground - half)
        if not open_ and o["kind"] not in SKY and o["y"] + half < ground - 6:
            o["y"] = ground + 6 - half
        o["x"] = max(half_w + 1, min(100 - half_w - 1, o["x"]))
        o["y"] = max(half + 1, min(99 - half, o["y"]))
    for o in objects:
        if o["kind"] == "boat" and scene == "underwater":
            o["y"] = o["size"] / 2 + 1
    by_kind: dict[str, list[dict]] = {}
    for o in objects:
        by_kind.setdefault(o["kind"], []).append(o)
    for group in by_kind.values():
        if len(group) < 2 or not all(abs(o["x"] - group[0]["x"]) < 4 for o in group):
            continue
        for i, o in enumerate(group):
            half_w = (o["size"] * H) / W / 2
            o["x"] = max(half_w + 1, min(100 - half_w - 1, 10 + (80 * i) / (len(group) - 1)))
    for i in range(1, len(objects)):
        for tries in range(8):
            o = objects[i]
            clash = any(abs(p["x"] - o["x"]) < max(5, min(p["size"], o["size"]) * 0.35) and abs(p["y"] - o["y"]) < max(5, min(p["size"], o["size"]) * 0.35) for p in objects[:i])
            if not clash:
                break
            half_w = (o["size"] * H) / W / 2
            o["x"] = half_w + 1 + math.fmod(o["x"] - half_w - 1 + 23, 100 - 2 * half_w - 2)
            if o["kind"] in SKY or open_:
                o["y"] = max(o["size"] / 2 + 1, min((99 if open_ else ground) - o["size"] / 2, o["y"] + (-9 if tries % 2 else 7)))


def title_from(prompt: str) -> str:
    t = re.sub(r"^.*?\b(draw|paint|sketch|make|create|generate|show)\b\s*(me\s+)?(an?\s+)?(picture|image|drawing|illustration|painting)?\s*(of\s+)?", "", prompt, count=1, flags=F | re.S)
    t = re.sub(r"[?.!]+$", "", t).strip()
    s = t or "My picture"
    return s[0].upper() + s[1:80]


def plan_from_words(prompt: str) -> dict:
    scene = scene_from_words(prompt)
    items = kinds_from_words(prompt) or [{"kind": "tree", "count": 2}, {"kind": "house", "count": 1}]
    has = lambda k: any(i["kind"] == k for i in items)
    if scene == "day" and not has("sun"):
        items.append({"kind": "sun", "count": 1})
    if scene == "day" and not has("cloud"):
        items.append({"kind": "cloud", "count": 2})
    if scene == "night" and not has("moon"):
        items.append({"kind": "moon", "count": 1})
    if scene == "night" and not has("star"):
        items.append({"kind": "star", "count": 5})
    objects = layout_kinds(items, scene)
    arrange(objects, scene)
    return {"title": title_from(prompt), "scene": scene, "objects": objects, "caption": ""}


KIND_ALIASES = {"dragon": "dinosaur", "lizard": "dinosaur", "monster": "dinosaur", "kitten": "cat", "kitty": "cat", "lion": "cat", "tiger": "cat", "puppy": "dog", "wolf": "dog", "fox": "dog",
                "ship": "boat", "sailboat": "boat", "yacht": "boat", "truck": "car", "bus": "car", "spaceship": "rocket", "plane": "rocket", "airplane": "rocket", "ufo": "rocket",
                "palace": "castle", "tower": "castle", "home": "house", "cottage": "house", "hill": "mountain", "volcano": "mountain", "rose": "flower", "tulip": "flower",
                "child": "person", "boy": "person", "girl": "person", "man": "person", "woman": "person", "astronaut": "person", "android": "robot", "earth": "planet", "saturn": "planet",
                "whale": "fish", "shark": "fish", "dolphin": "fish"}


def known_kind(kind) -> str | None:
    k = re.sub(r"s$", "", ("" if kind is None else (js_str(kind) if isinstance(kind, (bool, int, float)) else str(kind))).lower().strip())
    return k if k in KINDS else KIND_ALIASES.get(k)


def _clamp(v, lo, hi, d):
    return max(lo, min(hi, v)) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else d


def validate_plan(raw, prompt: str) -> dict | None:
    if not isinstance(raw, dict):
        return None
    worded = scene_from_words(prompt)
    scene = worded if worded != "day" else raw.get("scene") if raw.get("scene") in SCENES else "day"
    objects = []
    for o in [o for o in (raw.get("objects") if isinstance(raw.get("objects"), list) else []) if isinstance(o, dict) and known_kind(o.get("kind"))][:16]:
        kind = known_kind(o.get("kind"))
        objects.append({"kind": kind, "x": _clamp(o.get("x"), 3, 97, 50), "y": _clamp(o.get("y"), 3, 97, 50), "size": _clamp(o.get("size"), 4, 70, SIZE[kind]), "color": safe_color(o.get("color"), DEFAULT_COLOR[kind])})
    if not objects:
        return None
    missing = [k for k in kinds_from_words(prompt) if not any(o["kind"] == k["kind"] for o in objects)]
    objects += layout_kinds(missing, scene)
    arrange(objects, scene)
    title = raw["title"].strip()[:80] if isinstance(raw.get("title"), str) and raw["title"].strip() else title_from(prompt)
    return {"title": title, "scene": scene, "objects": objects, "caption": raw["caption"][:200] if isinstance(raw.get("caption"), str) else ""}


def shape(kind: str, c: str) -> str:
    dark = "#2b2d42"
    if kind == "sun":
        rays = "".join(f'<line x1="{js_str(50 + 34 * math.cos(a))}" y1="{js_str(50 + 34 * math.sin(a))}" x2="{js_str(50 + 47 * math.cos(a))}" y2="{js_str(50 + 47 * math.sin(a))}"/>'
                       for a in ((i * math.pi) / 6 for i in range(12)))
        return f'<g stroke="{c}" stroke-width="5" stroke-linecap="round">{rays}</g><circle cx="50" cy="50" r="28" fill="{c}"/>'
    if kind == "rainbow":
        return "".join(f'<path d="M{4 + i * 6} 90 A{46 - i * 6} {46 - i * 6} 0 0 1 {96 - i * 6} 90" fill="none" stroke="{col}" stroke-width="6"/>'
                       for i, col in enumerate(["#e63946", "#f77f00", "#fcbf49", "#2a9d8f", "#457b9d", "#7209b7"]))
    if kind == "flower":
        petals = "".join(f'<circle cx="{js_str(50 + 16 * math.cos((a * math.pi) / 180))}" cy="{js_str(32 + 16 * math.sin((a * math.pi) / 180))}" r="13" fill="{c}"/>' for a in (0, 72, 144, 216, 288))
        return f'<path d="M50 50 L50 100" stroke="#2d6a4f" stroke-width="5"/><ellipse cx="62" cy="78" rx="10" ry="5" fill="#40916c"/>{petals}<circle cx="50" cy="32" r="10" fill="#ffd60a"/>'
    return _SHAPES[kind].replace("${c}", c).replace("${dark}", dark)


SCENE_BG = {"day": (("#8ecae6", "#e0f4ff"), "#74c69d"), "night": (("#0b1a3a", "#27407a"), "#2d6a4f"), "sunset": (("#ff7b54", "#ffd56f"), "#6a994e"), "space": (("#03031a", "#1b1b4b"), None),
            "underwater": (("#0077b6", "#48cae4"), "#e9c46a"), "indoor": (("#f8edeb", "#fae1dd"), "#c9a27e"), "snow": (("#a9d6e5", "#e8f4f8"), "#ffffff")}


def esc(s: str) -> str:
    return re.sub(r"[&<>\"']", lambda m: {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[m.group(0)], s)


def render_svg(spec: dict) -> str:
    sky, ground_color = SCENE_BG[spec["scene"]]
    gy = H * GROUND_Y
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="{esc(spec["title"])}">',
             f"<title>{esc(spec['title'])}</title>",
             f'<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{sky[0]}"/><stop offset="1" stop-color="{sky[1]}"/></linearGradient></defs>',
             f'<rect width="{W}" height="{H}" fill="url(#sky)"/>']
    if spec["scene"] in ("space", "night"):
        for i in range(40):
            parts.append(f'<circle cx="{(i * 197) % W}" cy="{js_str(math.fmod(i * 113, gy if spec["scene"] == "night" else H))}" r="{js_str(1 + (i % 3) * 0.6)}" fill="#fff" opacity="{js_str(0.4 + (i % 5) / 10)}"/>')
    if spec["scene"] == "underwater":
        for i in range(14):
            parts.append(f'<circle cx="{(i * 151) % W}" cy="{js_str(math.fmod(i * 89, gy))}" r="{3 + (i % 4) * 2}" fill="none" stroke="#fff" stroke-opacity="0.5" stroke-width="2"/>')
    if ground_color:
        if spec["scene"] == "indoor":
            parts.append(f'<rect x="0" y="{js_str(gy)}" width="{W}" height="{js_str(H - gy)}" fill="{ground_color}"/><rect x="560" y="60" width="160" height="130" fill="#bde0fe" stroke="#fff" stroke-width="8"/><line x1="640" y1="60" x2="640" y2="190" stroke="#fff" stroke-width="6"/>')
        else:
            parts.append(f'<path d="M0 {js_str(gy)} Q{js_str(W * 0.25)} {js_str(gy - 30)} {js_str(W * 0.5)} {js_str(gy)} T{W} {js_str(gy - 10)} V{H} H0Z" fill="{ground_color}"/>')
    for o in sorted(spec["objects"], key=lambda o: o["y"] + o["size"] / 2):
        s = (o["size"] / 100) * H
        x, y = (o["x"] / 100) * W - s / 2, (o["y"] / 100) * H - s / 2
        parts.append(f'<g transform="translate({to_fixed(x, 1)} {to_fixed(y, 1)}) scale({to_fixed(s / 100, 3)})">{shape(o["kind"], safe_color(o.get("color"), DEFAULT_COLOR[o["kind"]]))}</g>')
    parts.append("</svg>")
    return "".join(parts)


def svg_data_uri(svg: str) -> str:
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode()
