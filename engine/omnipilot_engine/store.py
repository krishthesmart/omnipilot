"""OmniPilot's database (SQLite), the same file and tables the TypeScript engine uses while the move to
Python is in progress (server/data/omnipilot.sqlite, or OMNIPILOT_DB_PATH). Secrets kept here
(connector tokens, the session signing secret) are never returned by the API or written to logs."""
from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import envfiles

envfiles.load()

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def db_path() -> str:
    if os.environ.get("OMNIPILOT_DB_PATH"):
        return os.environ["OMNIPILOT_DB_PATH"]
    data = Path(os.environ.get("OMNIPILOT_DATA_DIR") or (envfiles.ROOT / "server" / "data"))
    return str(data / "omnipilot.sqlite")


SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, request TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, timestamp TEXT NOT NULL, agent TEXT NOT NULL, action TEXT NOT NULL, parameters TEXT NOT NULL, outcome TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connectors (name TEXT PRIMARY KEY, kind TEXT NOT NULL, verification TEXT NOT NULL, status TEXT NOT NULL, account_label TEXT, secret_token TEXT, connected_at TEXT);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent TEXT NOT NULL, description TEXT NOT NULL, risk_level TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skills (name TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL, instructions TEXT NOT NULL, daily_at TEXT, last_run_date TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS code_patches (id TEXT PRIMARY KEY, file TEXT NOT NULL, original_hash TEXT NOT NULL, original TEXT NOT NULL, fixed TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, applied_at TEXT);
CREATE TABLE IF NOT EXISTS pending_actions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, created_at TEXT NOT NULL, done_at TEXT);
CREATE TABLE IF NOT EXISTS mcp_servers (name TEXT PRIMARY KEY, transport TEXT NOT NULL, command TEXT, args TEXT, url TEXT, headers TEXT, tools TEXT, added_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_runs (run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, request TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_conversation_runs ON conversation_runs (conversation_id, at);
CREATE TABLE IF NOT EXISTS conversation_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_turns_conversation ON conversation_turns (conversation_id, id);
CREATE TABLE IF NOT EXISTS lessons (id INTEGER PRIMARY KEY AUTOINCREMENT, lesson TEXT NOT NULL, topics TEXT NOT NULL, source TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS feedback (run_id TEXT PRIMARY KEY, rating INTEGER NOT NULL, comment TEXT, lessons_used TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS run_lessons (run_id TEXT PRIMARY KEY, lesson_ids TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS watcher_policy (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, pin_hash TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS watcher_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, url TEXT NOT NULL, title TEXT, decision TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS school_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, subject TEXT, kind TEXT NOT NULL, due TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '[]', done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS models3d (conversation_id TEXT PRIMARY KEY, model TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS run_access (run_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, created_at TEXT NOT NULL);
-- Projects (docs/product): each project's own conversations, files and activity. Children are deleted with
-- their project (foreign keys), and nothing here is shared between projects.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'general', deadline TEXT,
  requirements TEXT NOT NULL DEFAULT '[]', constraints TEXT NOT NULL DEFAULT '[]', milestones TEXT NOT NULL DEFAULT '[]', acceptance TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, member TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'approver', 'reviewer', 'task_owner', 'viewer')), added_at TEXT NOT NULL, PRIMARY KEY (project_id, member));
CREATE TABLE IF NOT EXISTS project_conversations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS project_conversations_project ON project_conversations (project_id, updated_at);
CREATE TABLE IF NOT EXISTS project_files (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, media_type TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'upload', created_at TEXT NOT NULL, UNIQUE (project_id, name));
CREATE INDEX IF NOT EXISTS project_files_project ON project_files (project_id);
CREATE TABLE IF NOT EXISTS project_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  actor TEXT NOT NULL, actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')), summary TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS project_events_project ON project_events (project_id, at);
-- Project DNA (slice 2): what is known about a project, where each entry came from, and how sure it is.
-- basis: confirmed (a person confirmed it), observed (read from a project file), suggested (an agent's guess).
CREATE TABLE IF NOT EXISTS project_facts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('goal', 'requirement', 'constraint', 'file_ref', 'decision', 'open_question', 'known_problem', 'assumption')),
  content TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '',
  basis TEXT NOT NULL CHECK (basis IN ('confirmed', 'observed', 'suggested')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'superseded')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('user', 'file', 'run', 'assumption', 'copy')), source_ref TEXT NOT NULL DEFAULT '', source_sha256 TEXT,
  actor TEXT NOT NULL, actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  superseded_by TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS project_facts_project ON project_facts (project_id, kind, status);
CREATE TABLE IF NOT EXISTS project_fact_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, fact_id TEXT NOT NULL REFERENCES project_facts(id) ON DELETE CASCADE, version INTEGER NOT NULL,
  content TEXT NOT NULL, rationale TEXT NOT NULL, basis TEXT NOT NULL, status TEXT NOT NULL, actor TEXT NOT NULL, actor_type TEXT NOT NULL, note TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS project_fact_history_fact ON project_fact_history (fact_id, version);
CREATE TABLE IF NOT EXISTS project_assumptions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, statement TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL CHECK (source_kind IN ('user', 'run', 'file')), source_ref TEXT NOT NULL DEFAULT '', affected TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'confirmed', 'corrected', 'dismissed')), correction TEXT NOT NULL DEFAULT '',
  fact_id TEXT, actor TEXT NOT NULL, actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  resolved_by TEXT, resolved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS project_assumptions_project ON project_assumptions (project_id, status);
-- Personal preferences: about the person, not any project (never exported or copied with a project).
CREATE TABLE IF NOT EXISTS personal_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
-- Slice 3: tasks with outcome contracts; runs recorded step by step (Recovery Mode).
CREATE TABLE IF NOT EXISTS project_tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '',
  constraints TEXT NOT NULL DEFAULT '[]', required_approvals TEXT NOT NULL DEFAULT '[]', out_of_scope TEXT NOT NULL DEFAULT '[]', request TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'awaiting_approval', 'blocked', 'completed', 'failed', 'cancelled', 'interrupted')),
  owner TEXT NOT NULL DEFAULT 'owner', reviewer TEXT, recipe_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS project_tasks_project ON project_tasks (project_id, status);
CREATE TABLE IF NOT EXISTS acceptance_checks (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL, requirement TEXT, state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'passed', 'failed', 'blocked', 'not_applicable')),
  evidence_id TEXT, note TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT 'owner', updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS acceptance_checks_task ON acceptance_checks (task_id);
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL, run_id TEXT, status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'awaiting_approval', 'blocked', 'completed', 'failed', 'cancelled', 'interrupted')),
  router TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', usage TEXT NOT NULL DEFAULT '{}', started_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX IF NOT EXISTS task_runs_task ON task_runs (task_id, attempt);
CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'awaiting_approval', 'blocked', 'completed', 'failed', 'cancelled', 'interrupted', 'uncertain')),
  writes INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT, input TEXT NOT NULL DEFAULT '{}', output TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '',
  external_id TEXT, started_at TEXT, finished_at TEXT);
CREATE INDEX IF NOT EXISTS run_steps_run ON run_steps (task_run_id, seq);
-- Slice 4: evidence receipts (what supports a claim, for which exact artifact version).
CREATE TABLE IF NOT EXISTS evidence_receipts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, task_id TEXT, run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('source', 'file', 'test', 'tool_output', 'observation', 'human')), claim TEXT NOT NULL, source TEXT NOT NULL DEFAULT '',
  artifact TEXT NOT NULL DEFAULT '', artifact_sha256 TEXT, change_stage TEXT NOT NULL DEFAULT 'none' CHECK (change_stage IN ('none', 'proposed', 'applied', 'tested')),
  result TEXT NOT NULL CHECK (result IN ('supports', 'contradicts', 'inconclusive')), limitations TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL, actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')), created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS evidence_receipts_project ON evidence_receipts (project_id, created_at);
-- Slice 5: change radar and research-to-build links.
CREATE TABLE IF NOT EXISTS change_alerts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, trigger_kind TEXT NOT NULL, trigger_ref TEXT NOT NULL, trigger_summary TEXT NOT NULL,
  affected_kind TEXT NOT NULL, affected_ref TEXT NOT NULL, affected_summary TEXT NOT NULL, relation TEXT NOT NULL CHECK (relation IN ('confirmed', 'suspected')),
  explanation TEXT NOT NULL, next_step TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed', 'postponed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS change_alerts_project ON change_alerts (project_id, status);
CREATE TABLE IF NOT EXISTS trace_links (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, from_kind TEXT NOT NULL, from_id TEXT NOT NULL,
  to_kind TEXT NOT NULL, to_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (from_kind, from_id, to_kind, to_id));
CREATE INDEX IF NOT EXISTS trace_links_project ON trace_links (project_id);
CREATE TABLE IF NOT EXISTS readiness_checks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, results TEXT NOT NULL, created_at TEXT NOT NULL);
-- Slice 6: comparison bench, branches, plan challenges.
CREATE TABLE IF NOT EXISTS comparison_sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('prompt', 'code', 'simulation')),
  title TEXT NOT NULL, inputs TEXT NOT NULL, criteria TEXT NOT NULL, results TEXT NOT NULL, limitations TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_branches (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'abandoned')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS branch_changes (
  id TEXT PRIMARY KEY, branch_id TEXT NOT NULL REFERENCES project_branches(id) ON DELETE CASCADE, op TEXT NOT NULL CHECK (op IN ('add_fact', 'edit_fact', 'retire_fact', 'add_task', 'add_evidence')),
  target_id TEXT, base_version INTEGER, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'merged', 'conflict', 'discarded')), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plan_challenges (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, target TEXT NOT NULL, items TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL);
-- Slice 7: learning (kept apart from project facts) and return briefings.
CREATE TABLE IF NOT EXISTS learning_notes (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, mode TEXT NOT NULL CHECK (mode IN ('explain', 'hint', 'question', 'check', 'present')),
  subject TEXT NOT NULL, depth TEXT NOT NULL DEFAULT 'normal', user_input TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_visits (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, last_seen_event INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT NOT NULL);
-- Slice 8: handoff capsules, recipes, routines.
CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, preset TEXT NOT NULL, removed TEXT NOT NULL, content_json TEXT NOT NULL, content_md TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', inputs TEXT NOT NULL, steps TEXT NOT NULL, acceptance TEXT NOT NULL, outputs TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recipe_routines (
  id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  daily_at TEXT NOT NULL, inputs TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, last_run_date TEXT, created_at TEXT NOT NULL);
-- Slice 9: per-project connection grants and run budgets.
CREATE TABLE IF NOT EXISTS project_permissions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, connector TEXT NOT NULL, capability TEXT NOT NULL CHECK (capability IN ('read', 'write', 'delete')),
  granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY (project_id, connector, capability));
CREATE TABLE IF NOT EXISTS project_settings (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, run_budget_usd REAL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS code_issues (fingerprint TEXT PRIMARY KEY, file TEXT NOT NULL, line INTEGER NOT NULL, rule_id TEXT NOT NULL, title TEXT NOT NULL,
  severity TEXT NOT NULL, first_seen TEXT NOT NULL, alerted INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0);
"""

SEED_CONNECTORS = [
    ("Slack", "messaging", "token"),
    ("GitHub", "code_hosting", "token"),
    ("Notion", "docs", "token"),
    ("Google Calendar", "calendar", "token"),
    ("Gmail", "email", "token"),
    ("Google Drive", "storage", "oauth"),
]


def private_files(path: str) -> None:
    """Only this user may read the database (it holds connected accounts' tokens and the session secret)."""
    for p in (path, f"{path}-wal", f"{path}-shm"):
        try:
            os.chmod(p, 0o600)
        except OSError:
            pass


def conn() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            path = db_path()
            if path != ":memory:":
                Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            c = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
            c.row_factory = sqlite3.Row
            if path != ":memory:":
                c.execute("PRAGMA journal_mode=WAL")
                private_files(path)
            c.execute("PRAGMA busy_timeout=3000")
            c.execute("PRAGMA foreign_keys=ON")  # project records are deleted with their project
            c.executescript(SCHEMA)
            for col in ("set_id TEXT", "is_new INTEGER NOT NULL DEFAULT 0"):
                try:
                    c.execute(f"ALTER TABLE code_patches ADD COLUMN {col}")
                except sqlite3.OperationalError:
                    pass  # already there
            for col in ("payload_sha256 TEXT", "target TEXT"):  # approval binding (slice 4)
                try:
                    c.execute(f"ALTER TABLE pending_actions ADD COLUMN {col}")
                except sqlite3.OperationalError:
                    pass
            try:  # additive migration: which project a run belongs to (NULL = outside any project)
                c.execute("ALTER TABLE runs ADD COLUMN project_id TEXT")
            except sqlite3.OperationalError:
                pass
            c.execute("CREATE INDEX IF NOT EXISTS runs_project ON runs (project_id, created_at)")
            for name, kind, verification in SEED_CONNECTORS:
                c.execute("INSERT OR IGNORE INTO connectors (name, kind, verification, status) VALUES (?, ?, ?, 'not_connected')", (name, kind, verification))
            _conn = c
        return _conn


def reset_for_tests() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            _conn.close()
        _conn = None


def q(sql: str, *params) -> list[dict]:
    with _lock:
        return [dict(r) for r in conn().execute(sql, params).fetchall()]


def q1(sql: str, *params) -> dict | None:
    rows = q(sql, *params)
    return rows[0] if rows else None


def x(sql: str, *params) -> int:
    with _lock:
        return conn().execute(sql, params).rowcount


# --- settings ---


def get_setting(key: str) -> str | None:
    row = q1("SELECT value FROM settings WHERE key = ?", key)
    return row["value"] if row else None


def set_setting(key: str, value: str | None) -> None:
    if value is None:
        x("DELETE FROM settings WHERE key = ?", key)
    else:
        x("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", key, value)


# --- activity log (secrets are never written) ---

SECRET_KEY = re.compile(r"key|token|secret|password|authorization", re.I)


def redact(params: dict) -> dict:
    out = {}
    for k, v in (params or {}).items():
        if SECRET_KEY.search(k):
            out[k] = "[redacted]"
        elif isinstance(v, str) and len(v) > 500:
            out[k] = v[:500] + "…[truncated]"
        else:
            out[k] = v
    return out


AUDIT_HOOKS: list = []  # called with each entry (the live event stream registers here)


def audit(run_id: str, agent: str, action: str, parameters: dict, outcome: str) -> dict:
    entry = {"id": str(uuid.uuid4()), "runId": run_id, "timestamp": now(), "agent": agent, "action": action, "parameters": redact(parameters), "outcome": outcome}
    x(
        "INSERT INTO audit_log (id, run_id, timestamp, agent, action, parameters, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)",
        entry["id"], run_id, entry["timestamp"], agent, action, json.dumps(entry["parameters"]), outcome,
    )
    for hook in AUDIT_HOOKS:
        hook(entry)
    return entry


# --- connectors (public views never include secret_token) ---

PUBLIC_CONNECTOR = "SELECT name, kind, verification, status, account_label, connected_at FROM connectors"


def list_connectors() -> list[dict]:
    return q(PUBLIC_CONNECTOR + " ORDER BY name ASC")


def connector_public(name: str) -> dict | None:
    return q1(PUBLIC_CONNECTOR + " WHERE name = ?", name)


def connector_internal(name: str) -> dict | None:
    """Includes secret_token: never return this from a route."""
    return q1("SELECT * FROM connectors WHERE name = ?", name)


def set_connector_status(name: str, status: str) -> None:
    x("UPDATE connectors SET status = ?, connected_at = ?, account_label = NULL, secret_token = NULL WHERE name = ?", status, now() if status == "connected" else None, name)


def set_connector_verified(name: str, account_label: str, secret_token: str) -> None:
    x("UPDATE connectors SET status = 'connected', account_label = ?, secret_token = ?, connected_at = ? WHERE name = ?", account_label, secret_token, now(), name)


# --- approvals ---


def get_approval(id: str) -> dict | None:
    return q1("SELECT * FROM approvals WHERE id = ?", id)


def list_approvals(run_id: str | None = None) -> list[dict]:
    if run_id:
        return q("SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at DESC", run_id)
    return q("SELECT * FROM approvals ORDER BY created_at DESC")


def decide_approval(id: str, status: str) -> None:
    x("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?", status, now(), id)


def create_approval(id: str, run_id: str, agent: str, description: str, risk_level: str) -> None:
    x("INSERT OR IGNORE INTO approvals (id, run_id, agent, description, risk_level, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)", id, run_id, agent, description, risk_level, now())


def save_run(id: str, request: str, created_at: str, status: str, data: dict) -> None:
    x("INSERT INTO runs (id, request, created_at, status, data, project_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data",
      id, request, created_at, status, json.dumps(data), data.get("projectId"))


def list_runs(limit: int = 50) -> list[dict]:
    return q("SELECT id, request, created_at, status FROM runs ORDER BY created_at DESC LIMIT ?", limit)


def get_run(id: str) -> dict | None:
    row = q1("SELECT * FROM runs WHERE id = ?", id)
    if row:
        row["data"] = json.loads(row["data"])
    return row
