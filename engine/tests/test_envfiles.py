"""Where keys come from: the environment, then Infisical (via its CLI), then server/.env and .env. A fake
`infisical` command stands in for the real one; values are never printed."""
import json
import os
import stat

import pytest

from omnipilot_engine import envfiles


@pytest.fixture
def fresh(monkeypatch, tmp_path):
    root = tmp_path / "repo"
    (root / "server").mkdir(parents=True)
    (root / ".infisical.json").write_text(json.dumps({"workspaceId": "proj-1", "defaultEnvironment": "dev"}))
    monkeypatch.setattr(envfiles, "ROOT", root)
    monkeypatch.setattr(envfiles, "_infisical_done", False)
    monkeypatch.setattr(envfiles, "_sources", {})
    monkeypatch.delenv("OMNIPILOT_INFISICAL", raising=False)
    monkeypatch.delenv("OMNIPILOT_INFISICAL_LOADED", raising=False)
    for k in ("TEST_A_KEY", "TEST_B_KEY", "TEST_C_KEY", "YDC_API_KEY", "YOU.COM_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    return root


def fake_cli(monkeypatch, tmp_path, secrets, exit_code=0):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    cli = bin_dir / "infisical"
    log = tmp_path / "cli-args.txt"
    cli.write_text(f"#!/bin/sh\necho \"$@\" > {log}\necho '{json.dumps(secrets)}'\nexit {exit_code}\n")
    cli.chmod(cli.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ['PATH']}")
    return log


def test_infisical_comes_before_the_env_files_and_after_the_environment(fresh, monkeypatch, tmp_path):
    log = fake_cli(monkeypatch, tmp_path, [{"key": "TEST_A_KEY", "value": "from-infisical"}, {"key": "TEST_B_KEY", "value": "from-infisical"}, {"key": "YOU.COM_API_KEY", "value": "ydc"}])
    (fresh / "server" / ".env").write_text("TEST_A_KEY=from-file\nTEST_C_KEY=from-file\n")
    monkeypatch.setenv("TEST_B_KEY", "from-shell")
    envfiles.load((fresh / "server" / ".env",))  # explicit files: no Infisical
    assert os.environ["TEST_A_KEY"] == "from-file"
    monkeypatch.delenv("TEST_A_KEY")
    monkeypatch.delenv("TEST_C_KEY")
    monkeypatch.setattr(envfiles, "FILES", (fresh / "server" / ".env",))
    envfiles.load(envfiles.FILES)
    assert os.environ["TEST_A_KEY"] == "from-infisical" and envfiles.source("TEST_A_KEY") == "infisical"
    assert os.environ["TEST_B_KEY"] == "from-shell" and envfiles.source("TEST_B_KEY") == "environment"
    assert os.environ["TEST_C_KEY"] == "from-file" and envfiles.source("TEST_C_KEY") == "server/.env"
    assert os.environ["YDC_API_KEY"] == "ydc", "You.com's dotted name is mapped to the one the code reads"
    assert "--projectId proj-1 --env dev --format json" in log.read_text()


def test_infisical_is_read_once_and_can_be_turned_off(fresh, monkeypatch, tmp_path):
    log = fake_cli(monkeypatch, tmp_path, [{"key": "TEST_A_KEY", "value": "x"}])
    monkeypatch.setenv("OMNIPILOT_INFISICAL", "0")
    monkeypatch.setattr(envfiles, "FILES", ())
    envfiles.load(envfiles.FILES)
    assert not log.exists() and "TEST_A_KEY" not in os.environ


def test_a_failed_infisical_read_falls_back_to_the_files(fresh, monkeypatch, tmp_path):
    fake_cli(monkeypatch, tmp_path, [], exit_code=1)
    (fresh / "server" / ".env").write_text("TEST_A_KEY=from-file\n")
    monkeypatch.setattr(envfiles, "FILES", (fresh / "server" / ".env",))
    envfiles.load(envfiles.FILES)
    assert os.environ["TEST_A_KEY"] == "from-file"


def test_keys_the_launcher_already_read_from_infisical_are_reported_as_such(fresh, monkeypatch):
    monkeypatch.setenv("OMNIPILOT_INFISICAL_LOADED", "TEST_A_KEY")
    monkeypatch.setenv("TEST_A_KEY", "x")
    monkeypatch.setattr(envfiles, "FILES", ())
    envfiles.load(envfiles.FILES)
    assert envfiles.source("TEST_A_KEY") == "infisical"
