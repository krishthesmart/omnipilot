"""MCP servers the user added (a program on this computer over stdio, or a web server over Streamable
HTTP), with the official MCP Python SDK. Adding a server runs a program or opens a URL, so it happens
only after approval. Local servers get a minimal environment: none of OmniPilot's keys."""
from __future__ import annotations

import asyncio
import json
import os
import shlex

from .. import store

TIMEOUT_S = float(os.environ.get("OMNIPILOT_MCP_TIMEOUT_MS", "30000")) / 1000


# One-click MCP servers. Each is a known server a person can add in Connections; adding still runs through
# approval (it starts a program on this computer), and using it inside a project still needs the project's
# "MCP servers" grant. Extend this list to offer more presets.
PRESETS = {
    "blender": {
        "name": "Blender",
        "transport": "stdio",
        "command": "uvx",
        "args": ["blender-mcp"],
        "description": "Drive Blender: inspect and edit the scene, add and transform objects, set materials, and run Python in Blender.",
        "note": "Needs Blender open with the BlenderMCP add-on enabled — it listens on localhost:9876. "
                "Install the add-on from github.com/ahujasid/blender-mcp, then in Blender's sidebar (N) open the BlenderMCP tab and click \"Connect to MCP server\". "
                "`uvx` (from Astral's uv) must be installed; it fetches blender-mcp the first time.",
        "docs": "https://github.com/ahujasid/blender-mcp",
        "risk": "high",
    },
}


def presets() -> list[dict]:
    """The one-click servers, with a human target string, and whether each is already added."""
    installed = {r["name"].lower() for r in store.q("SELECT name FROM mcp_servers")}
    out = []
    for key, p in PRESETS.items():
        out.append({"key": key, "name": p["name"], "description": p["description"], "note": p["note"], "docs": p["docs"],
                    "transport": p["transport"], "target": " ".join([p["command"], *p["args"]]), "risk": p["risk"],
                    "installed": p["name"].lower() in installed})
    return out


def preset_cfg(key: str) -> dict | None:
    """The add-config for a preset (what the approved mcp_add_server action stores)."""
    p = PRESETS.get(key)
    return {"name": p["name"], "transport": p["transport"], "command": p["command"], "args": list(p["args"])} if p else None


def propose_preset(key: str):
    """Queue adding a preset server for approval. Returns the approval ids, or None for an unknown key."""
    from .. import actions

    p, cfg = PRESETS.get(key), preset_cfg(key)
    if not cfg:
        return None
    return actions.propose_connection("mcp_add_server", cfg, f'Add the MCP server "{p["name"]}"', risk=p["risk"])


def _env() -> dict[str, str]:
    return {k: v for k, v in {"PATH": os.environ.get("PATH"), "HOME": os.environ.get("HOME"), "TMPDIR": os.environ.get("TMPDIR"), "LANG": os.environ.get("LANG")}.items() if v}


async def _with_session(cfg: dict, fn):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from mcp.client.streamable_http import streamable_http_client

    if cfg["transport"] == "stdio":
        params = StdioServerParameters(command=cfg["command"], args=cfg.get("args") or [], env=_env())
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await asyncio.wait_for(session.initialize(), TIMEOUT_S)
                return await fn(session)
    import httpx2  # the HTTP client the MCP SDK uses

    async with httpx2.AsyncClient(headers=cfg.get("headers") or {}, timeout=TIMEOUT_S) as http:
        async with streamable_http_client(cfg["url"], http_client=http) as streams:
            read, write = streams[0], streams[1]
            async with ClientSession(read, write) as session:
                await asyncio.wait_for(session.initialize(), TIMEOUT_S)
                return await fn(session)


def _tool_dict(t) -> dict:
    ann = getattr(t, "annotations", None)
    return {
        "name": t.name,
        "description": getattr(t, "description", None) or "",
        "inputSchema": getattr(t, "input_schema", None) or getattr(t, "inputSchema", None) or {},
        "annotations": {"readOnlyHint": getattr(ann, "read_only_hint", None) if ann else None, "destructiveHint": getattr(ann, "destructive_hint", None) if ann else None},
    }


async def probe(cfg: dict) -> list[dict]:
    async def run(session):
        res = await asyncio.wait_for(session.list_tools(), TIMEOUT_S)
        return [_tool_dict(t) for t in res.tools]

    return await asyncio.wait_for(_with_session(cfg, run), TIMEOUT_S + 10)


def _row_to_cfg(r: dict) -> dict:
    return {"name": r["name"], "transport": r["transport"], "command": r.get("command"), "args": json.loads(r["args"] or "[]"), "url": r.get("url"), "headers": json.loads(r["headers"] or "{}")}


def get(name: str) -> dict | None:
    r = store.q1("SELECT * FROM mcp_servers WHERE name = ? COLLATE NOCASE", name)
    return {**_row_to_cfg(r), "tools": json.loads(r["tools"] or "[]")} if r else None


def list_public() -> list[dict]:
    out = []
    for r in store.q("SELECT * FROM mcp_servers ORDER BY name"):
        args = json.loads(r["args"] or "[]")
        out.append({"name": r["name"], "transport": r["transport"], "target": " ".join([r["command"] or "", *args]).strip() if r["transport"] == "stdio" else r["url"], "tools": json.loads(r["tools"] or "[]")})
    return out


async def add(cfg: dict) -> list[dict]:
    tools = await probe(cfg)
    store.x(
        "INSERT OR REPLACE INTO mcp_servers (name, transport, command, args, url, headers, tools, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        cfg["name"], cfg["transport"], cfg.get("command"), json.dumps(cfg.get("args") or []), cfg.get("url"), json.dumps(cfg.get("headers") or {}), json.dumps(tools), store.now(),
    )
    return tools


def remove(name: str) -> bool:
    return store.x("DELETE FROM mcp_servers WHERE name = ? COLLATE NOCASE", name) > 0


async def refresh(name: str) -> list[dict]:
    cfg = get(name)
    if not cfg:
        raise RuntimeError(f'There\'s no MCP server called "{name}".')
    tools = await probe(cfg)
    store.x("UPDATE mcp_servers SET tools = ? WHERE name = ?", json.dumps(tools), cfg["name"])
    return tools


async def call_tool(server: str, tool: str, args: dict) -> dict:
    cfg = get(server)
    if not cfg:
        raise RuntimeError(f'There\'s no MCP server called "{server}".')

    async def run(session):
        return await asyncio.wait_for(session.call_tool(tool, args), TIMEOUT_S)

    res = await asyncio.wait_for(_with_session(cfg, run), TIMEOUT_S + 10)
    parts = []
    for c in getattr(res, "content", None) or []:
        kind = getattr(c, "type", "")
        parts.append(getattr(c, "text", "") if kind == "text" else f"[{kind} content]")
    return {"text": "\n".join(parts)[:20_000], "isError": bool(getattr(res, "is_error", False) or getattr(res, "isError", False))}


def split_command(line: str) -> list[str]:
    home = os.environ.get("HOME", "")
    return [a.replace("~/", home + "/", 1) if a.startswith("~/") and home else a for a in shlex.split(line)]


def is_read_only(tool: dict) -> bool:
    a = tool.get("annotations") or {}
    return a.get("readOnlyHint") is True and a.get("destructiveHint") is not True
