"""Keeps a hosted OmniPilot's data in a private Hugging Face dataset, because a free Space's disk is wiped
whenever it restarts or rebuilds. On start, the database, the workspace and the encyclopedia are restored;
while running, the database (a consistent SQLite backup, never a half-written file) and the workspace are
saved when they change, and once more on shutdown.

Needs HF_TOKEN (a Space secret) and OMNIPILOT_SYNC_REPO (the dataset, e.g. "you/omnipilot-data")."""
from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import tempfile
from pathlib import Path

DB_FILES = ("omnipilot.sqlite", "tools.sqlite")
SKIP_DIRS = {"node_modules", "__pycache__", ".venv", "venv", "dist", "build"}


def configured() -> bool:
    return bool(os.environ.get("HF_TOKEN") and os.environ.get("OMNIPILOT_SYNC_REPO"))


def _api():
    from huggingface_hub import HfApi

    return HfApi(token=os.environ["HF_TOKEN"])


def restore(data: Path) -> list[str]:
    """Downloads what the dataset holds into the data folder. Returns what was restored."""
    from huggingface_hub import snapshot_download

    repo = os.environ["OMNIPILOT_SYNC_REPO"]
    with tempfile.TemporaryDirectory() as tmp:
        snapshot_download(repo, repo_type="dataset", local_dir=tmp, token=os.environ["HF_TOKEN"])
        got = []
        for name in (*DB_FILES, "knowledge.sqlite"):
            src = Path(tmp) / name
            if src.exists():
                shutil.move(str(src), data / name)
                got.append(name)
        if (Path(tmp) / "workspace").is_dir():
            shutil.rmtree(data / "workspace", ignore_errors=True)
            shutil.move(str(Path(tmp) / "workspace"), data / "workspace")
            got.append("workspace")
        return got


def _workspace_files(ws: Path) -> list[Path]:
    out = []
    for dirpath, dirnames, filenames in os.walk(ws):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        out += [Path(dirpath) / f for f in filenames if not f.startswith(".")]
    return sorted(out)


def fingerprint(data: Path) -> str:
    """Changes whenever the database or a workspace file changes (size and modification time)."""
    h = hashlib.sha256()
    for p in [*(data / n for n in DB_FILES), *(data / f"{n}-wal" for n in DB_FILES), *_workspace_files(data / "workspace")]:
        if p.exists():
            st = p.stat()
            h.update(f"{p}:{st.st_size}:{st.st_mtime_ns}".encode())
    return h.hexdigest()


def save(data: Path, message: str = "Save OmniPilot data") -> None:
    """Uploads a consistent copy of the database and the workspace files (one commit)."""
    from huggingface_hub import CommitOperationAdd

    ops = []
    with tempfile.TemporaryDirectory() as tmp:
        for name in DB_FILES:
            if (data / name).exists():
                copy = Path(tmp) / name
                src, dst = sqlite3.connect(data / name), sqlite3.connect(copy)
                try:
                    src.backup(dst)
                finally:
                    src.close()
                    dst.close()
                ops.append(CommitOperationAdd(path_in_repo=name, path_or_fileobj=str(copy)))
        ws = data / "workspace"
        files = _workspace_files(ws) if ws.is_dir() else []
        for f in files:
            if f.stat().st_size <= 20_000_000:
                ops.append(CommitOperationAdd(path_in_repo=f"workspace/{f.relative_to(ws).as_posix()}", path_or_fileobj=str(f)))
        api, repo = _api(), os.environ["OMNIPILOT_SYNC_REPO"]
        # Files deleted from the workspace go from the dataset too.
        from huggingface_hub import CommitOperationDelete

        keep = {o.path_in_repo for o in ops}
        try:
            existing = [p for p in api.list_repo_files(repo, repo_type="dataset") if p.startswith("workspace/")]
        except Exception:
            existing = []
        ops += [CommitOperationDelete(path_in_repo=p) for p in existing if p not in keep]
        if ops:
            api.create_commit(repo, repo_type="dataset", operations=ops, commit_message=message)
