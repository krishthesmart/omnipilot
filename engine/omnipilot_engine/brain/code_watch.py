"""CodePilot's always-on check: it watches the workspace's code folder and rescans a file as soon as it changes.
New issues at or above the chosen level ("alert me only for critical and high") become alerts the app shows in
the sidebar; fixed issues drop off by themselves. Issues already there at startup are recorded without an
alert (no flood). CODE_WATCH=off turns the watcher off; "turn off code alerts" in chat silences alerts.
Same table as the TypeScript engine (code_issues). (Ported from server/src/lib/codeWatch.ts; the watcher
polls file modification times, so it works the same on every system.)"""
from __future__ import annotations

import asyncio
import hashlib
import os

from .. import store

LEVELS = ["low", "medium", "high", "critical", "off"]
SEVERITY_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1}
def alert_level() -> str:
    v = store.get_setting("codeAlertLevel")
    return v if v in LEVELS else "medium"


def set_alert_level(level: str) -> None:
    store.set_setting("codeAlertLevel", level)


def fingerprint(f: dict) -> str:
    """Same issue = same file, rule and line text (so moving it up or down a line isn't "new")."""
    return hashlib.sha1(f"{f['file']}|{f['rule']['id']}|{f['snippet'].strip()}".encode(), usedforsecurity=False).hexdigest()  # an ID, not security


def rescan_file(root: str, rel: str, quiet: bool = False) -> list[dict]:
    """Rescans one file and updates the issue list. Returns issues found for the first time."""
    from .agents.code_pilot import scan_source

    full = os.path.join(root, rel)
    findings = []
    if os.path.exists(full):
        with open(full, encoding="utf-8", errors="replace") as fh:
            findings = scan_source(rel, fh.read())
    now = {fingerprint(f) for f in findings}
    for row in store.q("SELECT fingerprint FROM code_issues WHERE file = ?", rel):
        if row["fingerprint"] not in now:
            store.x("DELETE FROM code_issues WHERE fingerprint = ?", row["fingerprint"])
    fresh = []
    for f in findings:
        fp = fingerprint(f)
        added = store.x("INSERT OR IGNORE INTO code_issues (fingerprint, file, line, rule_id, title, severity, first_seen, alerted, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        fp, rel, f["line"], f["rule"]["id"], f["rule"]["title"], f["rule"]["severity"], store.now(), 0 if quiet else 1, 1 if quiet else 0)
        if added:
            if not quiet:
                fresh.append({"file": rel, "line": f["line"], "title": f["rule"]["title"], "severity": f["rule"]["severity"]})
        else:
            store.x("UPDATE code_issues SET line = ? WHERE fingerprint = ?", f["line"], fp)
    return fresh


def scan_all(root: str, quiet: bool = False) -> dict:
    """Scans every code file now. `quiet` records issues without alerting (used at startup)."""
    from .agents.code_pilot import list_code_files

    files = [os.path.relpath(f, root) for f in list_code_files(os.path.join(root, "code"))]
    fresh = [a for rel in files for a in rescan_file(root, rel, quiet)]
    known = set(files)
    for row in store.q("SELECT DISTINCT file FROM code_issues"):
        if row["file"] not in known:
            store.x("DELETE FROM code_issues WHERE file = ?", row["file"])
    return {"files": len(files), "issues": store.q1("SELECT COUNT(*) AS n FROM code_issues")["n"], "fresh": fresh}


def pending_alerts() -> list[dict]:
    """New issues at or above the alert level that the user hasn't looked at yet."""
    level = alert_level()
    if level == "off":
        return []
    rows = store.q("SELECT file, line, title, severity FROM code_issues WHERE alerted = 1 AND seen = 0 ORDER BY first_seen")
    return [r for r in rows if SEVERITY_RANK.get(r["severity"], 0) >= SEVERITY_RANK[level]]


def mark_alerts_seen() -> None:
    store.x("UPDATE code_issues SET seen = 1 WHERE seen = 0")


async def watch(root: str, interval_s: float = 1.5) -> None:
    """Rescans code files whose modification time changed (editors save in bursts: a file is rescanned once
    it has settled for one interval). Runs until cancelled."""
    from .agents.code_pilot import list_code_files

    code = os.path.join(root, "code")
    if os.environ.get("CODE_WATCH") == "off" or not os.path.isdir(code):
        return
    await asyncio.to_thread(scan_all, root, True)

    def mtimes() -> dict[str, float]:
        out = {}
        for f in list_code_files(code):
            try:
                out[f] = os.stat(f).st_mtime
            except OSError:
                pass
        return out

    seen, settling = await asyncio.to_thread(mtimes), {}
    while True:
        await asyncio.sleep(interval_s)
        now = await asyncio.to_thread(mtimes)
        changed = {f for f in set(now) | set(seen) if now.get(f) != seen.get(f)}
        ready = [f for f in settling if f not in changed]
        for f in ready:
            settling.pop(f)
            try:
                await asyncio.to_thread(rescan_file, root, os.path.relpath(f, root))
            except Exception:
                pass  # a file mid-save or removed: the next change rescans it
        for f in changed:
            settling[f] = True
        seen = now
