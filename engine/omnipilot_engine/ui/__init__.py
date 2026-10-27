"""OmniPilot's project workspace, in Python with NiceGUI (docs/PYTHON_PORT.md stage 4, docs/product).

Mounted at /app on the same server as everything else. Pages call the same functions as the API
(projects.py), so the same access rules apply; each page also checks the visitor is OmniPilot's owner,
exactly like the API routes. The classic chat app at / keeps working until this workspace covers it.
"""
from __future__ import annotations

import os
import secrets

_mounted = False


def enabled() -> bool:
    return os.environ.get("OMNIPILOT_UI", "on") != "off"


def mount(app, allowed) -> None:
    """Adds the workspace at /app (once per process; tests leave it off)."""
    global _mounted
    if _mounted or not enabled():
        return
    from nicegui import ui

    from . import pages

    pages.set_access_check(allowed)
    ui.run_with(app, mount_path="/app", title="OmniPilot", favicon="🧭", dark=False, show_welcome_message=False,
                storage_secret=secrets.token_urlsafe(32), reconnect_timeout=10)
    _mounted = True
