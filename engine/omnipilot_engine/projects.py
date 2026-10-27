"""Projects: the unit OmniPilot's work is organised around (docs/product/REQUIREMENTS.md).

Each project has its own conversations, files and activity, kept apart from every other project:
  - every read or change goes through `require()`, which checks the project exists, the actor may act on it
    (membership and role), and that changes aren't made to an archived project;
  - a project's records are always looked up by (project id, record id), so an id from another project is
    simply "not found";
  - a project's files live in their own folder, workspace/.omnipilot-projects/<project id>/ (hidden, so the
    workspace-wide file search never sees them); agents working in a project see only that folder.

Access today: OmniPilot has one owner (whoever is on this computer, or signed in with the owner password), so
every project has one member, "owner". The roles (approver, reviewer, task_owner, viewer) are stored and
checked here so multi-user access can be added on top, but there are no other accounts yet (see DECISIONS.md).
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import shutil
import uuid
from pathlib import Path

from contextvars import ContextVar

from . import patches, store

# The project the current run belongs to (set by the pipeline, never by the client); agents read it via ctx.
current: ContextVar[dict | None] = ContextVar("omnipilot_project", default=None)

OWNER = "owner"
TYPES = ("general", "coding", "research", "science", "learning", "writing")
LIST_FIELDS = ("requirements", "constraints", "milestones", "acceptance")
ROLES = {  # what each role may do
    "owner": {"read", "write", "delete", "approve", "manage"},
    "approver": {"read", "approve"},
    "reviewer": {"read"},
    "task_owner": {"read", "write"},
    "viewer": {"read"},
}
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_FILES = 500
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._()+,-]{0,119}$")
BLOCKED_EXT = {".exe", ".dll", ".so", ".dylib", ".app", ".bat", ".cmd", ".com", ".msi", ".scr", ".pkg", ".dmg"}


class ProjectError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _now() -> str:
    return store.now()


def _clean_text(value, field: str, limit: int, required: bool = False) -> str:
    text = value if isinstance(value, str) else ("" if value is None else None)
    if text is None:
        raise ProjectError(400, "invalid_request", f"{field} must be text")
    text = text.strip()
    if required and not text:
        raise ProjectError(400, "invalid_request", f"{field} is required")
    if len(text) > limit:
        raise ProjectError(400, "invalid_request", f"{field} is too long (at most {limit} characters)")
    return text


def _clean_list(value, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 100 or not all(isinstance(v, str) for v in value):
        raise ProjectError(400, "invalid_request", f"{field} must be a list of up to 100 short texts")
    out = [v.strip() for v in value if v.strip()]
    if any(len(v) > 1000 for v in out):
        raise ProjectError(400, "invalid_request", f"each item in {field} must be at most 1000 characters")
    return out


def _clean_deadline(value) -> str | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ProjectError(400, "invalid_request", "deadline must be a date like 2026-12-31")
    return value


def _row(r: dict) -> dict:
    out = {**r}
    for f in LIST_FIELDS:
        out[f] = json.loads(out.get(f) or "[]")
    return out


def files_dir(project_id: str) -> Path:
    """The project's own file folder (inside the workspace, hidden from workspace-wide search)."""
    if not re.fullmatch(r"[0-9a-f-]{36}", project_id):
        raise ProjectError(404, "not_found", "No such project.")
    return Path(patches.workspace_root()) / ".omnipilot-projects" / project_id


def run_scope(project_id: str, actor: str = OWNER) -> dict:
    """What a run inside the project may see: the project's own facts and its own file folder."""
    p = require(project_id, "write", actor)
    files_dir(project_id).mkdir(parents=True, exist_ok=True, mode=0o700)
    from . import project_dna

    return {"id": p["id"], "name": p["name"], "root": str(files_dir(project_id)),
            "requirements": p["requirements"], "constraints": p["constraints"], "acceptance": p["acceptance"],
            "facts": project_dna.confirmed_for_agents(project_id), "runBudgetUsd": run_budget(project_id),
            "preferences": [{"key": x["key"], "value": x["value"]} for x in project_dna.preferences()]}


def run_budget(project_id: str) -> float | None:
    row = store.q1("SELECT run_budget_usd FROM project_settings WHERE project_id = ?", project_id)
    return row["run_budget_usd"] if row else None


def set_run_budget(project_id: str, usd, actor: str = OWNER) -> dict:
    """The most paid services may cost in one run of this project (None = the app-wide per-request limit only)."""
    require(project_id, "manage", actor)
    if usd is not None and (isinstance(usd, bool) or not isinstance(usd, (int, float)) or not 0 <= usd <= 100):
        raise ProjectError(400, "invalid_request", "The budget must be between $0 and $100, or empty.")
    store.x("INSERT INTO project_settings (project_id, run_budget_usd, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET run_budget_usd = excluded.run_budget_usd, updated_at = excluded.updated_at",
            project_id, usd, _now())
    record(project_id, "budget_set", "Per-run budget removed" if usd is None else f"Per-run budget set to ${usd:.2f}", {"usd": usd}, actor=actor)
    return {"runBudgetUsd": usd}


# --- activity ---


def record(project_id: str, kind: str, summary: str, details: dict | None = None, actor: str = OWNER, actor_type: str = "human") -> None:
    """An entry in the project's activity history (the Home page, Return Briefings and audits read it)."""
    store.x("INSERT INTO project_events (project_id, kind, actor, actor_type, summary, details, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            project_id, kind, actor, actor_type, summary[:300], json.dumps(details or {}, ensure_ascii=False)[:4000], _now())


def events(project_id: str, limit: int = 50) -> list[dict]:
    rows = store.q("SELECT * FROM project_events WHERE project_id = ? ORDER BY id DESC LIMIT ?", project_id, limit)
    return [{**r, "details": json.loads(r["details"])} for r in rows]


# --- access ---


def role_of(project_id: str, actor: str) -> str | None:
    row = store.q1("SELECT role FROM project_members WHERE project_id = ? AND member = ?", project_id, actor)
    return row["role"] if row else None


def require(project_id: str, need: str = "read", actor: str = OWNER, allow_archived: bool = False) -> dict:
    """The project, if the actor may do `need` on it; otherwise a ProjectError (404 hides projects the actor can't see)."""
    if not isinstance(project_id, str) or not re.fullmatch(r"[0-9a-f-]{36}", project_id):
        raise ProjectError(404, "not_found", "No such project.")
    row = store.q1("SELECT * FROM projects WHERE id = ?", project_id)
    role = role_of(project_id, actor) if row else None
    if not row or not role:
        raise ProjectError(404, "not_found", "No such project.")
    if need not in ROLES[role]:
        raise ProjectError(403, "forbidden", f"Your role on this project ({role}) doesn't allow that.")
    if need in ("write", "approve") and row["status"] == "archived" and not allow_archived:
        raise ProjectError(409, "archived", "This project is archived. Restore it to make changes.")
    return _row(row)


# --- projects ---


def create(data: dict, actor: str = OWNER) -> dict:
    name = _clean_text(data.get("name"), "name", 120, required=True)
    ptype = data.get("type") or "general"
    if ptype not in TYPES:
        raise ProjectError(400, "invalid_request", f"type must be one of: {', '.join(TYPES)}")
    pid, now = str(uuid.uuid4()), _now()
    lists = {f: json.dumps(_clean_list(data.get(f), f), ensure_ascii=False) for f in LIST_FIELDS}
    store.x("INSERT INTO projects (id, name, description, type, deadline, requirements, constraints, milestones, acceptance, status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
            pid, name, _clean_text(data.get("description"), "description", 4000), ptype, _clean_deadline(data.get("deadline")),
            lists["requirements"], lists["constraints"], lists["milestones"], lists["acceptance"], now, now)
    store.x("INSERT INTO project_members (project_id, member, role, added_at) VALUES (?, ?, 'owner', ?)", pid, actor, now)
    files_dir(pid).mkdir(parents=True, exist_ok=True, mode=0o700)
    record(pid, "project_created", f"Created the project “{name}”", actor=actor)
    return get(pid, actor)


def get(project_id: str, actor: str = OWNER) -> dict:
    p = require(project_id, "read", actor)
    counts = {
        "conversations": store.q1("SELECT COUNT(*) AS n FROM project_conversations WHERE project_id = ?", project_id)["n"],
        "files": store.q1("SELECT COUNT(*) AS n FROM project_files WHERE project_id = ?", project_id)["n"],
        "runs": store.q1("SELECT COUNT(*) AS n FROM runs WHERE project_id = ?", project_id)["n"],
        "unverified_assumptions": store.q1("SELECT COUNT(*) AS n FROM project_assumptions WHERE project_id = ? AND status = 'unverified'", project_id)["n"],
        "open_questions": store.q1("SELECT COUNT(*) AS n FROM project_facts WHERE project_id = ? AND kind = 'open_question' AND status = 'active'", project_id)["n"],
        "known_problems": store.q1("SELECT COUNT(*) AS n FROM project_facts WHERE project_id = ? AND kind = 'known_problem' AND status = 'active'", project_id)["n"],
    }
    return {**p, "counts": counts, "role": role_of(project_id, actor)}


def list_projects(actor: str = OWNER, status: str | None = "active") -> list[dict]:
    rows = store.q("SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id AND m.member = ? "
                   + ("WHERE p.status = ? " if status else "") + "ORDER BY p.updated_at DESC", *([actor, status] if status else [actor]))
    return [_row(r) for r in rows]


def update(project_id: str, data: dict, actor: str = OWNER) -> dict:
    p = require(project_id, "write", actor)
    fields, changed = {}, []
    if "name" in data:
        fields["name"] = _clean_text(data["name"], "name", 120, required=True)
    if "description" in data:
        fields["description"] = _clean_text(data["description"], "description", 4000)
    if "type" in data:
        if data["type"] not in TYPES:
            raise ProjectError(400, "invalid_request", f"type must be one of: {', '.join(TYPES)}")
        fields["type"] = data["type"]
    if "deadline" in data:
        fields["deadline"] = _clean_deadline(data["deadline"])
    for f in LIST_FIELDS:
        if f in data:
            fields[f] = json.dumps(_clean_list(data[f], f), ensure_ascii=False)
    for k, v in fields.items():
        old = json.dumps(p[k], ensure_ascii=False) if k in LIST_FIELDS else p[k]
        if old != v:
            changed.append(k)
    if not changed:
        return get(project_id, actor)
    sets = ", ".join(f"{k} = ?" for k in changed)
    store.x(f"UPDATE projects SET {sets}, updated_at = ? WHERE id = ?", *[fields[k] for k in changed], _now(), project_id)
    summary = f"Renamed the project to “{fields['name']}”" if changed == ["name"] else f"Updated {', '.join(changed)}"
    record(project_id, "project_updated", summary, {"fields": changed, **({"from": p["name"], "to": fields["name"]} if "name" in changed else {})}, actor=actor)
    from . import radar

    for k in ("requirements", "constraints"):
        if k in changed:
            before, after = set(p[k]), set(json.loads(fields[k]))
            for text in sorted(after ^ before):
                radar.on_requirement_change(project_id, "requirement", text, text)
    return get(project_id, actor)


def set_archived(project_id: str, archived: bool, actor: str = OWNER) -> dict:
    p = require(project_id, "manage", actor, allow_archived=True)
    if (p["status"] == "archived") == archived:
        return get(project_id, actor)
    store.x("UPDATE projects SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?", "archived" if archived else "active", _now() if archived else None, _now(), project_id)
    record(project_id, "project_archived" if archived else "project_restored", "Archived the project" if archived else "Restored the project", actor=actor)
    return get(project_id, actor)


def delete_preview(project_id: str, actor: str = OWNER) -> dict:
    """Exactly what deleting removes (shown before the user confirms)."""
    p = get(project_id, actor)
    require(project_id, "delete", actor, allow_archived=True)
    conv_ids = [r["id"] for r in store.q("SELECT id FROM project_conversations WHERE project_id = ?", project_id)]
    pending = store.q1("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending' AND run_id IN (SELECT id FROM runs WHERE project_id = ?)", project_id)["n"]
    return {
        "project": {"id": p["id"], "name": p["name"]},
        "removes": {"conversations": len(conv_ids), "runs": p["counts"]["runs"], "files": p["counts"]["files"],
                    "activity_entries": store.q1("SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?", project_id)["n"],
                    "pending_approvals_discarded": pending},
        "keeps": ["files outside this project's own folder", "other projects", "chats that aren't in this project", "the activity log of actions already carried out"],
        "irreversible": True,
        "confirm_with": p["name"],
    }


def delete(project_id: str, confirm: str, actor: str = OWNER) -> dict:
    """Deletes the project and everything that belongs only to it. `confirm` must be the project's exact name."""
    preview = delete_preview(project_id, actor)
    if confirm != preview["confirm_with"]:
        raise ProjectError(400, "confirmation_required", "Type the project's exact name to confirm deleting it.")
    run_ids = [r["id"] for r in store.q("SELECT id FROM runs WHERE project_id = ?", project_id)]
    conv_ids = [r["id"] for r in store.q("SELECT id FROM project_conversations WHERE project_id = ?", project_id)]
    for rid in run_ids:  # pending changes from this project's runs can no longer be approved
        for a in store.q("SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'", rid):
            patches.reject_patch(a["id"])
            store.x("UPDATE approvals SET status = 'denied', decided_at = ? WHERE id = ?", _now(), a["id"])
    for cid in conv_ids:
        store.x("DELETE FROM conversation_turns WHERE conversation_id = ?", cid)
        store.x("DELETE FROM conversation_runs WHERE conversation_id = ?", cid)
    store.x("DELETE FROM runs WHERE project_id = ?", project_id)
    store.x("DELETE FROM projects WHERE id = ?", project_id)  # members, conversations, files, events: by foreign key
    shutil.rmtree(files_dir(project_id), ignore_errors=True)
    store.audit("n/a", "System", "project_deleted", {"project": preview["project"]["name"], **preview["removes"]}, "deleted")
    return {"deleted": True, **preview["removes"]}


# --- conversations ---


def create_conversation(project_id: str, title: str | None = None, actor: str = OWNER) -> dict:
    require(project_id, "write", actor)
    cid, now = str(uuid.uuid4()), _now()
    title = _clean_text(title, "title", 120) or "New conversation"
    store.x("INSERT INTO project_conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", cid, project_id, title, now, now)
    record(project_id, "conversation_created", f"Started the conversation “{title}”", {"conversation": cid}, actor=actor)
    return conversation(project_id, cid, actor)


def conversations(project_id: str, actor: str = OWNER) -> list[dict]:
    require(project_id, "read", actor)
    return store.q("SELECT * FROM project_conversations WHERE project_id = ? ORDER BY updated_at DESC", project_id)


def conversation(project_id: str, conversation_id: str, actor: str = OWNER) -> dict:
    require(project_id, "read", actor)
    row = store.q1("SELECT * FROM project_conversations WHERE id = ? AND project_id = ?", conversation_id, project_id)
    if not row:
        raise ProjectError(404, "not_found", "No such conversation in this project.")
    turns = store.q("SELECT r.id, r.request, r.status, r.created_at, r.data FROM conversation_runs c JOIN runs r ON r.id = c.run_id "
                    "WHERE c.conversation_id = ? AND r.project_id = ? ORDER BY r.created_at", conversation_id, project_id)
    out = []
    for t in turns:
        data = json.loads(t["data"])
        final = data.get("finalResponse") or {}
        out.append({"runId": t["id"], "request": t["request"], "status": t["status"], "createdAt": t["created_at"], "answer": final.get("summary") or "",
                    "agents": [r.get("agent") for r in data.get("agentResults") or []]})
    return {**row, "turns": out}


def conversation_for_chat(project_id: str, conversation_id: str, actor: str = OWNER) -> dict:
    """Checks a chat message may be added to this project conversation, and marks the conversation as active."""
    require(project_id, "write", actor)
    row = store.q1("SELECT * FROM project_conversations WHERE id = ? AND project_id = ?", conversation_id, project_id)
    if not row:
        raise ProjectError(404, "not_found", "No such conversation in this project.")
    store.x("UPDATE project_conversations SET updated_at = ? WHERE id = ?", _now(), conversation_id)
    store.x("UPDATE projects SET updated_at = ? WHERE id = ?", _now(), project_id)
    return row


def rename_conversation(project_id: str, conversation_id: str, title: str, actor: str = OWNER) -> dict:
    require(project_id, "write", actor)
    title = _clean_text(title, "title", 120, required=True)
    if not store.x("UPDATE project_conversations SET title = ?, updated_at = ? WHERE id = ? AND project_id = ?", title, _now(), conversation_id, project_id):
        raise ProjectError(404, "not_found", "No such conversation in this project.")
    return conversation(project_id, conversation_id, actor)


def runs(project_id: str, actor: str = OWNER, limit: int = 100) -> list[dict]:
    require(project_id, "read", actor)
    return store.q("SELECT id, request, status, created_at FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?", project_id, limit)


# --- files ---


def safe_file_name(name: str) -> str:
    """A plain file name (no folders, no hidden files, no executables); raises otherwise."""
    if not isinstance(name, str):
        raise ProjectError(400, "invalid_name", "File name must be text.")
    base = name.replace("\\", "/").split("/")[-1].strip()
    if base != name.strip() or not SAFE_NAME.fullmatch(base) or base in (".", "..") or "\0" in base:
        raise ProjectError(400, "invalid_name", "Use a plain file name: letters, numbers, spaces and . _ - ( ) + , (no folders, not starting with a dot).")
    if Path(base).suffix.lower() in BLOCKED_EXT:
        raise ProjectError(400, "blocked_type", "Program files (.exe, .app, .dmg...) can't be added to a project.")
    return base


def _file_path(project_id: str, name: str) -> Path:
    root = files_dir(project_id).resolve()
    target = (root / name).resolve()
    if root not in target.parents:  # no path traversal, no links out of the project folder
        raise ProjectError(400, "invalid_name", "That file name isn't allowed.")
    return target


def sync_files(project_id: str) -> list[str]:
    """Brings the file list in line with the project folder: records files that appeared without an upload (an
    approved CodePilot change), refreshes checksums of files changed on disk, and forgets records whose file is
    gone. Returns the names that changed or disappeared (Change Radar looks at those)."""
    root = files_dir(project_id)
    if not root.is_dir():
        return []
    known = {r["name"]: r for r in store.q("SELECT * FROM project_files WHERE project_id = ?", project_id)}
    seen, changed = set(), []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in ("node_modules", "__pycache__")]
        for fn in filenames:
            full = Path(dirpath) / fn
            if fn.startswith(".") or full.is_symlink():
                continue
            rel = full.relative_to(root).as_posix()
            seen.add(rel)
            row = known.get(rel)
            if row is None and len(known) + 1 <= MAX_FILES:
                data = full.read_bytes()
                store.x("INSERT OR IGNORE INTO project_files (id, project_id, name, size, sha256, media_type, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        str(uuid.uuid4()), project_id, rel, len(data), hashlib.sha256(data).hexdigest(), mimetypes.guess_type(fn)[0] or "application/octet-stream", "approved change", _now())
                known[rel] = {}
            elif row:
                data = full.read_bytes()
                sha = hashlib.sha256(data).hexdigest()
                if sha != row["sha256"]:
                    store.x("UPDATE project_files SET size = ?, sha256 = ?, source = 'changed on disk' WHERE id = ?", len(data), sha, row["id"])
                    record(project_id, "file_changed", f"The file {rel} changed", {"file": row["id"], "sha256": sha, "was": row["sha256"]}, actor="OmniPilot", actor_type="system")
                    changed.append(rel)
    gone = {}
    for name, row in known.items():
        if row and name not in seen:
            store.x("DELETE FROM project_files WHERE id = ?", row["id"])
            changed.append(name)
            gone[name] = row["id"]
    if changed:
        from . import radar

        for name in changed:
            radar.on_file_change(project_id, name, gone.get(name))
    return changed


def add_file(project_id: str, name: str, data: bytes, actor: str = OWNER, source: str = "upload", replace: bool = False) -> dict:
    require(project_id, "write", actor)
    name = safe_file_name(name)
    if not isinstance(data, (bytes, bytearray)) or not data:
        raise ProjectError(400, "empty", "That file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise ProjectError(413, "too_large", f"Files can be at most {MAX_FILE_BYTES // (1024 * 1024)} MB.")
    existing = store.q1("SELECT * FROM project_files WHERE project_id = ? AND name = ?", project_id, name)
    if existing and not replace:
        raise ProjectError(409, "exists", f"This project already has a file named “{name}”.")
    if not existing and store.q1("SELECT COUNT(*) AS n FROM project_files WHERE project_id = ?", project_id)["n"] >= MAX_FILES:
        raise ProjectError(409, "too_many_files", f"A project can hold at most {MAX_FILES} files.")
    path = _file_path(project_id, name)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise ProjectError(400, "invalid_name", "That file name isn't allowed.")
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_bytes(bytes(data))
    os.replace(tmp, path)
    sha = hashlib.sha256(data).hexdigest()
    media = mimetypes.guess_type(name)[0] or "application/octet-stream"
    if existing:
        store.x("UPDATE project_files SET size = ?, sha256 = ?, media_type = ?, source = ?, created_at = ? WHERE id = ?", len(data), sha, media, source, _now(), existing["id"])
        fid = existing["id"]
    else:
        fid = str(uuid.uuid4())
        store.x("INSERT INTO project_files (id, project_id, name, size, sha256, media_type, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                fid, project_id, name, len(data), sha, media, source, _now())
    store.x("UPDATE projects SET updated_at = ? WHERE id = ?", _now(), project_id)
    record(project_id, "file_replaced" if existing else "file_added", f"{'Replaced' if existing else 'Added'} the file {name}", {"file": fid, "sha256": sha, "size": len(data), "source": source}, actor=actor)
    if existing and existing["sha256"] != sha:
        from . import radar

        radar.on_file_change(project_id, name)
    return get_file(project_id, fid, actor)


def files(project_id: str, actor: str = OWNER) -> list[dict]:
    require(project_id, "read", actor)
    sync_files(project_id)
    return store.q("SELECT * FROM project_files WHERE project_id = ? ORDER BY name", project_id)


def get_file(project_id: str, file_id: str, actor: str = OWNER) -> dict:
    require(project_id, "read", actor)
    row = store.q1("SELECT * FROM project_files WHERE id = ? AND project_id = ?", file_id, project_id)
    if not row:
        raise ProjectError(404, "not_found", "No such file in this project.")
    return row


def read_file(project_id: str, file_id: str, actor: str = OWNER) -> bytes:
    row = get_file(project_id, file_id, actor)
    path = _file_path(project_id, row["name"])
    if path.is_symlink() or not path.is_file():
        raise ProjectError(404, "missing", "The file is missing from the project folder.")
    return path.read_bytes()


def delete_file(project_id: str, file_id: str, actor: str = OWNER) -> dict:
    require(project_id, "delete", actor)
    row = get_file(project_id, file_id, actor)
    path = _file_path(project_id, row["name"])
    if path.exists() and not path.is_symlink():
        path.unlink()
    store.x("DELETE FROM project_files WHERE id = ? AND project_id = ?", file_id, project_id)
    record(project_id, "file_deleted", f"Deleted the file {row['name']}", {"file": file_id, "sha256": row["sha256"]}, actor=actor)
    from . import radar

    radar.on_file_change(project_id, row["name"], row["id"])
    return {"deleted": True, "name": row["name"]}


# --- copying between projects (always previewed and confirmed) ---


def copy_file_preview(project_id: str, file_id: str, target_id: str, actor: str = OWNER) -> dict:
    src = get_file(project_id, file_id, actor)
    target = require(target_id, "write", actor)
    if target_id == project_id:
        raise ProjectError(400, "same_project", "Choose a different project to copy to.")
    clash = store.q1("SELECT id FROM project_files WHERE project_id = ? AND name = ?", target_id, src["name"])
    return {"file": {"name": src["name"], "size": src["size"], "sha256": src["sha256"]}, "from": require(project_id)["name"], "to": target["name"],
            "conflict": bool(clash), "copies": ["the file's contents"], "does_not_copy": ["conversations or answers that mention it", "approvals", "any connection or permission"]}


def copy_file(project_id: str, file_id: str, target_id: str, confirm: bool, actor: str = OWNER) -> dict:
    preview = copy_file_preview(project_id, file_id, target_id, actor)
    if confirm is not True:
        raise ProjectError(400, "confirmation_required", "Confirm the copy after reviewing the preview.")
    if preview["conflict"]:
        raise ProjectError(409, "exists", f"The other project already has a file named “{preview['file']['name']}”.")
    data = read_file(project_id, file_id, actor)
    copied = add_file(target_id, preview["file"]["name"], data, actor, source=f"copied from project {project_id}")
    record(project_id, "file_copied_out", f"Copied {preview['file']['name']} to “{preview['to']}”", {"file": file_id, "to": target_id}, actor=actor)
    return copied


# --- duplicating a project ---

COPIED = ["name (with “(copy)”)", "description", "type", "deadline", "requirements", "constraints", "milestones", "acceptance criteria",
          "active Project DNA entries (marked as copied, with their confirmation status)"]
NOT_COPIED = ["conversations and answers", "runs", "activity history", "Project DNA history and retired entries", "the Assumption Inbox",
              "approvals and approval grants", "connections, credentials or tokens", "other members' access", "personal preferences"]


def duplicate_preview(project_id: str, include_files: bool = True, actor: str = OWNER) -> dict:
    p = get(project_id, actor)
    return {"from": p["name"], "new_name": f"{p['name']} (copy)"[:120], "copies": COPIED + ([f"{p['counts']['files']} file(s)"] if include_files else []),
            "does_not_copy": NOT_COPIED + ([] if include_files else ["files"])}


def duplicate(project_id: str, include_files: bool = True, actor: str = OWNER) -> dict:
    p = require(project_id, "read", actor)
    preview = duplicate_preview(project_id, include_files, actor)
    new = create({**{f: p[f] for f in ("description", "type", "deadline", *LIST_FIELDS)}, "name": preview["new_name"]}, actor)
    if include_files:
        for f in files(project_id, actor):
            add_file(new["id"], f["name"], read_file(project_id, f["id"], actor), actor, source=f"copied from project {project_id}")
    from . import project_dna

    for f in project_dna.facts(project_id, actor):  # current entries only, each marked as a copy (observations lose their file link)
        basis = "suggested" if f["basis"] == "observed" else f["basis"]
        store.x("INSERT INTO project_facts (id, project_id, kind, content, rationale, basis, status, source_kind, source_ref, actor, actor_type, version, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, 'active', 'copy', ?, ?, ?, 1, ?, ?)", str(uuid.uuid4()), new["id"], f["kind"], f["content"], f["rationale"], basis,
                f"project {project_id}", f["actor"], f["actor_type"], _now(), _now())
    record(new["id"], "project_duplicated", f"Created as a copy of “{p['name']}”", {"from": project_id, "files": include_files}, actor=actor)
    record(project_id, "project_duplicated_out", f"Duplicated as “{new['name']}”", {"to": new["id"]}, actor=actor)
    return get(new["id"], actor)


# --- export ---


def export(project_id: str, actor: str = OWNER, record_event: bool = True) -> dict:
    """The project's own records as JSON. Never includes credentials, tokens or approval grants; any configured
    secret value that appears in text is replaced with [redacted]."""
    p = get(project_id, actor)
    from . import project_dna
    from .tools.base import scrub

    data = {
        "format": "omnipilot.project-export/1",
        "exported_at": _now(),
        "project": {k: p[k] for k in ("id", "name", "description", "type", "deadline", *LIST_FIELDS, "status", "created_at", "updated_at")},
        "conversations": [conversation(project_id, c["id"], actor) for c in conversations(project_id, actor)],
        "files": [{k: f[k] for k in ("name", "size", "sha256", "media_type", "source", "created_at")} for f in files(project_id, actor)],
        "activity": [{k: e[k] for k in ("kind", "actor", "actor_type", "summary", "at")} for e in events(project_id, 500)],
        "dna": [{**{k: f[k] for k in ("kind", "content", "rationale", "basis", "status", "source_kind", "source_ref", "actor", "actor_type", "version", "created_at", "updated_at")},
                 "history": project_dna.history(project_id, f["id"], actor)} for f in project_dna.facts(project_id, actor, include_inactive=True)],
        "assumptions": [{k: a[k] for k in ("statement", "reason", "source_kind", "affected", "status", "correction", "created_at", "resolved_at")} for a in project_dna.assumptions(project_id, actor)],
        "tasks": [{**{k: t[k] for k in ("title", "goal", "constraints", "required_approvals", "out_of_scope", "status", "owner", "reviewer", "created_at")},
                   "acceptance": [{k: c[k] for k in ("text", "state", "evidence_id", "note")} for c in store.q("SELECT * FROM acceptance_checks WHERE task_id = ? ORDER BY rowid", t["id"])]}
                  for t in store.q("SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at", project_id) for t in [{**t, **{k: json.loads(t[k]) for k in ("constraints", "required_approvals", "out_of_scope")}}]],
        "evidence": [{k: e[k] for k in ("id", "kind", "claim", "source", "artifact", "artifact_sha256", "change_stage", "result", "limitations", "actor", "actor_type", "created_at")}
                     for e in store.q("SELECT * FROM evidence_receipts WHERE project_id = ? ORDER BY created_at", project_id)],
        "trace_links": [{k: l[k] for k in ("from_kind", "from_id", "to_kind", "to_id", "note", "actor", "created_at")} for l in store.q("SELECT * FROM trace_links WHERE project_id = ?", project_id)],
        "excluded": ["credentials, tokens and keys", "approval grants and connection permissions", "file contents (listed by name and checksum)",
                     "personal preferences (they're about you, not the project)", "learning notes (yours, not project facts)"],
    }
    text = scrub(json.dumps(data, ensure_ascii=False))
    if record_event:
        record(project_id, "project_exported", "Exported the project (JSON)", actor=actor)
    return json.loads(text)


# --- search (this project only) ---


def search(project_id: str, query: str, actor: str = OWNER, limit: int = 30) -> list[dict]:
    p = require(project_id, "read", actor)
    q = _clean_text(query, "query", 200).lower()
    words = [w for w in re.findall(r"[a-z0-9]+", q) if len(w) > 1]
    if not words:
        return []
    hits: list[dict] = []
    hay = lambda text: sum(1 for w in words if w in (text or "").lower())

    for field in ("name", "description"):
        if hay(p[field]):
            hits.append({"kind": "project", "title": field, "snippet": p[field][:200], "score": hay(p[field])})
    for f in LIST_FIELDS:
        for item in p[f]:
            if hay(item):
                hits.append({"kind": f, "title": f.title(), "snippet": item[:200], "score": hay(item)})
    from . import project_dna

    for f in project_dna.facts(project_id, actor):
        s = hay(f["content"]) + hay(f["rationale"])
        if s:
            hits.append({"kind": f"dna:{f['kind']}", "id": f["id"], "title": f["content"][:120], "snippet": f"{f['basis']}" + (f" · why: {f['rationale'][:120]}" if f["rationale"] else ""), "score": s + 1})
    for a in project_dna.assumptions(project_id, actor):
        if hay(a["statement"]):
            hits.append({"kind": "assumption", "id": a["id"], "title": a["statement"][:120], "snippet": a["status"], "score": hay(a["statement"])})
    for c in conversations(project_id, actor):
        if hay(c["title"]):
            hits.append({"kind": "conversation", "id": c["id"], "title": c["title"], "snippet": "", "score": hay(c["title"]) + 1})
    for r in store.q("SELECT id, request, data FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 300", project_id):
        answer = (json.loads(r["data"]).get("finalResponse") or {}).get("summary") or ""
        s = hay(r["request"]) * 2 + hay(answer)
        if s:
            hits.append({"kind": "answer", "id": r["id"], "title": r["request"][:120], "snippet": answer[:200], "score": s})
    from .brain.files import FileIndex

    idx = FileIndex(str(files_dir(project_id)))
    if files_dir(project_id).is_dir():
        idx.refresh()
        for h in idx.search(q, 10):
            hits.append({"kind": "file", "title": h["file"], "snippet": " … ".join(l["text"] for l in h["lines"][:2]), "score": h["score"]})
        for f in files(project_id, actor):
            if hay(f["name"]) and not any(h["kind"] == "file" and h["title"] == f["name"] for h in hits):
                hits.append({"kind": "file", "id": f["id"], "title": f["name"], "snippet": "", "score": hay(f["name"])})
    return sorted(hits, key=lambda h: -h["score"])[:limit]


# --- home ---


def home(actor: str = OWNER) -> dict:
    """What the Home page shows, all from recorded state (nothing estimated)."""
    projects = list_projects(actor)
    ids = [p["id"] for p in projects]
    recent = store.q("SELECT e.*, p.name AS project_name FROM project_events e JOIN projects p ON p.id = e.project_id "
                     "JOIN project_members m ON m.project_id = p.id AND m.member = ? ORDER BY e.id DESC LIMIT 15", actor)
    pending = store.q("SELECT a.id, a.description, a.risk_level, a.created_at, r.project_id FROM approvals a LEFT JOIN runs r ON r.id = a.run_id "
                      "WHERE a.status = 'pending' ORDER BY a.created_at DESC LIMIT 20")
    pending = [a for a in pending if not a["project_id"] or a["project_id"] in ids]
    failed = store.q("SELECT r.id, r.request, r.status, r.created_at, r.project_id FROM runs r WHERE r.status IN ('failed') AND r.project_id IS NOT NULL ORDER BY r.created_at DESC LIMIT 10")
    failed = [r for r in failed if r["project_id"] in ids]
    suggestions = []
    for p in projects[:10]:
        if not p["acceptance"]:
            suggestions.append({"project_id": p["id"], "project": p["name"], "text": "Add acceptance criteria, so finished work can be checked against them."})
        waiting = store.q1("SELECT COUNT(*) AS n FROM project_assumptions WHERE project_id = ? AND status = 'unverified'", p["id"])["n"]
        if waiting:
            suggestions.append({"project_id": p["id"], "project": p["name"], "text": f"Check {waiting} assumption(s) in the Assumption Inbox."})
        if p["deadline"] and p["deadline"] < _now()[:10]:
            suggestions.append({"project_id": p["id"], "project": p["name"], "text": f"The deadline ({p['deadline']}) has passed: update it or archive the project."})
    return {"projects": projects[:8], "activity": [{**e, "details": json.loads(e["details"])} for e in recent], "pending_approvals": pending,
            "blocked": failed, "suggestions": suggestions[:8]}
