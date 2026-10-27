"""Stage 2 of the move to Python: change sets, approved actions, approvals, connectors, MCP servers,
skills. Nothing here reaches a real service (verifiers and executors are replaced), and every test
uses its own database and workspace folder (conftest.py)."""
import json
import os
import sys
from pathlib import Path


from omnipilot_engine import actions, auth, patches, store
from omnipilot_engine.integrations import drive, mcp_servers, services

ECHO = str(Path(__file__).parent / "fixtures" / "echo_mcp.py")
LOCAL = {"Origin": "http://localhost:8899"}


def ws() -> Path:
    return Path(os.environ["OMNIPILOT_WORKSPACE"])


def approval(id: str, agent: str = "CodePilot") -> None:
    store.x("INSERT INTO approvals (id, run_id, agent, description, risk_level, status, created_at) VALUES (?, 'run1', ?, 'test', 'medium', 'pending', ?)", id, agent, store.now())


# --- change sets ---


def test_a_change_set_is_applied_completely_and_undone():
    (ws() / "a.txt").write_text("one\ntwo\n")
    patches.save_patch_set("s1", "edit and add", [{"file": "a.txt", "original": "one\ntwo\n", "fixed": "one\n2\n"}, {"file": "new/b.txt", "original": "", "fixed": "hi", "isNew": True}])
    assert "-two" in patches.get_patch("s1")["diff"] and "+2" in patches.get_patch("s1")["diff"]
    r = patches.apply_patch("s1")
    assert r == {"ok": True, "file": "a.txt", "files": ["a.txt", "new/b.txt"]}
    assert (ws() / "a.txt").read_text() == "one\n2\n" and (ws() / "new/b.txt").read_text() == "hi"
    assert patches.apply_patch("s1")["error"] == "not_pending"
    assert patches.undo_patch("s1")["ok"]
    assert (ws() / "a.txt").read_text() == "one\ntwo\n" and not (ws() / "new").exists()


def test_nothing_is_written_if_any_file_changed_since():
    (ws() / "a.txt").write_text("one")
    (ws() / "b.txt").write_text("two")
    patches.save_patch_set("s2", "x", [{"file": "a.txt", "original": "one", "fixed": "1"}, {"file": "b.txt", "original": "two", "fixed": "2"}])
    (ws() / "b.txt").write_text("edited by hand")
    r = patches.apply_patch("s2")
    assert r["ok"] is False and r["error"] == "changed"
    assert (ws() / "a.txt").read_text() == "one"


def test_files_outside_the_workspace_are_refused(tmp_path):
    (tmp_path / "secret.txt").write_text("s")
    (ws() / "link").symlink_to(tmp_path)
    for i, rel in enumerate(["../secret.txt", "link/secret.txt", "/etc/hosts"]):
        patches.save_patch(f"o{i}", rel, "s", "pwned", "x")
        assert patches.apply_patch(f"o{i}")["error"] == "outside_workspace"
    patches.save_patch_set("o9", "x", [{"file": "link/new.txt", "original": "", "fixed": "x", "isNew": True}])
    assert patches.apply_patch("o9")["error"] == "outside_workspace"
    assert (tmp_path / "secret.txt").read_text() == "s" and not (tmp_path / "new.txt").exists()


def test_undo_refuses_when_the_file_was_edited_after():
    (ws() / "a.txt").write_text("one")
    patches.save_patch("u1", "a.txt", "one", "1", "x")
    patches.apply_patch("u1")
    (ws() / "a.txt").write_text("1 plus my edit")
    assert patches.undo_patch("u1")["error"] == "changed"


# --- approved actions ---


async def test_an_action_runs_once_and_a_failure_stays_pending(monkeypatch):
    calls = []

    async def flaky(p):
        calls.append(p)
        if len(calls) == 1:
            raise RuntimeError("Slack isn't connected any more.")
        return {"ok": True, "message": "Posted."}

    monkeypatch.setitem(actions.EXECUTORS, "slack_message", flaky)
    actions.save_action("a1", "slack_message", {"channel": "#x", "text": "hi"})
    first = await actions.execute_action("a1")
    assert first == {"ok": False, "message": "Slack isn't connected any more."} and actions.get_action("a1")["status"] == "pending"
    assert (await actions.execute_action("a1"))["ok"] and actions.get_action("a1")["status"] == "done"
    assert (await actions.execute_action("a1"))["message"] == "This action was already done."
    assert calls == [{"channel": "#x", "text": "hi"}] * 2


async def test_unknown_or_rejected_actions_never_run():
    actions.save_action("a2", "launch_rockets", {})
    assert "doesn't know how" in (await actions.execute_action("a2"))["message"]
    actions.save_action("a3", "slack_message", {})
    actions.reject_action("a3")
    assert (await actions.execute_action("a3"))["message"] == "This action was already rejected."


# --- routes ---


async def test_approving_a_code_change_writes_it_and_undo_restores(make_client):
    (ws() / "a.txt").write_text("old")
    patches.save_patch("p1", "a.txt", "old", "new", "fix")
    approval("p1")
    async with make_client() as c:
        pending = (await c.get("/api/approvals", params={"status": "pending"})).json()["approvals"]
        r = await c.post("/api/approvals/p1/decision", json={"decision": "approved"}, headers=LOCAL)
        again = await c.post("/api/approvals/p1/decision", json={"decision": "approved"}, headers=LOCAL)
        undo = await c.post("/api/approvals/p1/undo", headers=LOCAL)
    assert [a["id"] for a in pending] == ["p1"]
    assert r.status_code == 200 and r.json()["status"] == "approved" and r.json()["applied"]["files"] == ["a.txt"]
    assert again.status_code == 409 and again.json()["error"] == "already_decided"
    assert undo.json()["ok"] and (ws() / "a.txt").read_text() == "old"
    actions_logged = [r["action"] for r in store.q("SELECT action FROM audit_log ORDER BY timestamp")]
    assert actions_logged == ["apply_fix", "approval_decision", "undo_fix"]


async def test_a_failed_action_leaves_the_approval_pending(make_client, monkeypatch):
    async def fails(p):
        return {"ok": False, "message": "GitHub said: Not Found"}

    monkeypatch.setitem(actions.EXECUTORS, "github_issue", fails)
    actions.save_action("g1", "github_issue", {"repo": "a/b", "title": "t"})
    approval("g1", "InfraPilot")
    async with make_client() as c:
        r = await c.post("/api/approvals/g1/decision", json={"decision": "approved"}, headers=LOCAL)
        bad = await c.post("/api/approvals/g1/decision", json={"decision": "maybe"}, headers=LOCAL)
        denied = await c.post("/api/approvals/g1/decision", json={"decision": "denied"}, headers=LOCAL)
    assert r.status_code == 409 and r.json() == {"error": "action_failed", "message": "GitHub said: Not Found"}
    assert bad.status_code == 400
    assert denied.json()["status"] == "denied" and actions.get_action("g1")["status"] == "rejected"


async def test_connectors_never_show_tokens_and_are_verified_for_real(make_client, monkeypatch):
    async def fake_slack(token):
        if token != "xoxb-good":
            raise services.VerifyFailed("Slack said: invalid_auth")
        return "team / bot"

    monkeypatch.setitem(services.VERIFIERS, "Slack", fake_slack)
    async with make_client() as c:
        bad = await c.post("/api/connectors/Slack/connect", json={"token": "xoxb-bad"}, headers=LOCAL)
        good = await c.post("/api/connectors/Slack/connect", json={"token": "xoxb-good"}, headers=LOCAL)
        listed = (await c.get("/api/connectors")).json()["connectors"]
        drive_tok = await c.post("/api/connectors/Google Drive/connect", json={"token": "x"}, headers=LOCAL)
        gmail = await c.post("/api/connectors/Gmail/connect", json={"token": "abcd"}, headers=LOCAL)
        gone = await c.post("/api/connectors/Nope/connect", json={}, headers=LOCAL)
        off = await c.post("/api/connectors/Slack/disconnect", headers=LOCAL)
    assert bad.status_code == 400 and bad.json()["message"] == "Slack said: invalid_auth"
    assert good.json()["status"] == "connected" and good.json()["account_label"] == "team / bot"
    assert "xoxb-good" not in json.dumps(listed) and all("secret_token" not in c for c in listed)
    assert drive_tok.json()["error"] == "oauth_required" and gmail.json()["error"] == "token_required" and gone.status_code == 404
    assert off.json()["status"] == "not_connected" and store.connector_internal("Slack")["secret_token"] is None
    logged = json.dumps(store.q("SELECT parameters FROM audit_log"))
    assert "xoxb" not in logged and "[redacted]" in logged


async def test_drive_sign_in_checks_the_client_id_and_the_state(make_client):
    async with make_client() as c:
        wrong = await c.post("/api/connectors/Google Drive/oauth/start", json={"clientId": "not-a-google-client", "clientSecret": "secret", "origin": "http://localhost:8899"}, headers=LOCAL)
        ok = await c.post("/api/connectors/Google Drive/oauth/start", json={"clientId": "123-abc.apps.googleusercontent.com", "clientSecret": "secret", "origin": "http://localhost:8899"}, headers=LOCAL)
        forged = await c.get("/api/oauth/google/callback", params={"code": "c", "state": "made-up"})
    assert wrong.status_code == 400
    url = ok.json()["url"]
    assert url.startswith(drive.AUTH_URL) and "code_challenge_method=S256" in url and "secret" not in url
    assert forged.status_code == 400 and "expired" in forged.text


async def test_skills_create_change_delete(make_client):
    async with make_client() as c:
        made = await c.post("/api/skills", json={"name": "Start My Day", "instructions": "Summarise my calendar", "dailyAt": "7am"}, headers=LOCAL)
        agent = await c.post("/api/skills", json={"name": "Tutor", "kind": "agent", "instructions": "Teach Spanish"}, headers=LOCAL)
        bad_time = await c.patch("/api/skills/start_my_day", json={"dailyAt": "25:00"}, headers=LOCAL)
        moved = await c.patch("/api/skills/start_my_day", json={"dailyAt": "19:05"}, headers=LOCAL)
        no_schedule = await c.patch("/api/skills/tutor", json={"dailyAt": "8:00"}, headers=LOCAL)
        listed = (await c.get("/api/skills")).json()["skills"]
        deleted = await c.delete("/api/skills/Start My Day", headers=LOCAL)
        missing = await c.delete("/api/skills/start_my_day", headers=LOCAL)
    assert made.json()["skill"] == {"name": "start_my_day", "label": "Start My Day", "kind": "skill", "instructions": "Summarise my calendar", "dailyAt": "07:00", "lastRunDate": None, "conversationId": "routine-start_my_day"}
    assert agent.json()["skill"]["dailyAt"] is None
    assert bad_time.json()["error"] == "invalid_time" and moved.json()["skill"]["dailyAt"] == "19:05"
    assert no_schedule.status_code == 400
    assert [s["name"] for s in listed] == ["tutor", "start_my_day"]
    assert deleted.json() == {"ok": True} and missing.status_code == 404


async def test_mcp_servers_list_tools_call_them_and_get_no_keys(make_client, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "must-not-leak")
    cfg = {"name": "echo", "transport": "stdio", "command": sys.executable, "args": [ECHO]}
    tools = await mcp_servers.add(cfg)
    by_name = {t["name"]: t for t in tools}
    assert by_name["echo"]["annotations"]["readOnlyHint"] is True and not by_name["shout"]["annotations"]["readOnlyHint"]
    assert (await mcp_servers.call_tool("echo", "echo", {"text": "hi"})) == {"text": "echo: hi", "isError": False}
    assert "GROQ_API_KEY" not in mcp_servers._env()
    async with make_client() as c:
        listed = (await c.get("/api/mcp/servers")).json()["servers"]
        removed = await c.delete("/api/mcp/servers/echo", headers=LOCAL)
        again = await c.delete("/api/mcp/servers/echo", headers=LOCAL)
    assert listed[0]["name"] == "echo" and listed[0]["target"].endswith("echo_mcp.py")
    assert removed.json() == {"ok": True} and again.status_code == 404


async def test_visitors_need_a_session_from_the_right_address(make_client, monkeypatch):
    monkeypatch.setenv("OMNIPILOT_PASSWORD", "a-long-test-password")
    monkeypatch.delenv("OMNIPILOT_PUBLIC_URL", raising=False)
    visitor = {"CF-Connecting-IP": "203.0.113.5", "Host": "abc.trycloudflare.com"}
    async with make_client(owner_password_set=True) as c:
        anon = await c.get("/api/connectors", headers=visitor)
        c.cookies.set(auth.COOKIE, auth.issue_session())
        signed = await c.get("/api/connectors", headers=visitor)
        cross = await c.post("/api/skills", json={"name": "x1", "instructions": "abc"}, headers={**visitor, "Origin": "https://evil.example"})
    assert anon.status_code == 401
    assert signed.status_code == 200
    assert cross.status_code == 401 and store.q("SELECT * FROM skills") == []
