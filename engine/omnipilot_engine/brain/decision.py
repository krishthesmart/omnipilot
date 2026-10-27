"""The Router's decision-model interface (docs/product, slice 3).

The Router decides which specialists handle a request through a `DecisionModel`. OmniPilot does not have a
trained, embedded decision model. The one in use is the BASELINE: keyword rules, with a language-model
suggestion only when no rule matches (routing.py). It is labelled as such everywhere it's shown, and it can be
swapped for a trained model by calling `use()` with any object that has the same `decide()` method.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class RoutingDecision:
    agents: list[str]
    rationale: dict
    scores: dict
    mode: str  # "rules" | "model-assisted" | "trained-model"
    model_used: str | None = None
    extra: dict = field(default_factory=dict)


class DecisionModel(Protocol):
    name: str
    kind: str  # "baseline" or "trained"
    label: str

    async def decide(self, text: str) -> RoutingDecision: ...


class BaselineRouter:
    """Keyword rules + an optional language-model suggestion. NOT a trained decision model."""

    name = "baseline-rules"
    kind = "baseline"
    label = "Baseline router: keyword rules, with a language-model suggestion when no rule matches (not a trained decision model)"

    async def decide(self, text: str) -> RoutingDecision:
        from . import routing

        plan = await routing.route_request(text)
        return RoutingDecision(plan["selectedAgents"], plan["rationale"], plan["scores"],
                               "model-assisted" if plan["routingMode"] == "model" else "rules", plan.get("modelUsed"),
                               {"raw": plan})


_model: DecisionModel = BaselineRouter()


def current() -> DecisionModel:
    return _model


def use(model: DecisionModel) -> None:
    """Plugs in another decision model (e.g. a trained one); it must report its own kind and label honestly."""
    global _model
    if getattr(model, "kind", None) not in ("baseline", "trained") or not getattr(model, "label", ""):
        raise ValueError("a decision model must declare its kind ('baseline' or 'trained') and a label")
    _model = model


def describe() -> dict:
    return {"name": _model.name, "kind": _model.kind, "label": _model.label}


def fold(raw: dict) -> dict:
    """The plan in terms of the six specialists. The abilities the rules picked are kept as `capabilities` (the
    coordinator plans with them); a skill's choice and score are reported under the specialist that owns it."""
    from .specs import owner, skill_of

    picked = list(raw["selectedAgents"])
    selected = list(dict.fromkeys(owner(a) for a in picked))
    skills = {s: [skill_of(a) for a in picked if owner(a) == s and skill_of(a)] for s in selected}
    scores: dict = {}
    for a, v in (raw.get("scores") or {}).items():
        scores[owner(a)] = max(scores.get(owner(a), 0), v)
    rationale: dict = {}
    for a, why in (raw.get("rationale") or {}).items():
        o, label = owner(a), (f"{skill_of(a)}: {why}" if skill_of(a) else why)
        if a in picked:  # chosen abilities are what the specialist's rationale says; joined when it has several
            rationale[o] = f"{rationale[o]} · {label}" if o in rationale and o in {owner(x) for x in picked[:picked.index(a)]} else label
        else:
            rationale.setdefault(o, label)
    return {**raw, "selectedAgents": selected, "capabilities": picked, "skills": {k: v for k, v in skills.items() if v}, "scores": scores, "rationale": rationale}


async def plan(text: str) -> dict:
    """The routing plan in the shape the pipeline uses, plus which decision model produced it."""
    d = await _model.decide(text)
    if isinstance(d.extra.get("raw"), dict):  # the baseline's own plan, folded into the six specialists
        return {**fold(d.extra["raw"]), "router": describe()}
    return {**fold({"selectedAgents": d.agents, "rationale": d.rationale, "scores": d.scores, "routingMode": "model" if d.mode != "rules" else "heuristic",
                    **({"modelUsed": d.model_used} if d.model_used else {}), **d.extra}), "router": describe()}
