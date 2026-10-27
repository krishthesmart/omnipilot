"""Handoff Capsules (docs/product, slice 8).

A capsule is a previewable export of a project for someone else (or for later), in JSON and Markdown, built
from presets: quick summary, teammate handoff, teacher / presentation brief, technical continuation. The person
sees every item first and can remove any of them. Credentials and secrets are never included; any configured
secret value in the text is scrubbed. The capsule says which parts were written by AI agents.
"""
from __future__ import annotations

import json
import uuid

from . import project_dna, projects, store
from .projects import OWNER, ProjectError

PRESETS = {
    "quick_summary": {"label": "Quick summary", "sections": ["brief", "status", "decisions", "open"]},
    "teammate": {"label": "Teammate handoff", "sections": ["brief", "status", "decisions", "facts", "tasks", "open", "assumptions", "files", "evidence"]},
    "teacher": {"label": "Teacher / presentation brief", "sections": ["brief", "decisions", "facts", "evidence", "learning_scope"]},
    "technical": {"label": "Technical continuation", "sections": ["brief", "status", "decisions", "facts", "tasks", "evidence", "files", "open", "assumptions", "alerts", "runs"]},
}
SECTION_TITLES = {"brief": "Project brief", "status": "Where things stand", "decisions": "Decisions", "facts": "Confirmed facts", "tasks": "Tasks and acceptance checks",
                  "open": "Open questions and known problems", "assumptions": "Unverified assumptions", "files": "Files", "evidence": "Evidence",
                  "alerts": "Changes to review", "runs": "Recent runs", "learning_scope": "What this covers"}


def _items(project_id: str, section: str, actor: str) -> list[dict]:
    """Each item: id (stable within the capsule), text, and whether an AI agent wrote it."""
    p = projects.get(project_id, actor)
    if section == "brief":
        out = [{"text": f"Goal: {p['description']}", "ai": False}] if p["description"] else []
        out += [{"text": f"Requirement: {r}", "ai": False} for r in p["requirements"]]
        out += [{"text": f"Constraint: {c}", "ai": False} for c in p["constraints"]]
        out += [{"text": f"Deadline: {p['deadline']}", "ai": False}] if p["deadline"] else []
        return out
    if section == "status":
        t = store.q("SELECT status, COUNT(*) AS n FROM project_tasks WHERE project_id = ? GROUP BY status", project_id)
        c = store.q("SELECT state, COUNT(*) AS n FROM acceptance_checks WHERE project_id = ? GROUP BY state", project_id)
        out = [{"text": "Tasks: " + ", ".join(f"{r['n']} {r['status'].replace('_', ' ')}" for r in t), "ai": False}] if t else [{"text": "No tasks yet.", "ai": False}]
        out += [{"text": "Acceptance checks: " + ", ".join(f"{r['n']} {r['state'].replace('_', ' ')}" for r in c), "ai": False}] if c else []
        return out
    facts = project_dna.facts(project_id, actor)
    if section == "decisions":
        return [{"text": f"{f['content']} (why: {f['rationale']})", "ai": f["actor_type"] != "human"} for f in facts if f["kind"] == "decision" and f["basis"] == "confirmed"]
    if section == "facts":
        return [{"text": f"{f['kind'].replace('_', ' ')}: {f['content']}", "ai": f["actor_type"] != "human"} for f in facts
                if f["basis"] == "confirmed" and f["kind"] not in ("decision", "open_question", "known_problem")]
    if section == "open":
        return [{"text": f"{'Open question' if f['kind'] == 'open_question' else 'Known problem'}: {f['content']}", "ai": f["actor_type"] != "human"} for f in facts if f["kind"] in ("open_question", "known_problem")]
    if section == "assumptions":
        return [{"text": f"{a['statement']} (unverified)", "ai": a["actor_type"] != "human"} for a in project_dna.assumptions(project_id, actor, "unverified")]
    if section == "tasks":
        out = []
        for t in store.q("SELECT * FROM project_tasks WHERE project_id = ? AND status != 'cancelled' ORDER BY created_at", project_id):
            checks = store.q("SELECT text, state FROM acceptance_checks WHERE task_id = ?", t["id"])
            out.append({"text": f"{t['title']} [{t['status'].replace('_', ' ')}]" + (" — checks: " + "; ".join(f"{c['text']} ({c['state']})" for c in checks) if checks else ""), "ai": False})
        return out
    if section == "files":
        return [{"text": f"{f['name']} ({f['size']} bytes, sha256 {f['sha256'][:12]}…)", "ai": False} for f in store.q("SELECT * FROM project_files WHERE project_id = ? ORDER BY name", project_id)]
    if section == "evidence":
        return [{"text": f"{e['claim']} — {e['kind']}, {e['result']}" + (f"; limits: {e['limitations']}" if e["limitations"] else ""), "ai": e["actor_type"] == "agent"}
                for e in store.q("SELECT * FROM evidence_receipts WHERE project_id = ? ORDER BY created_at DESC LIMIT 40", project_id)]
    if section == "alerts":
        return [{"text": f"{a['affected_summary']} — {a['explanation']}", "ai": False} for a in store.q("SELECT * FROM change_alerts WHERE project_id = ? AND status = 'open'", project_id)]
    if section == "runs":
        return [{"text": f"{r['created_at'][:16]} {r['request'][:200]} [{r['status']}]", "ai": False} for r in projects.runs(project_id, actor, limit=10)]
    if section == "learning_scope":
        return [{"text": f"Project type: {p['type']}. Built from the project's confirmed records; suggestions and unverified assumptions are excluded.", "ai": False}]
    return []


def preview(project_id: str, preset: str, actor: str = OWNER) -> dict:
    projects.require(project_id, "read", actor)
    if preset not in PRESETS:
        raise ProjectError(400, "invalid_request", f"preset must be one of: {', '.join(PRESETS)}")
    sections = []
    for s in PRESETS[preset]["sections"]:
        items = [{**it, "id": f"{s}:{i}"} for i, it in enumerate(_items(project_id, s, actor))]
        sections.append({"key": s, "title": SECTION_TITLES[s], "items": items})
    return {"preset": preset, "label": PRESETS[preset]["label"], "sections": sections,
            "excluded": ["credentials, tokens and keys", "connection permissions and approval grants", "file contents", "personal preferences", "learning notes"]}


def build(project_id: str, preset: str, remove: list[str] | None = None, actor: str = OWNER, save: bool = True) -> dict:
    """The capsule without the removed items, as JSON and Markdown (secrets scrubbed)."""
    from .tools.base import scrub

    p = projects.get(project_id, actor)
    pv = preview(project_id, preset, actor)
    removed = set(remove or [])
    sections = [{**s, "items": [it for it in s["items"] if it["id"] not in removed]} for s in pv["sections"]]
    any_ai = any(it["ai"] for s in sections for it in s["items"])
    disclosure = ("Some items (marked “AI”) were written by OmniPilot's AI agents and confirmed or recorded by a person; check them before relying on them."
                  if any_ai else "All items were entered or confirmed by a person; OmniPilot assembled them.")
    data = {"format": "omnipilot.handoff/1", "preset": preset, "project": p["name"], "made_at": store.now(), "ai_disclosure": disclosure, "excluded": pv["excluded"],
            "sections": [{"title": s["title"], "items": [{"text": it["text"], "ai": it["ai"]} for it in s["items"]]} for s in sections if s["items"]]}
    md = [f"# {p['name']}: {pv['label']}", "", f"_{disclosure}_", ""]
    for s in data["sections"]:
        md += [f"## {s['title']}", "", *[f"- {it['text']}" + (" _(AI)_" if it["ai"] else "") for it in s["items"]], ""]
    md += ["---", f"Made with OmniPilot on {data['made_at'][:10]}. Not included: {', '.join(pv['excluded'])}."]
    content_json = scrub(json.dumps(data, ensure_ascii=False, indent=2))
    content_md = scrub("\n".join(md))
    out = {"id": None, "json": json.loads(content_json), "markdown": content_md}
    if save:
        hid = str(uuid.uuid4())
        store.x("INSERT INTO handoffs (id, project_id, preset, removed, content_json, content_md, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                hid, project_id, preset, json.dumps(sorted(removed)), content_json, content_md, data["made_at"])
        projects.record(project_id, "handoff_created", f"Handoff Capsule made: {pv['label']}" + (f" ({len(removed)} item(s) removed)" if removed else ""), {"handoffId": hid}, actor=actor)
        out["id"] = hid
    return out


def handoffs(project_id: str, actor: str = OWNER) -> list[dict]:
    projects.require(project_id, "read", actor)
    return store.q("SELECT id, preset, removed, created_at FROM handoffs WHERE project_id = ? ORDER BY created_at DESC", project_id)


def get_handoff(project_id: str, hid: str, actor: str = OWNER) -> dict:
    projects.require(project_id, "read", actor)
    r = store.q1("SELECT * FROM handoffs WHERE id = ? AND project_id = ?", hid, project_id)
    if not r:
        raise ProjectError(404, "not_found", "No such capsule in this project.")
    return r
