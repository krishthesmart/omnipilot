"""E2B remote execution: one fixed smoke test, bounded, always cleaned up, always logged.
E2B itself is faked here (no network, no key, no cost); see README for the live check."""
import asyncio

import pytest

from omnipilot_engine import remote_exec
from conftest import TOKEN


class FakeResult:
    def __init__(self, stdout="", stderr="", exit_code=0):
        self.stdout, self.stderr, self.exit_code = stdout, stderr, exit_code


class CommandExitException(Exception):
    def __init__(self):
        super().__init__("exit status 1")
        self.exit_code, self.stderr = 1, "boom"


class TimeoutException(Exception):
    pass


class FakeSandbox:
    def __init__(self, result=None, run_error=None, kill_error=None):
        self.result, self.run_error, self.kill_error = result or FakeResult("OmniPilot E2B smoke test: hello from the sandbox\n"), run_error, kill_error
        self.runs, self.killed = [], False
        self.commands = self

    async def run(self, cmd, **kwargs):
        self.runs.append((cmd, kwargs))
        if self.run_error:
            raise self.run_error
        return self.result

    async def kill(self, **kwargs):
        if self.kill_error:
            raise self.kill_error
        self.killed = True
        return True


def factory_for(sandbox, error=None):
    calls = []

    async def factory(**kwargs):
        calls.append(kwargs)
        if error:
            raise error
        return sandbox

    factory.calls = calls
    return factory


@pytest.fixture
def log():
    entries = []

    async def audit(action, outcome, params):
        entries.append((action, outcome, params))

    audit.entries = entries
    return audit


@pytest.fixture
def key(monkeypatch):
    monkeypatch.setenv("E2B_API_KEY", "e2b_test_key_not_real")


async def test_runs_the_fixed_command_in_a_locked_down_sandbox(key, log):
    sandbox = FakeSandbox()
    factory = factory_for(sandbox)
    result = await remote_exec.run_smoke_test(log, factory)
    assert result["ok"] and "hello from the sandbox" in result["output"] and result["exitCode"] == 0
    created = factory.calls[0]
    assert created["allow_internet_access"] is False and created["timeout"] == remote_exec.SANDBOX_LIFETIME_S
    assert "template" not in created  # a fresh default sandbox, never a fixed sandbox ID
    cmd, kwargs = sandbox.runs[0]
    assert cmd == remote_exec.SMOKE_COMMAND and kwargs["envs"] == {} and kwargs["timeout"] == remote_exec.COMMAND_TIMEOUT_S
    assert sandbox.killed
    assert [o for _, o, _ in log.entries] == ["started", "success", "cleanup: sandbox terminated"]
    assert "e2b_test_key_not_real" not in repr(log.entries) + repr(result)  # the key never leaves the environment


async def test_bounds_the_output(key, log):
    sandbox = FakeSandbox(FakeResult("x" * 50_000))
    result = await remote_exec.run_smoke_test(log, factory_for(sandbox))
    assert len(result["output"]) < remote_exec.MAX_OUTPUT_CHARS + 100 and "output cut" in result["output"]


async def test_a_failing_command_is_reported_and_still_cleaned_up(key, log):
    sandbox = FakeSandbox(run_error=CommandExitException())
    result = await remote_exec.run_smoke_test(log, factory_for(sandbox))
    assert result == {"ok": False, "error": "exit", "message": remote_exec._failure("exit"), "exitCode": 1, "stderr": "boom"}
    assert sandbox.killed
    assert [o for _, o, _ in log.entries] == ["started", "failed: exit", "cleanup: sandbox terminated"]


async def test_a_timeout_is_reported_and_still_cleaned_up(key, log):
    sandbox = FakeSandbox(run_error=TimeoutException())
    result = await remote_exec.run_smoke_test(log, factory_for(sandbox))
    assert result["error"] == "timeout" and sandbox.killed


async def test_no_sandbox_means_nothing_to_clean_up(key, log):
    result = await remote_exec.run_smoke_test(log, factory_for(None, error=type("AuthenticationException", (Exception,), {})()))
    assert result["error"] == "auth"
    assert [o for _, o, _ in log.entries] == ["started", "failed: auth"]


async def test_a_failed_cleanup_is_logged_not_raised(key, log):
    sandbox = FakeSandbox(kill_error=RuntimeError("network down"))
    result = await remote_exec.run_smoke_test(log, factory_for(sandbox))
    assert result["ok"]
    assert log.entries[-1][1].startswith("cleanup failed (RuntimeError)")


async def test_does_nothing_without_a_key(monkeypatch, log):
    monkeypatch.delenv("E2B_API_KEY", raising=False)
    factory = factory_for(FakeSandbox())
    result = await remote_exec.run_smoke_test(log, factory)
    assert result["error"] == "not_configured" and factory.calls == []


async def test_one_smoke_test_at_a_time(key, log):
    gate = asyncio.Event()

    class SlowSandbox(FakeSandbox):
        async def run(self, cmd, **kwargs):
            await gate.wait()
            return self.result

    first = asyncio.create_task(remote_exec.run_smoke_test(log, factory_for(SlowSandbox())))
    await asyncio.sleep(0.01)
    assert (await remote_exec.run_smoke_test(log, factory_for(FakeSandbox())))["error"] == "busy"
    gate.set()
    assert (await first)["ok"]


# --- Through the front door ---

async def test_endpoint_is_local_only_and_logs_to_the_activity_log(key, make_client, node, monkeypatch):
    import httpx
    from dataclasses import replace
    from omnipilot_engine import config
    from omnipilot_engine.app import create_app

    sandbox = FakeSandbox()
    settings = replace(config.load(), internal_token="internal-secret", api_token=TOKEN, allowed_origins=(), allow_any_host=False)
    app = create_app(settings, transport=httpx.MockTransport(node), e2b_factory=factory_for(sandbox))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost:8899") as c:
        assert (await c.get("/api/remote/e2b/status")).json()["configured"] is True
        r = await c.post("/api/remote/e2b/smoke-test")
        assert r.status_code == 200 and r.json()["ok"]
        # Not for SDK tokens, and never from another website.
        assert (await c.post("/api/remote/e2b/smoke-test", headers={"authorization": f"Bearer {TOKEN}"})).status_code == 403
        assert (await c.post("/api/remote/e2b/smoke-test", headers={"origin": "https://evil.example"})).status_code == 403
    audit_calls = [req for req in node.requests if req.url.path == "/api/internal/audit"]
    assert len(audit_calls) == 3 and all(req.headers["x-omnipilot-internal"] == "internal-secret" for req in audit_calls)


async def test_clients_cannot_reach_internal_endpoints(make_client, node):
    async with make_client() as c:
        for path in ["/api/internal/audit", "/api/./internal/audit", "/api//internal/audit", "/api/x/../internal/audit", "/api/INTERNAL/audit", "/api/internal%2Faudit"]:
            assert (await c.post(path, json={"agent": "x", "action": "y", "outcome": "z"})).status_code == 404, path
    assert not any("internal" in req.url.path.lower() for req in node.requests)
