"""Per-project connection grants (docs/product, slice 9).

Connections (Slack, GitHub, Notion, Gmail, Google Drive, Calendar, MCP servers, app tools) are defined once for the
workspace. A project may only use one if it has been granted that capability: read, write or delete. Enforced in
the backend:
  - reading a connected account from inside a project needs its "read" grant (InfraPilot's Gmail/Drive reading);
  - an external action proposed inside a project only runs if the project has the "write" grant, checked again
    at the moment it's approved (so revoking a grant stops actions that are still waiting).
Outside projects (the classic chat), the existing per-action approval flow applies unchanged.
"""
from __future__ import annotations

from . import projects, store
from .projects import OWNER, ProjectError

CONNECTORS = ("Slack", "GitHub", "Notion", "Gmail", "Google Drive", "Google Calendar", "MCP servers", "App tools")
CAPABILITIES = ("read", "write", "delete")
KIND_CONNECTOR = {"slack_message": "Slack", "github_issue": "GitHub", "notion_append": "Notion", "gmail_draft": "Gmail",
                  "drive_create_doc": "Google Drive", "mcp_tool": "MCP servers", "mcp_add_server": "MCP servers", "app_tool": "App tools"}


def grant(project_id: str, connector: str, capability: str, actor: str = OWNER) -> list[dict]:
    projects.require(project_id, "manage", actor)
    if connector not in CONNECTORS or capability not in CAPABILITIES:
        raise ProjectError(400, "invalid_request", "Unknown connection or capability.")
    store.x("INSERT OR IGNORE INTO project_permissions (project_id, connector, capability, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)",
            project_id, connector, capability, actor, store.now())
    projects.record(project_id, "connection_granted", f"Allowed {capability} access to {connector}", {"connector": connector, "capability": capability}, actor=actor)
    return grants_for(project_id, actor)


def revoke(project_id: str, connector: str, capability: str, actor: str = OWNER) -> list[dict]:
    projects.require(project_id, "manage", actor)
    if store.x("DELETE FROM project_permissions WHERE project_id = ? AND connector = ? AND capability = ?", project_id, connector, capability):
        projects.record(project_id, "connection_revoked", f"Removed {capability} access to {connector}", {"connector": connector, "capability": capability}, actor=actor)
    return grants_for(project_id, actor)


def grants_for(project_id: str, actor: str = OWNER) -> list[dict]:
    projects.require(project_id, "read", actor)
    return store.q("SELECT connector, capability, granted_by, granted_at FROM project_permissions WHERE project_id = ? ORDER BY connector, capability", project_id)


def has(project_id: str, connector: str, capability: str) -> bool:
    return bool(store.q1("SELECT 1 AS ok FROM project_permissions WHERE project_id = ? AND connector = ? AND capability = ?", project_id, connector, capability))


def read_problem(connector: str) -> str | None:
    """Inside a project run, reading a connected account needs the project's read grant."""
    scope = projects.current.get()
    if scope and not has(scope["id"], connector, "read"):
        return f"This project hasn't been given read access to {connector}. Allow it in the project's Settings & Permissions, then ask again."
    return None


def problem_for_action(action_id: str, kind: str) -> str | None:
    """An action proposed inside a project runs only with the project's write grant for that connection."""
    row = store.q1("SELECT r.project_id FROM approvals a JOIN runs r ON r.id = a.run_id WHERE a.id = ?", action_id)
    project_id = row["project_id"] if row else None
    if not project_id:
        return None
    connector = KIND_CONNECTOR.get(kind)
    if connector and not has(project_id, connector, "write"):
        return f"This project hasn't been given write access to {connector}, so the action didn't run. Allow it in the project's Settings & Permissions and approve again."
    return None
