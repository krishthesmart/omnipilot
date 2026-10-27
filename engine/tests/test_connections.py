"""One-click MCP connections (e.g. Blender): a preset is proposed as an approved action, runs through the normal
approval + Permission Preview, and using it inside a project still needs the project's "MCP servers" grant."""
import pytest

from omnipilot_engine import actions, approvals, grants, projects, store
from omnipilot_engine.integrations import mcp_servers


@pytest.fixture
def py_runs(monkeypatch):
    monkeypatch.setenv("OMNIPILOT_RUNS", "python")


def test_blender_is_a_one_click_preset_with_the_right_command():
    keys = {p["key"] for p in mcp_servers.presets()}
    assert "blender" in keys
    cfg = mcp_servers.preset_cfg("blender")
    assert cfg == {"name": "Blender", "transport": "stdio", "command": "uvx", "args": ["blender-mcp"]}
    assert mcp_servers.preset_cfg("nope") is None


async def test_adding_blender_goes_through_approval_and_then_appears_installed(monkeypatch):
    added = {}

    async def fake_add(cfg):  # stands in for actually starting `uvx blender-mcp`
        added["cfg"] = cfg
        store.x("INSERT OR REPLACE INTO mcp_servers (name, transport, command, args, url, headers, tools, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                cfg["name"], cfg["transport"], cfg["command"], "[]", None, "{}", "[]", store.now())
        return [{"name": "get_scene_info"}, {"name": "execute_code"}]

    monkeypatch.setattr(mcp_servers, "add", fake_add)
    out = mcp_servers.propose_preset("blender")
    assert out and out["approvalId"] and out["runId"]
    # it's waiting for approval, with a Permission Preview that names exactly what will run
    pv = approvals.preview(out["approvalId"])
    assert pv["kind"] == "mcp_add_server" and "Blender" in pv["target"] and pv["status"] == "pending"
    assert store.get_run(out["runId"])["status"] == "needs_approval"
    # approve it: the server is added and the setup run is settled
    res = await approvals.decide(out["approvalId"], "approved")
    assert res["outcome"]["ok"] and added["cfg"]["args"] == ["blender-mcp"]
    assert any(s["name"] == "Blender" for s in mcp_servers.presets() if s["installed"])
    assert store.get_run(out["runId"])["status"] == "completed"


async def test_a_project_needs_the_mcp_grant_to_run_a_blender_tool(py_runs, monkeypatch):
    """Using an MCP tool proposed inside a project is blocked until the project is granted MCP write access."""
    p = projects.create({"name": "3D scene"})
    aid = "act-mcp-1"
    actions.save_action(aid, "mcp_tool", {"server": "Blender", "tool": "execute_code", "args": {"code": "print(1)"}})
    run_id = "run-mcp-1"
    store.save_run(run_id, "use blender", store.now(), "needs_approval", {"id": run_id, "projectId": p["id"]})
    store.create_approval(aid, run_id, "InfraPilot", "Run execute_code on Blender", "high")

    called = {"n": 0}

    async def fake_call(server, tool, args):
        called["n"] += 1
        return {"isError": False, "text": "ok"}

    monkeypatch.setattr(mcp_servers, "call_tool", fake_call)
    with pytest.raises(approvals.ApprovalError) as e:
        await approvals.decide(aid, "approved")
    assert e.value.code == "not_granted" and called["n"] == 0  # blocked, nothing ran
    grants.grant(p["id"], "MCP servers", "write")
    res = await approvals.decide(aid, "approved")
    assert res["outcome"]["ok"] and called["n"] == 1


async def test_add_a_remote_mcp_server_by_url_runs_no_local_program(monkeypatch):
    """A remote MCP server is added by URL through approval; nothing starts on this computer."""
    added = {}

    async def fake_add(cfg):
        added["cfg"] = cfg
        return [{"name": "search_docs"}]

    monkeypatch.setattr(mcp_servers, "add", fake_add)
    out = actions.propose_connection("mcp_add_server", {"name": "Docs", "transport": "http", "url": "https://example.com/mcp"},
                                     'Add the MCP server "Docs" (remote URL)', risk="medium")
    pv = approvals.preview(out["approvalId"])
    assert pv["kind"] == "mcp_add_server" and "Docs" in pv["target"] and pv["risk"] == "medium"
    res = await approvals.decide(out["approvalId"], "approved")
    assert res["outcome"]["ok"] and added["cfg"]["transport"] == "http" and added["cfg"]["url"] == "https://example.com/mcp"
    assert "command" not in added["cfg"] or not added["cfg"].get("command")  # no local program
