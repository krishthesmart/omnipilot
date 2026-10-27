"""Loads OmniPilot's keys and settings into the environment, in this order (the first that has a value wins):
  1. the environment itself (the shell, or the launcher, which already read Infisical);
  2. Infisical: the project in .infisical.json, read once per process with the Infisical CLI (your
     `infisical login`, or a machine identity's INFISICAL_TOKEN on a server); OMNIPILOT_INFISICAL=0 turns it off;
  3. server/.env, then .env in the project folder (the fallback when Infisical can't be reached).
Values are never printed or logged; callers only ever see whether a variable is set, and where it came from."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FILES = (ROOT / "server" / ".env", ROOT / ".env")
_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
# The same key spelled two ways in the wild: the official name wins.
ALIASES = {"BROWSER_USE_API_KEY": ("BROWSERUSE_API_KEY",), "TRIGGER_SECRET_KEY": ("TRIGGER_API_KEY",)}
INFISICAL_ALIASES = {"YOU.COM_API_KEY": "YDC_API_KEY"}  # a name Infisical allows but an environment variable can't use
_sources: dict[str, str] = {}
_infisical_done = False


def infisical_settings() -> dict | None:
    f = ROOT / ".infisical.json"
    try:
        c = json.loads(f.read_text())
    except (OSError, ValueError):
        return None
    return {"project": c["workspaceId"], "env": c.get("defaultEnvironment") or "dev"} if c.get("workspaceId") else None


def _load_infisical() -> None:
    """Reads Infisical once per process. The launcher already did (it lists the names it loaded)."""
    global _infisical_done
    if _infisical_done:
        return
    _infisical_done = True
    loaded = os.environ.get("OMNIPILOT_INFISICAL_LOADED")
    if loaded:
        for name in loaded.split(","):
            _sources.setdefault(name, "infisical")
        return
    settings = infisical_settings()
    cli = shutil.which("infisical") or next((p for p in ("/opt/homebrew/bin/infisical", "/usr/local/bin/infisical") if os.path.exists(p)), None)
    if os.environ.get("OMNIPILOT_INFISICAL") == "0" or not settings or not cli:
        return
    try:
        r = subprocess.run([cli, "export", "--projectId", settings["project"], "--env", os.environ.get("OMNIPILOT_INFISICAL_ENV") or settings["env"], "--format", "json", "--silent"],
                           cwd=ROOT, capture_output=True, text=True, timeout=20)
        items = json.loads(r.stdout) if r.returncode == 0 else []
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return
    for item in items if isinstance(items, list) else []:
        name, value = INFISICAL_ALIASES.get(item.get("key"), item.get("key")), item.get("value")
        if isinstance(name, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) and isinstance(value, str) and name not in os.environ:
            os.environ[name] = value
            _sources[name] = "infisical"


def source(name: str) -> str | None:
    """Where a variable's value came from: "infisical", "server/.env", ".env", "environment", or None if unset."""
    if not os.environ.get(name, "").strip():
        return None
    return _sources.get(name, "environment")


def load(files: tuple[Path, ...] = FILES) -> None:
    if files is FILES:
        _load_infisical()
    for path in files:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            m = _LINE.match(line)
            if m and m.group(1) not in os.environ:
                value = m.group(2)
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                src = "server/.env" if path.parent.name == "server" else ".env"
                os.environ[m.group(1)] = value
                _sources[m.group(1)] = src
                # Forgive casing: env var names are case-sensitive, but people write keys like "Nvidia_API_Key"
                # in .env and expect them to work. Also register the canonical UPPER_CASE name.
                upper = m.group(1).upper()
                if upper != m.group(1) and upper not in os.environ:
                    os.environ[upper] = value
                    _sources[upper] = src
    for official, others in ALIASES.items():
        if not os.environ.get(official):
            for other in others:
                if os.environ.get(other):
                    os.environ[official] = os.environ[other]
                    _sources.setdefault(official, _sources.get(other, "environment"))
                    break


def is_set(name: str) -> bool:
    return bool(os.environ.get(name, "").strip())


def secret(name: str) -> str:
    """A key's value, for sending to its own service only (never log or return it)."""
    return os.environ.get(name, "").strip()
