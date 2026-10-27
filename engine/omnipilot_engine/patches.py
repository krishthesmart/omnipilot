"""Code changes CodePilot proposes for files in the approved workspace folder, shown as a diff before
anything changes. Approving writes them, but only if every file is still inside the workspace folder (no
symlinks out of it) and unchanged since the change was written (sha256 of its content). A change set
spanning many files is applied completely or not at all; the originals are kept so "Undo" restores them
(as long as nobody edited the files since). Same table as the TypeScript engine (code_patches)."""
from __future__ import annotations

import difflib
import hashlib
import os
from pathlib import Path

from . import envfiles, store

MAX_PATCH_FILE_BYTES = 200_000


def workspace_root() -> str:
    return os.environ.get("OMNIPILOT_WORKSPACE") or str(envfiles.ROOT / "server" / "workspace")


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _inside(root: str, p: str) -> bool:
    return p.startswith(root + os.sep)


def safe_new_path(root: str, rel: str) -> str | None:
    """Where a NEW file would go, or None if it's outside the workspace or already exists."""
    if not rel or os.path.isabs(rel) or ".." in rel.replace("\\", "/").split("/"):
        return None
    real_root = os.path.realpath(root)
    target = os.path.normpath(os.path.join(real_root, rel))
    if not _inside(real_root, target) or os.path.exists(target):
        return None
    d = os.path.dirname(target)
    while not os.path.exists(d):
        d = os.path.dirname(d)
    real = os.path.realpath(d)
    return target if real == real_root or _inside(real_root, real) else None


def safe_workspace_path(root: str, rel: str) -> str | None:
    """The existing workspace file `rel` points to, or None if it would leave the workspace folder."""
    real_root = os.path.realpath(root)
    target = os.path.normpath(os.path.join(real_root, rel))
    if target != real_root and not _inside(real_root, target):
        return None
    if not os.path.exists(target):
        return None
    real = os.path.realpath(target)
    return real if _inside(real_root, real) else None


def unified_diff(file: str, before: str, after: str) -> str:
    a, b = before.split("\n"), after.split("\n")
    if len(a) * len(b) > 4_000_000:
        return f"--- a/{file}\n+++ b/{file}\n(file too large to show a diff)"
    lines = list(difflib.unified_diff(a, b, f"a/{file}", f"b/{file}", n=2, lineterm=""))
    return "\n".join(lines) if lines else f"--- a/{file}\n+++ b/{file}"


def to_workspace_rel(root: str | None, rel: str) -> str:
    """A path relative to an agent's workspace (a project's own folder) as a path relative to the workspace
    root, where approved changes are applied."""
    if not root:
        return rel
    full = os.path.normpath(os.path.join(root, rel))
    base = os.path.normpath(workspace_root())
    out = os.path.relpath(full, base)
    if out.startswith(".."):
        raise ValueError("the change is outside the workspace")
    return out


def save_patch(id: str, file: str, original: str, fixed: str, summary: str, set_id: str | None = None, is_new: bool = False) -> None:
    store.x(
        "INSERT OR REPLACE INTO code_patches (id, file, original_hash, original, fixed, summary, status, created_at, set_id, is_new) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
        id, file, sha(original), original, fixed, summary[:500], store.now(), set_id or id, 1 if is_new else 0,
    )


def save_patch_set(set_id: str, summary: str, files: list[dict]) -> None:
    for i, f in enumerate(files):
        save_patch(set_id if i == 0 else f"{set_id}#{i}", f["file"], f["original"], f["fixed"], summary, set_id, bool(f.get("isNew")))


def _row(r: dict) -> dict:
    return {"id": r["id"], "file": r["file"], "summary": r["summary"], "status": r["status"], "isNew": r.get("is_new") == 1,
            "diff": unified_diff(r["file"], r["original"], r["fixed"]), "original": r["original"], "fixed": r["fixed"], "originalHash": r["original_hash"]}


def public(p: dict) -> dict:
    return {k: p[k] for k in ("id", "file", "summary", "status", "isNew", "diff")}


def get_patch(id: str) -> dict | None:
    r = store.q1("SELECT * FROM code_patches WHERE id = ?", id)
    return _row(r) if r else None


def patch_set(set_id: str) -> list[dict]:
    return [_row(r) for r in store.q("SELECT * FROM code_patches WHERE set_id = ? OR (set_id IS NULL AND id = ?) ORDER BY rowid", set_id, set_id)]


def _fail(error: str, message: str) -> dict:
    return {"ok": False, "error": error, "message": message}


def _write_atomic(target: str, text: str) -> None:
    Path(target).parent.mkdir(parents=True, exist_ok=True)
    tmp = f"{target}.omnipilot-tmp"
    Path(tmp).write_text(text, encoding="utf-8")
    os.replace(tmp, target)


def _read(p: str) -> str:
    return Path(p).read_text(encoding="utf-8")


def apply_patch(id: str, root: str | None = None) -> dict:
    root = root or workspace_root()
    s = patch_set(id)
    if not s:
        return _fail("not_found", "There's no fix to apply for this.")
    done = next((p for p in s if p["status"] != "pending"), None)
    if done:
        return _fail("not_pending", f"This change was already {done['status']}.")
    targets = []
    for p in s:  # check every file before writing any
        if p["isNew"]:
            t = safe_new_path(root, p["file"])
            if not t:
                exists = os.path.exists(os.path.join(root, p["file"]))
                return _fail("changed" if exists else "outside_workspace", f"{p['file']} {'already exists now, so it wasn' + chr(39) + 't overwritten' if exists else 'isn' + chr(39) + 't inside the approved workspace folder'}.")
        else:
            t = safe_workspace_path(root, p["file"])
            if not t:
                return _fail("outside_workspace", f"{p['file']} isn't in the approved workspace folder any more.")
            if sha(_read(t)) != p["originalHash"]:
                return _fail("changed", f"{p['file']} changed after the fix was written, so nothing was applied. Ask CodePilot to scan again.")
        targets.append(t)
    written: list[int] = []
    try:
        for i, p in enumerate(s):
            _write_atomic(targets[i], p["fixed"])
            written.append(i)
    except OSError:
        for i in written:  # put back what was written, so the set isn't half-applied
            try:
                os.remove(targets[i]) if s[i]["isNew"] else _write_atomic(targets[i], s[i]["original"])
            except OSError:
                pass
        failed = s[len(written)]["file"] if len(written) < len(s) else "the files"
        return _fail("write_failed", f"Couldn't write {failed}; nothing was changed.")
    now = store.now()
    for p in s:
        store.x("UPDATE code_patches SET status = 'applied', applied_at = ? WHERE id = ?", now, p["id"])
    return {"ok": True, "file": s[0]["file"], "files": [p["file"] for p in s]}


def undo_patch(id: str, root: str | None = None) -> dict:
    root = root or workspace_root()
    s = patch_set(id)
    if not s:
        return _fail("not_found", "There's no fix to undo.")
    if any(p["status"] != "applied" for p in s):
        return _fail("not_pending", "This change isn't applied.")
    targets = []
    for p in s:
        t = safe_workspace_path(root, p["file"])
        if not t:
            return _fail("outside_workspace", f"{p['file']} isn't in the workspace folder any more.")
        if sha(_read(t)) != sha(p["fixed"]):
            return _fail("changed", f"{p['file']} was edited after the change, so undoing it could lose those edits.")
        targets.append(t)
    for i, p in enumerate(s):
        if p["isNew"]:
            Path(targets[i]).unlink(missing_ok=True)
        else:
            _write_atomic(targets[i], p["original"])
    real_root = os.path.realpath(root)
    for i, p in enumerate(s):  # folders the change created (now empty) go too
        if not p["isNew"]:
            continue
        d = os.path.dirname(targets[i])
        while _inside(real_root, d) and os.path.isdir(d) and not os.listdir(d):
            os.rmdir(d)
            d = os.path.dirname(d)
    for p in s:
        store.x("UPDATE code_patches SET status = 'undone' WHERE id = ?", p["id"])
    return {"ok": True, "file": s[0]["file"], "files": [p["file"] for p in s]}


def reject_patch(id: str) -> None:
    for p in patch_set(id):
        store.x("UPDATE code_patches SET status = 'rejected' WHERE id = ? AND status = 'pending'", p["id"])
