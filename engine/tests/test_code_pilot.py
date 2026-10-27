"""CodePilot in Python: the snippet sandbox, the project checker, E2B commands (with a fake SDK, never the real
service), code alerts, the project builder's helpers, the generate -> test -> repair loop (with a fake model)
and the /api/code routes."""
import os
from pathlib import Path

import pytest

from omnipilot_engine import llm, patches, store
from omnipilot_engine.brain import cloud_run, code_watch, sandbox
from omnipilot_engine.brain.agents import code_pilot, project_builder, run_command
from omnipilot_engine.brain.project_check import check_project, describe_check, test_run_refusal as run_refusal

FENCE = "```"


def ws() -> Path:
    return Path(os.environ["OMNIPILOT_WORKSPACE"])


# --- the snippet sandbox ---


async def test_sandbox_runs_python_with_tests_and_an_empty_environment(monkeypatch):
    monkeypatch.setenv("SECRET_THING", "do-not-leak")
    code = "def add(a, b):\n    return a + b\n\nif __name__ == '__main__':\n    raise SystemExit(1)\n"
    r = await sandbox.run_tests("python", code, ["add(2, 3) == 5", "add(-1, 1) == 0", "add(1, 1) == 3"])
    assert r["ran"] and r["passed"] == 2 and len(r["failures"]) == 1 and "add(1, 1) == 3" in r["failures"][0]
    leaked = await sandbox.run_sandboxed("python", "import json\nprint(len(__import__('os').environ))")
    assert "do-not-leak" not in leaked["output"]


async def test_sandbox_refuses_risky_code_and_stops_infinite_loops():
    assert sandbox.refusal_reason("python", "import os\nos.remove('x')").startswith("uses `import os`")
    assert sandbox.refusal_reason("javascript", "require('fs')")
    assert sandbox.refusal_reason("python", "def f():\n    return 1") is None
    r = await sandbox.run_sandboxed("python", "while True:\n    pass", timeout_s=1)
    assert not r["ok"] and "Timed out after 1s" in r["output"]
    assert sandbox.language("", "write it in node.js") == "javascript" and sandbox.language("go", "") is None


@pytest.mark.skipif(not sandbox.node_cmd(), reason="Node.js isn't installed")
async def test_sandbox_runs_javascript():
    r = await sandbox.run_tests("javascript", "export function sq(x) { return x * x }", ["sq(3) === 9", "sq(2) === 5"])
    assert r["ran"] and r["passed"] == 1


# --- the project checker ---


async def test_project_check_finds_syntax_errors_and_mismatched_imports():
    files = [
        {"path": "todo/__init__.py", "content": ""},
        {"path": "todo/core.py", "content": "def add(items, x):\n    return items + [x]\n"},
        {"path": "main.py", "content": "from todo.core import add, remove\nimport requests\n"},
        {"path": "broken.py", "content": "def f(:\n"},
        {"path": "data.json", "content": "{bad"},
        {"path": "index.html", "content": '<script src="app.js"></script><link href="style.css">'},
    ]
    r = await check_project(files, run_tests=False)
    messages = " | ".join(p["message"] for p in r["problems"])
    assert "Imports remove from todo/core.py, but todo/core.py doesn't define remove." in messages
    assert "Syntax error" in messages and "Invalid JSON" in messages
    assert 'Links to "app.js"' in messages and 'Links to "style.css"' in messages


async def test_project_check_runs_the_projects_own_tests_locally():
    files = [
        {"path": "calc/__init__.py", "content": ""},
        {"path": "calc/ops.py", "content": "def add(a, b):\n    return a + b\n"},
        {"path": "tests/test_ops.py", "content": "import unittest\nfrom calc.ops import add\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 2), 4)\n    def test_bad(self):\n        self.assertEqual(add(1, 1), 3)\n"},
    ]
    r = await check_project(files)
    assert r["problems"] == [] and r["tests"]["ran"] and r["tests"]["via"] == "local"
    assert (r["tests"]["passed"], r["tests"]["failed"]) == (1, 1)
    assert "❌ Tests: 1 passed, 1 failed (in a sandbox)." in describe_check(r)


async def test_tests_that_delete_files_are_not_run_here_without_e2b():
    files = [{"path": "a.py", "content": "import os\nos.remove('x')\n"}, {"path": "test_a.py", "content": "import unittest\n"}]
    assert "a.py uses `os.remove`" in run_refusal(files)
    r = await check_project(files)
    assert not r["tests"]["ran"] and "with an E2B key" in r["tests"]["why"]


# --- E2B (a fake SDK) ---


class FakeSandbox:
    made: list["FakeSandbox"] = []

    def __init__(self):
        self.written, self.ran, self.killed = {}, [], False
        outer = self

        class Files:
            async def write(self, path, data):
                outer.written[path] = data

        class Result:
            def __init__(self, out):
                self.exit_code, self.stdout, self.stderr = 0, out, ""

        class Commands:
            async def run(self, cmd, cwd=None, timeout=None):
                outer.ran.append(cmd)
                if cmd.startswith("false"):
                    err = RuntimeError("exit status 1")
                    err.exit_code, err.stdout, err.stderr = 1, "", "boom"
                    raise err
                return Result(f"ran {cmd}")

        self.files, self.commands = Files(), Commands()

    @classmethod
    async def create(cls, api_key=None, timeout=None):
        assert api_key == "e2b-test-key" and timeout <= 900
        sbx = cls()
        cls.made.append(sbx)
        return sbx

    async def kill(self):
        self.killed = True


@pytest.fixture
def fake_e2b(monkeypatch):
    monkeypatch.setenv("E2B_API_KEY", "e2b-test-key")
    FakeSandbox.made = []
    cloud_run.set_sdk(FakeSandbox)
    yield FakeSandbox
    cloud_run.set_sdk(None)


async def test_e2b_runs_commands_logs_them_and_always_shuts_down(fake_e2b):
    runs = await cloud_run.run_in_sandbox(files=[{"path": "a.py", "content": "x=1"}], commands=["echo hi", "false", "echo after"], stop_on_failure=True, run_id="r1", why="test")
    assert [r["exitCode"] for r in runs] == [0, 1] and runs[1]["stderr"] == "boom"
    sbx = fake_e2b.made[0]
    assert sbx.killed and sbx.written == {f"{cloud_run.PROJECT_DIR}/a.py": "x=1"}
    assert [r["action"] for r in store.q("SELECT action FROM audit_log WHERE run_id = 'r1'")] == ["e2b_command", "e2b_command"]


def test_install_and_test_commands_and_counts():
    files = [{"path": "requirements.txt", "content": "pytest\n"}, {"path": "tests/test_x.py", "content": "import pytest"}, {"path": "package.json", "content": '{"scripts":{"test":"vitest"},"devDependencies":{"vitest":"1"}}'}]
    assert cloud_run.install_commands(files) == ["pip install --quiet -r requirements.txt", "npm install --silent --no-audit --no-fund"]
    assert cloud_run.test_commands(files) == ["npm test", "python -m pytest -q"]
    assert cloud_run.count_tests("# pass 3\n# fail 1\n") == {"passed": 3, "failed": 1}
    assert cloud_run.count_tests("5 passed, 2 failed in 0.1s") == {"passed": 5, "failed": 2}


async def test_shell_commands_run_only_in_e2b(fake_e2b):
    r = await run_command.run_command_skill({"runId": "r2", "requestText": "run `ls -la` please", "context": {}}, {})
    assert r["status"] == "success" and "Ran `ls -la` in an E2B cloud sandbox" in r["findings"][0] and "ran ls -la" in r["findings"][1]
    assert fake_e2b.made[0].ran[-1] == "ls -la" and fake_e2b.made[0].killed


async def test_without_e2b_commands_are_refused():
    r = await run_command.run_command_skill({"runId": "r3", "requestText": "run `rm -rf /`", "context": {}}, {})
    assert r["status"] == "partial_success" and "I don't run shell commands on your computer" in r["findings"][0]


async def test_run_the_tests_in_a_workspace_project():
    proj = ws() / "flashcards"
    (proj / "cards").mkdir(parents=True)
    (proj / "README.md").write_text("# Flashcards\nA flashcard app.\n")
    (proj / "cards" / "__init__.py").write_text("")
    (proj / "cards" / "deck.py").write_text("def size(d):\n    return len(d)\n")
    (proj / "tests").mkdir()
    (proj / "tests" / "test_deck.py").write_text("import unittest\nfrom cards.deck import size\n\nclass T(unittest.TestCase):\n    def test_size(self):\n        self.assertEqual(size([1, 2]), 2)\n")
    r = await code_pilot.run({"runId": "r4", "requestText": "run the tests in my flashcards project", "context": {}}, {})
    assert r["status"] == "success" and "✅ Tests: all 1 passed" in r["findings"][0]


# --- code alerts ---


def test_code_alerts_record_quietly_then_alert_on_new_issues():
    code = ws() / "code"
    code.mkdir()
    (code / "a.js").write_text("eval(x)\n")
    assert code_watch.scan_all(str(ws()), quiet=True)["issues"] == 1 and code_watch.pending_alerts() == []
    (code / "a.js").write_text("eval(x)\nconst password = 'supersecret123'\n")
    fresh = code_watch.rescan_file(str(ws()), "code/a.js")
    assert [a["title"] for a in fresh] == ["Hardcoded credential-looking literal"]
    assert len(code_watch.pending_alerts()) == 1
    code_watch.set_alert_level("critical")
    assert code_watch.pending_alerts() == []  # a "high" issue is below the level
    code_watch.set_alert_level("medium")
    code_watch.mark_alerts_seen()
    assert code_watch.pending_alerts() == []
    (code / "a.js").write_text("ok()\n")
    assert code_watch.scan_all(str(ws()))["issues"] == 0


# --- the project builder's helpers ---


def test_builder_parses_blocks_applies_edits_and_orders_files():
    reply = "Here:\n~~~~file ./app/main.py\n```python\nprint(1)\n```\n~~~~\n~~~~edit app/util.py\n<<<<<<< FIND\na = 1\n=======\na = 2\n>>>>>>> REPLACE\n~~~~\n"
    blocks = project_builder.parse_blocks(reply)
    assert blocks[0] == {"kind": "file", "path": "app/main.py", "body": "print(1)"} and blocks[1]["kind"] == "edit"
    assert project_builder.apply_edits("a = 1\nb = 1\n", blocks[1]["body"]) == {"text": "a = 2\nb = 1\n", "failed": []}
    assert project_builder.apply_edits("x\nx\n", "<<<<<<< FIND\nx\n=======\ny\n>>>>>>> REPLACE")["failed"] == ["x"]
    assert project_builder.safe_rel("../etc/passwd") is None and project_builder.safe_rel(".env") is None and project_builder.safe_rel("src/a.py") == "src/a.py"
    order = project_builder.write_order([{"path": "main.py", "uses": ["lib.py"]}, {"path": "lib.py", "uses": []}])
    assert [[f["path"] for f in level] for level in order] == [["lib.py"], ["main.py"]]
    assert project_builder.extract_file("```js\nlet a\n```", "a.js") == "let a"


def test_web_preview_inlines_local_css_and_scripts():
    files = [{"path": "index.html", "content": '<link rel="stylesheet" href="style.css"><script src="game.js"></script>'},
             {"path": "style.css", "content": "body{}"}, {"path": "game.js", "content": "var s = '</script>';"}]
    html = project_builder.inline_web_preview(files)
    assert "<style>\nbody{}\n</style>" in html and "<\\/script>" in html and 'src="game.js"' not in html


# --- writing code: generate -> test -> repair (a fake model) ---


async def test_generated_code_is_tested_and_repaired(monkeypatch):
    buggy = f"{FENCE}python\ndef double(x):\n    return x + 2\n{FENCE}\nDoubles a number."
    fixed = f"{FENCE}python\ndef double(x):\n    return x * 2\n{FENCE}"

    async def fake_text(system, user, **kw):
        return fixed if "fixing your own code" in system else buggy

    async def fake_json(system, user, **kw):
        return {"tests": ["double(2) == 4", "double(0) == 0", "double(5) == 10"]}

    monkeypatch.setattr(llm, "generate_text", fake_text)
    monkeypatch.setattr(llm, "generate_json", fake_json)
    r = await code_pilot.run({"runId": "r5", "requestText": "write a python function that doubles a number", "context": {}}, {})
    assert r["status"] == "success" and "return x * 2" in r["findings"][0] and "Doubles a number." in r["findings"][0]
    assert r["findings"][1].startswith("Verified: ran 3 tests") and "after 1 repair" in r["findings"][1]
    assert r["confidence"] == 0.8


async def test_a_security_fix_is_offered_as_a_diff(monkeypatch):
    code = ws() / "code"
    code.mkdir()
    (code / "db.js").write_text('const q = "SELECT * FROM t WHERE id = " + id;\ndb.query(q);\n')

    async def fake_json(system, user, **kw):
        return {"summary": "Used a parameterized query.", "code": 'const q = "SELECT * FROM t WHERE id = ?";\ndb.query(q, [id]);\n'}

    monkeypatch.setattr(llm, "generate_json", fake_json)
    r = await code_pilot.run({"runId": "r6", "requestText": "scan my code", "context": {}}, {})
    fix = r["proposedActions"][0]
    assert fix["description"].startswith("Apply CodePilot's fix to code/db.js") and fix["riskLevel"] == "high" and "+db.query(q, [id]);" in fix["preview"]
    assert patches.get_patch(fix["id"])["file"] == "code/db.js"


# --- routes ---


async def test_code_routes(make_client, monkeypatch):
    monkeypatch.setenv("OMNIPILOT_RUNS", "python")
    async with make_client() as c:
        r = await c.post("/api/code/scan-text", json={"file": "a.py", "content": "x = eval(y)"})
        assert r.json()["findings"][0]["rule"] == "eval-usage"
        assert (await c.get("/api/code/alerts")).json() == {"level": "medium", "alerts": []}
        assert (await c.post("/api/code/scan")).json()["files"] == 0
        r = await c.post("/api/code/assist", json={"mode": "fix", "code": "x"})
        assert r.status_code == 503 and r.json()["error"] == "ai_unavailable"
        assert (await c.post("/api/code/assist", json={"mode": "nope", "code": "x"})).status_code == 400


@pytest.mark.skipif(not sandbox.os_sandbox_available(), reason="no OS sandbox on this system")
async def test_model_written_code_runs_inside_the_os_sandbox(tmp_path):
    """The pattern filter can be bypassed, so the OS sandbox is the real boundary: no network, no reading the home
    folder, no writing outside the throwaway folder, no starting other programs."""
    secret = Path(os.path.expanduser("~")) / ".omnipilot-sandbox-test"
    secret.write_text("not for model code")
    try:
        probes = {
            "read": f"try:\n    open({str(secret)!r}).read(); print('ALLOWED')\nexcept Exception: print('blocked')",
            "write": f"try:\n    open({str(secret) + '-w'!r}, 'w').write('x'); print('ALLOWED')\nexcept Exception: print('blocked')",
            "network": "import socket\ntry:\n    socket.create_connection(('127.0.0.1', 9), timeout=2); print('ALLOWED')\nexcept PermissionError: print('blocked')\nexcept Exception: print('blocked')",
            "program": "import subprocess\ntry:\n    subprocess.run(['/bin/echo', 'x'], check=True); print('ALLOWED')\nexcept Exception: print('blocked')",
        }
        for name, code in probes.items():
            out = (await sandbox.run_sandboxed("python", code))["output"]
            assert "blocked" in out and "ALLOWED" not in out, (name, out)
        assert (await sandbox.run_sandboxed("python", "open('ok.txt', 'w').write('fine'); print('wrote')"))["output"] == "wrote"
    finally:
        secret.unlink(missing_ok=True)
        Path(str(secret) + "-w").unlink(missing_ok=True)


def test_a_key_left_as_a_fallback_is_still_a_hardcoded_secret():
    """Found with argent: a fix kept the key as `process.env.API_KEY || "sk-..."` and was reported as resolving it."""
    flagged = lambda line: any(f["rule"]["id"] == "hardcoded-secret" for f in code_pilot.scan_source("x", line))
    assert flagged('const apiKey = process.env.API_KEY || "sk-live-51Hh2x9FAKE";')
    assert flagged('api_key = os.environ.get("API_KEY") or "sk-live-51Hh2x9FAKE"')
    assert flagged('key = os.getenv("OPENAI_API_KEY", "sk-live-51Hh2x9FAKE")')
    assert not flagged("const apiKey = process.env.API_KEY;") and not flagged('token = os.getenv("GITHUB_TOKEN_NAME")')


def test_long_text_is_shortened_at_a_word():
    from omnipilot_engine.brain.text import clip

    assert clip("using parameterized queries, argument arrays, input escaping, environment variables", 70) == "using parameterized queries, argument arrays, input escaping…"
    assert clip("short", 10) == "short"


def test_a_folder_that_only_holds_projects_is_not_a_project():
    from omnipilot_engine.brain.files import FileIndex

    (ws() / "projects" / "game").mkdir(parents=True)
    (ws() / "projects" / "game" / "README.md").write_text("# Game\nA small game.\n\n---\n\nMore.\n")
    (ws() / "projects" / "game" / "main.js").write_text("x()\n")
    idx = FileIndex(str(ws()))
    idx.refresh()
    assert [p.folder for p in idx.projects] == ["projects/game"] and idx.projects[0].description == "A small game. More."
