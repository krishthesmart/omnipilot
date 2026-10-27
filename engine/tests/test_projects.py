"""Projects (slice 1 of docs/product): CRUD and persistence, isolation between projects, safe duplication and
cross-project copying, file safety, deletion scope, export without secrets, and project-scoped runs."""
import asyncio
import json
import os
from pathlib import Path

import pytest

from omnipilot_engine import projects, store


@pytest.fixture
def py_runs(monkeypatch):
    monkeypatch.setenv("OMNIPILOT_RUNS", "python")


async def make(c, name, **extra):
    r = await c.post("/api/projects", json={"name": name, **extra})
    assert r.status_code == 201, r.text
    return r.json()


async def test_create_edit_archive_restore_and_persist(make_client, py_runs):
    async with make_client() as c:
        p = await make(c, "Robot arm", description="Pick and place", type="science", deadline="2026-12-01",
                       constraints=["Budget under $50"], acceptance=["Arm lifts a 100 g block"])
        assert p["role"] == "owner" and p["constraints"] == ["Budget under $50"] and {k: p["counts"][k] for k in ("conversations", "files", "runs")} == {"conversations": 0, "files": 0, "runs": 0}
        r = await c.patch(f"/api/projects/{p['id']}", json={"name": "Robot arm v2", "milestones": ["Wiring done"]})
        assert r.json()["name"] == "Robot arm v2" and r.json()["milestones"] == ["Wiring done"]
        assert (await c.post(f"/api/projects/{p['id']}/archive")).json()["status"] == "archived"
        r = await c.patch(f"/api/projects/{p['id']}", json={"name": "x"})
        assert r.status_code == 409 and r.json()["error"] == "archived"  # archived projects are read-only
        assert [x["id"] for x in (await c.get("/api/projects?status=archived")).json()["projects"]] == [p["id"]]
        assert (await c.post(f"/api/projects/{p['id']}/restore")).json()["status"] == "active"
        kinds = [e["kind"] for e in (await c.get(f"/api/projects/{p['id']}/activity")).json()["activity"]]
        assert kinds == ["project_restored", "project_archived", "project_updated", "project_created"]
    store.reset_for_tests()  # a "backend restart": everything is still there
    assert projects.get(p["id"])["name"] == "Robot arm v2"


async def test_validation(make_client, py_runs):
    async with make_client() as c:
        assert (await c.post("/api/projects", json={"name": "  "})).status_code == 400
        assert (await c.post("/api/projects", json={"name": "x", "type": "spaceship"})).status_code == 400
        assert (await c.post("/api/projects", json={"name": "x", "deadline": "next week"})).status_code == 400
        assert (await c.get("/api/projects/not-a-project")).status_code == 404


async def test_projects_cannot_see_each_others_records(make_client, py_runs):
    async with make_client() as c:
        a, b = await make(c, "Alpha", constraints=["Only Python"]), await make(c, "Beta", constraints=["Only Rust"])
        fa = (await c.post(f"/api/projects/{a['id']}/files?name=alpha-secret-plan.md", content=b"zebra launch codes")).json()
        conv = (await c.post(f"/api/projects/{a['id']}/conversations", json={"title": "Alpha talk"})).json()
        # Another project's ids are simply not found from inside this project.
        assert (await c.get(f"/api/projects/{b['id']}/files/{fa['id']}")).status_code == 404
        assert (await c.delete(f"/api/projects/{b['id']}/files/{fa['id']}")).status_code == 404
        assert (await c.get(f"/api/projects/{b['id']}/conversations/{conv['id']}")).status_code == 404
        assert (await c.post(f"/api/projects/{b['id']}/conversations/{conv['id']}/messages", json={"message": "hi"})).status_code == 404
        # Search is scoped to the project.
        assert (await c.get(f"/api/projects/{b['id']}/search?q=zebra")).json()["results"] == []
        assert any(h["kind"] == "file" for h in (await c.get(f"/api/projects/{a['id']}/search?q=zebra")).json()["results"])
        assert (await c.get(f"/api/projects/{b['id']}")).json()["constraints"] == ["Only Rust"]
        # Project files are hidden from the workspace-wide file index.
        from omnipilot_engine.brain.files import workspace_index

        assert not any("alpha-secret" in f for f in workspace_index(os.environ["OMNIPILOT_WORKSPACE"]).files)


async def test_another_device_and_sdk_tokens_get_no_project_access(make_client, py_runs):
    async with make_client(api_token="sdk-token-0123456789abcdef") as c:
        assert (await c.get("/api/projects", headers={"x-forwarded-for": "8.8.8.8"})).status_code == 401
        assert (await c.get("/api/projects", headers={"authorization": "Bearer sdk-token-0123456789abcdef"})).status_code == 403


def test_roles_are_enforced_in_the_backend():
    p = projects.create({"name": "Shared"})
    store.x("INSERT INTO project_members (project_id, member, role, added_at) VALUES (?, 'guest', 'viewer', ?)", p["id"], store.now())
    assert projects.require(p["id"], "read", actor="guest")["name"] == "Shared"
    with pytest.raises(projects.ProjectError) as e:
        projects.update(p["id"], {"name": "Hacked"}, actor="guest")
    assert e.value.status == 403
    with pytest.raises(projects.ProjectError) as e:
        projects.get(p["id"], actor="stranger")
    assert e.value.status == 404


async def test_file_safety(make_client, py_runs):
    async with make_client() as c:
        p = await make(c, "Files")
        up = lambda name, data=b"x": c.post(f"/api/projects/{p['id']}/files", params={"name": name}, content=data)
        for bad in ("../escape.txt", "a/b.txt", ".env", "run.exe", "", "con\0.txt"):
            assert (await up(bad)).status_code == 400, bad
        assert (await up("ok.txt", b"")).status_code == 400
        assert (await up("big.bin", b"x" * (projects.MAX_FILE_BYTES + 1))).status_code == 413
        f = (await up("notes.md", b"# hello")).json()
        assert f["sha256"] and f["size"] == 7
        assert (await up("notes.md")).status_code == 409  # no silent overwrite
        r = await c.get(f"/api/projects/{p['id']}/files/{f['id']}")
        assert r.content == b"# hello" and "attachment" in r.headers["content-disposition"] and r.headers["content-type"] == "application/octet-stream"
        assert (await c.delete(f"/api/projects/{p['id']}/files/{f['id']}")).json()["deleted"]


async def test_duplicate_copies_settings_and_files_but_no_history_or_grants(make_client, py_runs):
    async with make_client() as c:
        p = await make(c, "Original", requirements=["Works offline"])
        await c.post(f"/api/projects/{p['id']}/files?name=a.txt", content=b"A")
        await c.post(f"/api/projects/{p['id']}/conversations", json={"title": "Old talk"})
        prev = (await c.get(f"/api/projects/{p['id']}/duplicate-preview")).json()
        assert "approvals and approval grants" in prev["does_not_copy"] and "connections, credentials or tokens" in prev["does_not_copy"]
        d = (await c.post(f"/api/projects/{p['id']}/duplicate", json={"includeFiles": True})).json()
        assert d["name"] == "Original (copy)" and d["requirements"] == ["Works offline"]
        assert {k: d["counts"][k] for k in ("conversations", "files", "runs")} == {"conversations": 0, "files": 1, "runs": 0}


async def test_copying_a_file_to_another_project_needs_preview_and_confirmation(make_client, py_runs):
    async with make_client() as c:
        a, b = await make(c, "A"), await make(c, "B")
        f = (await c.post(f"/api/projects/{a['id']}/files?name=data.csv", content=b"1,2")).json()
        prev = (await c.get(f"/api/projects/{a['id']}/files/{f['id']}/copy-preview", params={"to": b["id"]})).json()
        assert prev["to"] == "B" and prev["conflict"] is False
        assert (await c.post(f"/api/projects/{a['id']}/files/{f['id']}/copy", json={"to": b["id"]})).status_code == 400  # not confirmed
        assert (await c.post(f"/api/projects/{a['id']}/files/{f['id']}/copy", json={"to": b["id"], "confirm": True})).status_code == 201
        assert [x["name"] for x in (await c.get(f"/api/projects/{b['id']}/files")).json()["files"]] == ["data.csv"]


async def test_delete_explains_scope_and_needs_the_exact_name(make_client, py_runs):
    async with make_client() as c:
        p = await make(c, "Doomed")
        await c.post(f"/api/projects/{p['id']}/files?name=x.txt", content=b"x")
        prev = (await c.get(f"/api/projects/{p['id']}/delete-preview")).json()
        assert prev["removes"]["files"] == 1 and prev["irreversible"] and prev["confirm_with"] == "Doomed"
        r = await c.request("DELETE", f"/api/projects/{p['id']}", json={"confirm": "doomed"})
        assert r.status_code == 400
        r = await c.request("DELETE", f"/api/projects/{p['id']}", json={"confirm": "Doomed"})
        assert r.json()["deleted"]
        assert (await c.get(f"/api/projects/{p['id']}")).status_code == 404
        assert not projects.files_dir(p["id"]).exists()


async def test_export_never_contains_secrets(make_client, py_runs, monkeypatch):
    monkeypatch.setenv("FAKE_SERVICE_API_KEY", "sk-test-THIS-MUST-NOT-LEAK-123")
    async with make_client() as c:
        p = await make(c, "Exported", description="uses key sk-test-THIS-MUST-NOT-LEAK-123 somewhere")
        r = await c.get(f"/api/projects/{p['id']}/export")
        assert "attachment" in r.headers["content-disposition"]
        assert "THIS-MUST-NOT-LEAK" not in r.text and "[redacted]" in r.text
        data = json.loads(r.text)
        assert data["format"] == "omnipilot.project-export/1" and "credentials, tokens and keys" in data["excluded"]


async def test_a_project_run_is_recorded_in_the_project_and_its_agents_see_only_its_files(make_client, py_runs, monkeypatch):
    seen = {}

    async def fake_agent(name, input, ctx):  # stands in for the agents (no model in tests)
        seen["root"], seen["project"] = ctx.get("workspace_root"), (input.get("context") or {}).get("project")
        return {"status": "success", "findings": ["Answered inside the project."], "evidence": [], "confidence": 0.9, "limitations": [], "proposedActions": []}

    from omnipilot_engine.brain import agents

    monkeypatch.setattr(agents, "run", fake_agent)
    async with make_client() as c:
        a, b = await make(c, "Alpha", constraints=["Only Python"]), await make(c, "Beta")
        conv = (await c.post(f"/api/projects/{a['id']}/conversations", json={"title": "Q"})).json()
        run_id = (await c.post(f"/api/projects/{a['id']}/conversations/{conv['id']}/messages", json={"message": "What is 2 plus 2?"})).json()["runId"]
        for _ in range(100):
            run = store.get_run(run_id)
            if run and run["status"] not in ("running",):
                break
            await asyncio.sleep(0.05)
        assert run["project_id"] == a["id"]
        assert Path(seen["root"]) == projects.files_dir(a["id"]) and seen["project"]["constraints"] == ["Only Python"]
        turns = (await c.get(f"/api/projects/{a['id']}/conversations/{conv['id']}")).json()["turns"]
        assert [t["runId"] for t in turns] == [run_id]
        assert [r["id"] for r in (await c.get(f"/api/projects/{a['id']}/runs")).json()["runs"]] == [run_id]
        assert (await c.get(f"/api/projects/{b['id']}/runs")).json()["runs"] == []


def test_a_change_inside_a_project_is_saved_relative_to_the_workspace(tmp_path):
    from omnipilot_engine import patches

    p = projects.create({"name": "Code"})
    root = str(projects.files_dir(p["id"]))
    assert patches.to_workspace_rel(root, "src/app.js") == f".omnipilot-projects/{p['id']}/src/app.js"
    with pytest.raises(ValueError):
        patches.to_workspace_rel(root, "../../../../etc/passwd")


def test_home_reports_recorded_state_only():
    p = projects.create({"name": "Fresh"})
    h = projects.home()
    assert [x["id"] for x in h["projects"]] == [p["id"]]
    assert h["blocked"] == [] and h["pending_approvals"] == []
    assert any("acceptance criteria" in s["text"] for s in h["suggestions"])  # derived from the empty field, not invented


async def test_upload_size_limits_fit_each_endpoint(make_client, py_runs):
    """Project files and document attachments may be larger than ordinary requests; everything else keeps 256 KB."""
    async with make_client() as c:
        p = await make(c, "Big files")
        r = await c.post(f"/api/projects/{p['id']}/files", params={"name": "scan.pdf"}, content=b"%PDF" + b"\0" * (2 * 1024 * 1024))
        assert r.status_code == 201
        r = await c.post("/api/attachments/parse", params={"name": "big.pdf"}, content=b"%PDF" + b"\0" * (1024 * 1024))
        assert r.status_code != 413  # (not a real PDF, so it may fail to parse, but not for its size)
        assert (await c.post("/api/projects", content=b"{" + b" " * (300 * 1024) + b"}", headers={"content-type": "application/json"})).status_code == 413
