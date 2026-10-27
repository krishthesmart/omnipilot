"""Shapes shared by every agent."""
from __future__ import annotations

import uuid

from ..text import clip  # noqa: F401  (agents import it from here too)


def proposed_action(description: str, risk_level: str, requires_approval: bool | None = None, preview: str | None = None, id: str | None = None) -> dict:
    a = {"id": id or str(uuid.uuid4()), "description": description, "riskLevel": risk_level, "requiresApproval": risk_level != "low" if requires_approval is None else requires_approval}
    if preview:
        a["preview"] = preview
    return a


def evidence(source: str, detail: str) -> dict:
    return {"source": source, "detail": detail}


def result(status: str, findings: list[str], *, evidence: list[dict] | None = None, confidence: float = 0.0, limitations: list[str] | None = None,
           actions: list[dict] | None = None, attachments: list[dict] | None = None) -> dict:
    out = {"status": status, "findings": findings, "evidence": evidence or [], "confidence": confidence, "limitations": limitations or [], "proposedActions": actions or []}
    if attachments:
        out["attachments"] = attachments
    return out


def prior_results(input: dict) -> list[dict]:
    p = (input.get("context") or {}).get("priorResults")
    return p if isinstance(p, list) else []


def previous_turn_text(input: dict) -> str:
    """Context added to an agent's prompt: the project it works in (if any) and the previous turn."""
    out = project_text(input)
    prev = (input.get("context") or {}).get("previousTurn") or {}
    if prev.get("request"):
        out += f"\n\nEarlier in this conversation (use it if the request refers to it):\nUser asked: {prev['request']}\nYou answered:\n{prev.get('answer', '')}"
    return out


def project_text(input: dict) -> str:
    """The project's confirmed facts and the person's preferences, kept apart and labelled for what they are.
    Suggestions and unverified assumptions are never included as facts."""
    p = (input.get("context") or {}).get("project")
    if not isinstance(p, dict):
        return ""
    lines = [f"\n\nYou are working in the project \"{p.get('name', '')}\"."]
    for label, key in (("Requirements", "requirements"), ("Constraints (respect these)", "constraints"), ("Acceptance criteria", "acceptance")):
        if p.get(key):
            lines.append(f"{label}: " + "; ".join(p[key][:20]))
    facts = p.get("facts") or []
    if facts:
        lines.append("Confirmed project facts (confirmed by the user):")
        lines += [f"- [{f['kind'].replace('_', ' ')}] {f['content']}" + (f" (why: {f['rationale']})" if f.get("rationale") else "") for f in facts[:40]]
    prefs = p.get("preferences") or []
    if prefs:
        lines.append("The person's own preferences (about how to help them, not project facts): " + "; ".join(f"{x['key']}: {x['value']}" for x in prefs[:15]))
    return "\n".join(lines)


def model_limitation() -> str:
    from ... import llm

    return f"Part of this answer was written by an AI model ({llm.answered_by()}) and hasn't been verified against a source; double-check important facts."


def model_evidence() -> dict:
    from ... import llm

    a = llm.last_answer.get() or {"model": llm.local_model()}
    return evidence(f"ai-model:{a['model']}", "")


def prior_results_text(prior: list[dict], max_chars: int = 2500) -> str:
    """Upstream agents' findings for a prompt, capped so a small model's context isn't flooded."""
    return "\n\n".join(f"[{p['agent']}{' -- ' + p['task'] if p.get('task') else ''}]\n" + "\n".join(p["findings"]) for p in prior)[:max_chars]
