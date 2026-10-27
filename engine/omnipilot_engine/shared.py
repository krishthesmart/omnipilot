"""Definitions shared with the TypeScript engine: shared/omnipilot.json, generated
by server/scripts/export-shared.mts (specialist registry, router prompt and
examples, follow-up rewriting, coordinator patterns). JavaScript regular
expressions are compiled with JavaScript's semantics, so both engines make the
same keyword decisions (checked against contracts/keywords.json)."""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import regex

from .config import ROOT

SHARED_FILE = ROOT / "shared" / "omnipilot.json"


def _js_dollar(source: str) -> str:
    """JavaScript's `$` (without the m flag) matches only at the very end; Python's also before a final newline."""
    out, i, in_class = [], 0, False
    while i < len(source):
        ch = source[i]
        if ch == "\\":
            out.append(source[i : i + 2])
            i += 2
            continue
        if ch == "[":
            in_class = True
        elif ch == "]":
            in_class = False
        out.append(r"\Z" if ch == "$" and not in_class else ch)
        i += 1
    return "".join(out)


def js_regex(spec: dict) -> regex.Pattern:
    """Compiles {source, flags} from a JavaScript RegExp with JavaScript's semantics."""
    flags = spec.get("flags", "")
    py = 0
    if "i" in flags:
        py |= regex.IGNORECASE
    if "s" in flags:
        py |= regex.DOTALL
    if "m" in flags:
        py |= regex.MULTILINE
    if "u" not in flags:
        py |= regex.ASCII  # without the u flag, JavaScript's \w, \d, \b are ASCII-only
    source = spec["source"] if "m" in flags else _js_dollar(spec["source"])
    return regex.compile(source, py)


@dataclass(frozen=True)
class BuildsOn:
    agent: str
    when: regex.Pattern | None
    reason: str


@dataclass(frozen=True)
class AgentSpec:
    name: str
    description: str
    keywords: tuple[regex.Pattern, ...]
    narrow: bool
    describes_one_thing: bool
    builds_on: tuple[BuildsOn, ...]
    timeout_ms: int
    max_retries: int


@dataclass(frozen=True)
class Shared:
    raw: dict
    agents: dict[str, AgentSpec]
    patterns: dict[str, regex.Pattern]

    @property
    def agent_names(self) -> list[str]:
        return list(self.agents)


@lru_cache(maxsize=1)
def load(path: Path = SHARED_FILE) -> Shared:
    raw = json.loads(path.read_text())
    agents = {
        a["name"]: AgentSpec(
            name=a["name"],
            description=a["description"],
            keywords=tuple(js_regex(k) for k in a["keywords"]),
            narrow=a["narrow"],
            describes_one_thing=a["describesOneThing"],
            builds_on=tuple(BuildsOn(b["agent"], js_regex(b["when"]) if b["when"] else None, b["reason"]) for b in a["buildsOn"]),
            timeout_ms=a["budget"]["timeoutMs"],
            max_retries=a["budget"]["maxRetries"],
        )
        for a in raw["agents"]
    }
    return Shared(raw=raw, agents=agents, patterns={k: js_regex(v) for k, v in raw["patterns"].items()})


def keyword_scores(text: str) -> dict[str, int]:
    """How many keyword patterns per agent match `text` (router/decisionModel.ts keywordScores)."""
    return {name: sum(1 for k in spec.keywords if k.search(text)) for name, spec in load().agents.items()}
