"""Actions an agent proposes that change something outside OmniPilot (post to Slack, open a GitHub issue,
add to a Notion page, save a Gmail draft, create a Google Doc, call an MCP tool, add an MCP server). The
exact parameters are stored when the action is proposed; the app only sends back "approved" or "denied",
so what runs is exactly what the user saw. Each action runs at most once; a failed one stays pending so
the user can fix the cause and try again. Same table as the TypeScript engine (pending_actions)."""
from __future__ import annotations

import json

from . import store
from .integrations import drive, gmail, mcp_servers, services


async def _mcp_tool(p: dict) -> dict:
    r = await mcp_servers.call_tool(p["server"], p["tool"], p.get("args") or {})
    if r["isError"]:
        return {"ok": False, "message": f"{p['tool']} reported an error: {r['text'][:400]}"}
    return {"ok": True, "message": f"Ran {p['tool']} on {p['server']}." + (f"\n\n{r['text'][:1500]}" if r["text"] else "")}


async def _mcp_add(cfg: dict) -> dict:
    tools = await mcp_servers.add(cfg)
    names = ", ".join(t["name"] for t in tools[:12])
    return {"ok": True, "message": f'Added the MCP server "{cfg["name"]}" with {len(tools)} tool{"" if len(tools) == 1 else "s"}' + (f": {names}" if tools else "") + "."}


async def _app_tool(p: dict) -> dict:
    from .tools import router
    from .tools.base import Budget, ToolError

    try:
        out = await router.run("app_action", {"tool": p["tool"], "arguments": p.get("arguments") or {}, "approved": True}, Budget(max_calls=1))
    except ToolError as err:
        return {"ok": False, "message": str(err)[:300]}
    data = out.get("data")
    return {"ok": True, "message": f"Ran {p['tool']}." + (f"\n\n{str(data)[:1500]}" if data else "")}


EXECUTORS = {
    "app_tool": _app_tool,
    "slack_message": services.post_slack_message,
    "github_issue": services.create_github_issue,
    "notion_append": services.append_to_notion,
    "gmail_draft": gmail.save_draft,
    "drive_create_doc": drive.create_doc,
    "mcp_tool": _mcp_tool,
    "mcp_add_server": _mcp_add,
}


def payload_sha256(kind: str, params: dict) -> str:
    """The exact action, fingerprinted: approval is bound to this (a changed payload needs fresh approval)."""
    import hashlib

    return hashlib.sha256(json.dumps({"kind": kind, "params": params}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


TARGETS = {
    "slack_message": lambda p: f"Slack {p.get('channel', '?')}",
    "github_issue": lambda p: f"GitHub repository {p.get('repo', '?')}",
    "notion_append": lambda p: f"Notion page {p.get('page_id', p.get('page', '?'))}",
    "gmail_draft": lambda p: f"Gmail drafts (to {p.get('to', '?')})",
    "drive_create_doc": lambda p: "Google Drive (a new document)",
    "mcp_tool": lambda p: f"MCP server {p.get('server', '?')}, tool {p.get('tool', '?')}",
    "mcp_add_server": lambda p: f"this computer's MCP server list ({p.get('name', '?')})",
    "app_tool": lambda p: f"app tool {p.get('tool', '?')} (via Arcade/Composio)",
}


def propose_connection(kind: str, params: dict, description: str, risk: str = "high", agent: str = "InfraPilot") -> dict:
    """Queue a connection-setup action (e.g. adding an MCP server) for approval, from outside a chat run.
    It shows up in Activity & Approvals with the Permission Preview and runs only once approved."""
    import uuid

    run_id, action_id, now = str(uuid.uuid4()), str(uuid.uuid4()), store.now()
    save_action(action_id, kind, params)
    store.save_run(run_id, description, now, "needs_approval", {"id": run_id, "request": description, "createdAt": now, "status": "needs_approval"})
    store.create_approval(action_id, run_id, agent, description, risk)
    store.audit(run_id, agent, f"propose_{kind}", {"name": params.get("name")}, "awaiting_approval")
    return {"approvalId": action_id, "runId": run_id}


def save_action(id: str, kind: str, params: dict) -> None:
    target = TARGETS.get(kind, lambda p: kind)(params)
    store.x("INSERT OR REPLACE INTO pending_actions (id, kind, params, status, created_at, payload_sha256, target) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
            id, kind, json.dumps(params), store.now(), payload_sha256(kind, params), target)


def preview(id: str) -> dict | None:
    """Permission Preview: exactly what will happen, to what, and whether it can be undone (secrets hidden)."""
    a = get_action(id)
    if not a:
        return None
    from .tools.base import scrub

    p, kind = a["params"], a["kind"]
    info = {
        "slack_message": ("Post a message", f"Posts this text: “{str(p.get('text', ''))[:400]}”", "One new message in that channel",
                          "No other messages, channels or members", "Can be deleted in Slack, but people may already have seen it or been notified"),
        "github_issue": ("Open an issue", f"Creates an issue titled “{str(p.get('title', ''))[:200]}” with the body shown", "One new issue",
                         "No code, branches or other issues", "Can be closed, but usually not deleted; it may notify watchers"),
        "notion_append": ("Add to a page", f"Appends: “{str(p.get('text', ''))[:400]}”", "New paragraphs at the end of that page",
                          "Existing content on the page", "The added blocks can be deleted in Notion"),
        "gmail_draft": ("Save an email draft", f"Draft to {p.get('to', '?')}: “{str(p.get('subject', ''))[:150]}”", "One draft (not sent)",
                        "Nothing is sent; no other emails change", "Fully reversible: delete the draft"),
        "drive_create_doc": ("Create a document", f"New Google Doc “{str(p.get('title', ''))[:150]}”", "One new document",
                             "Existing files", "Can be deleted from Drive"),
        "mcp_tool": ("Run an external tool", f"Calls {p.get('tool', '?')} with the arguments shown", "Whatever that tool does",
                     "OmniPilot can't know what the tool leaves untouched", "Unknown: depends on the tool; treat as irreversible"),
        "mcp_add_server": ("Add an MCP server", f"Adds “{p.get('name', '?')}” and lets OmniPilot start it", "OmniPilot's MCP server list",
                           "Your files and other servers", "Reversible: remove the server"),
        "app_tool": ("Run an app action", f"Runs {p.get('tool', '?')} with the arguments shown", "Whatever that action does in the app",
                     "Other data in the app", "Depends on the app; treat as irreversible unless you know otherwise"),
    }.get(kind, (kind, "Runs the stored action", "Unknown", "Unknown", "Unknown"))
    return {"id": id, "kind": kind, "action": info[0], "target": a.get("target") or TARGETS.get(kind, lambda q: kind)(p), "changes": scrub(info[1]),
            "scope": info[2], "will_not_change": info[3], "recoverability": info[4], "payload_sha256": a.get("payload_sha256"),
            "payload": json.loads(scrub(json.dumps(p, ensure_ascii=False))), "status": a["status"]}


def get_action(id: str) -> dict | None:
    r = store.q1("SELECT * FROM pending_actions WHERE id = ?", id)
    if not r:
        return None
    return {"id": r["id"], "kind": r["kind"], "params": json.loads(r["params"]), "status": r["status"], "result": json.loads(r["result"]) if r["result"] else None,
            "payload_sha256": r.get("payload_sha256"), "target": r.get("target")}


async def execute_action(id: str, expected_sha256: str | None = None) -> dict:
    a = get_action(id)
    if not a:
        return {"ok": False, "message": "There's nothing to run for this approval."}
    # Approval is bound to the exact payload: if what's stored no longer matches what was approved, it doesn't run.
    current = payload_sha256(a["kind"], a["params"])
    if (a.get("payload_sha256") and a["payload_sha256"] != current) or (expected_sha256 and expected_sha256 != current):
        return {"ok": False, "code": "payload_changed", "message": "The action changed since it was shown to you, so it needs fresh approval."}
    blocked = _grant_problem(id, a["kind"])
    if blocked:
        return {"ok": False, "code": "not_granted", "message": blocked}
    # Claim it first, so two quick clicks can't run it twice.
    if not store.x("UPDATE pending_actions SET status = 'running' WHERE id = ? AND status = 'pending'", id):
        return {"ok": False, "message": f"This action was already {a['status']}."}
    run = EXECUTORS.get(a["kind"])
    try:
        outcome = await run(a["params"]) if run else {"ok": False, "message": f'OmniPilot doesn\'t know how to run "{a["kind"]}".'}
    except Exception as err:  # noqa: BLE001 -- any failure is reported, and the action stays pending
        outcome = {"ok": False, "message": str(err)[:300] or "It failed."}
    store.x("UPDATE pending_actions SET status = ?, result = ?, done_at = ? WHERE id = ?", "done" if outcome.get("ok") else "pending", json.dumps(outcome), store.now(), id)
    return outcome


def _grant_problem(id: str, kind: str) -> str | None:
    """Actions proposed inside a project need that project's write grant for the connection (slice 9)."""
    from . import grants

    return grants.problem_for_action(id, kind)


def reconcile_action(id: str, outcome: str) -> dict:
    """For an action whose result is uncertain (OmniPilot stopped while it was running): the person checks the
    service and records what happened. 'succeeded' marks it done (never re-run); 'failed' makes it runnable again."""
    a = get_action(id)
    if not a or a["status"] != "running":
        return {"ok": False, "message": "Only an action whose outcome is uncertain can be reconciled."}
    if outcome not in ("succeeded", "failed"):
        return {"ok": False, "message": "outcome must be succeeded or failed"}
    store.x("UPDATE pending_actions SET status = ?, result = ?, done_at = ? WHERE id = ?", "done" if outcome == "succeeded" else "pending",
            json.dumps({"ok": outcome == "succeeded", "message": f"Reconciled by hand: {outcome}."}), store.now(), id)
    return {"ok": True, "status": "done" if outcome == "succeeded" else "pending"}


def reject_action(id: str) -> None:
    store.x("UPDATE pending_actions SET status = 'rejected' WHERE id = ? AND status = 'pending'", id)
