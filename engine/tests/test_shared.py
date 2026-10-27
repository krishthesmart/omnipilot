"""The shared definitions load, and Python's keyword decisions match TypeScript's exactly."""
import json

from omnipilot_engine.config import ROOT
from omnipilot_engine.shared import js_regex, keyword_scores, load


def test_loads_every_agent_and_prompt():
    shared = load()
    assert len(shared.agents) == 13
    assert shared.agents["CodePilot"].builds_on[0].agent == "Helper"
    assert shared.agents["PicturePilot"].describes_one_thing
    assert "routing classifier" in shared.raw["router"]["system"]


def test_keyword_scores_match_the_typescript_engine():
    cases = json.loads((ROOT / "contracts" / "keywords.json").read_text())["phrases"]
    mismatches = [(c["text"], c["scores"], keyword_scores(c["text"])) for c in cases if keyword_scores(c["text"]) != c["scores"]]
    assert mismatches == []


def test_javascript_regex_semantics():
    # Each expectation was checked against Node's own results.
    assert js_regex({"source": "^abc$", "flags": ""}).search("abc\n") is None  # JS $ is the very end
    assert js_regex({"source": r"\bcafé\b", "flags": "i"}).search("CAFÉ") is None  # é isn't a word character without the u flag
    assert js_regex({"source": r"^\w+$", "flags": ""}).search("naïve") is None  # ASCII \w without the u flag
    assert js_regex({"source": r"\bplug (in|into)\b", "flags": "i"}).search("Plug into the TV") is not None
    # Known difference: JavaScript's i flag folds non-ASCII case (/é/i matches "É"); Python's ASCII mode
    # doesn't. The only non-ASCII letter in any keyword pattern is MathPilot's "π" ("formulas for π"), so
    # the engines can differ only on a capital "Π" there. A new non-ASCII letter must be reviewed here.
    from omnipilot_engine.shared import load
    non_ascii = {ch for spec in load().agents.values() for k in spec.keywords for ch in k.pattern if not ch.isascii()}
    assert non_ascii == {"π"}
