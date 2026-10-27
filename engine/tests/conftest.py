import os

os.environ["OMNIPILOT_INFISICAL"] = "0"  # before anything loads keys: tests never read the real Infisical
os.environ["OMNIPILOT_UI"] = "off"  # the NiceGUI workspace mounts once per process; route tests use the API
os.environ["OMNIPILOT_SCHEDULER"] = "off"  # routines never start on their own in tests

import json
from dataclasses import replace

import httpx
import pytest

from omnipilot_engine import config
from omnipilot_engine.app import create_app

TOKEN = "test-token-0123456789abcdef"


class FakeNode:
    """Stands in for the TypeScript engine: records what it received, answers like it."""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.down = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("refused")
        self.requests.append(request)
        # Real engine responses arrive as streams, so the fake answers with streams too.
        if request.url.path == "/api/runs/r1/events":
            body = b'data: {"type":"run_started"}\n\ndata: {"type":"final_response"}\n\n'
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=httpx.ByteStream(body))
        body = json.dumps({"ok": True, "path": request.url.path, "query": str(request.url.query, "ascii")}).encode()
        return httpx.Response(200, headers={"content-type": "application/json"}, stream=httpx.ByteStream(body))


@pytest.fixture(autouse=True)
def private_db(monkeypatch, tmp_path):
    """Every test gets its own empty database and workspace folder, never the real ones."""
    from omnipilot_engine import store

    monkeypatch.setenv("OMNIPILOT_DB_PATH", str(tmp_path / "omni.sqlite"))
    (tmp_path / "workspace").mkdir()
    monkeypatch.setenv("OMNIPILOT_WORKSPACE", str(tmp_path / "workspace"))
    monkeypatch.setenv("OMNIPILOT_CLOUD_SPEECH", "0")  # recordings never leave this computer in tests
    # No test may reach a real AI model: a dead local address and no Groq key (tests that need a model fake it).
    monkeypatch.setenv("OLLAMA_HOST", "http://127.0.0.1:9")
    monkeypatch.setenv("GROQ_API_KEY", "")
    monkeypatch.setenv("NVIDIA_API_KEY", "")
    # Nor any real tool service: every service key from the .env files is removed (tests set fake ones when needed).
    from omnipilot_engine.tools.router import PROVIDERS

    for p in PROVIDERS.values():
        for name in p.env:
            monkeypatch.delenv(name, raising=False)
    for alias in ("BROWSERUSE_API_KEY", "TRIGGER_API_KEY"):
        monkeypatch.delenv(alias, raising=False)
    # Nor this computer's sign-in settings (tests that need a password or token set their own).
    for name in ("OMNIPILOT_PASSWORD", "OMNIPILOT_API_TOKEN", "OMNIPILOT_PUBLIC_URL", "OMNIPILOT_ALLOW_ANY_HOST", "OMNIPILOT_ALLOWED_ORIGINS"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OMNIPILOT_NODE_URL", "http://127.0.0.1:9")  # agents never reach a real TypeScript engine in tests
    monkeypatch.setenv("OMNIPILOT_RUNS", "node")  # front-door tests: runs pass through to the (fake) TypeScript engine
    store.reset_for_tests()
    yield
    store.reset_for_tests()


@pytest.fixture
def node():
    return FakeNode()


@pytest.fixture
def make_client(node, tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<title>OmniPilot</title>")
    (dist / "assets" / "app.js").write_text("console.log(1)")

    def make(**overrides):
        settings = replace(config.load(), internal_token="internal-secret", api_token=None, web_dist=dist, allowed_origins=(), allow_any_host=False, owner_password_set=False)
        settings = replace(settings, **overrides)
        app = create_app(settings, transport=httpx.MockTransport(node))
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost:8899")

    return make
