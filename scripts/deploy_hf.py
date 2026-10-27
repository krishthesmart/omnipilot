"""Deploys OmniPilot to a Hugging Face Space (Docker Spaces now need a PRO subscription, about $9/month).

    cd engine && uv run python ../scripts/deploy_hf.py [--dry-run]   (uses the account `hf auth login` saved)

What it does:
  - creates the Space <you>/omnipilot (Docker) and a PRIVATE dataset <you>/omnipilot-data for its data;
  - uploads the encyclopedia (server/data/knowledge.sqlite) to the dataset once;
  - copies OmniPilot's service keys (from Infisical / server/.env / .env) into the Space's secrets, which
    only the Space can read; values are never printed, logged or written into a file;
  - makes sure there's a sign-in password: OMNIPILOT_PASSWORD from your settings, or a new random one
    saved to server/.env (open that file to see it);
  - uploads only the files the build needs (the Space's files are public), after checking that none of
    them contains a key.
The hosted copy starts with a fresh database: no chat history, and no personal accounts connected."""
from __future__ import annotations

import os
import re
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

from huggingface_hub import CommitOperationAdd, CommitOperationDelete, HfApi  # noqa: E402

from omnipilot_engine import envfiles  # noqa: E402

SPACE_NAME, DATA_NAME = "omnipilot", "omnipilot-data"
KEYS = ["GROQ_API_KEY", "BROWSERBASE_API_KEY", "BROWSERUSE_API_KEY", "BROWSER_USE_API_KEY", "APIFY_API_KEY", "TABSTACK_API_KEY", "E2B_API_KEY", "DAYTONA_API_KEY",
        "EXA_API_KEY", "TAVILY_API_KEY", "SERPAPI_API_KEY", "YDC_API_KEY", "CONTEXT7_API_KEY", "COMPOSIO_API_KEY", "ARCADE_API_KEY", "RESEND_API_KEY",
        "TRIGGER_API_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_BASE_URL", "MEM0_API_KEY", "ZEP_API_KEY", "QDRANT_API_KEY",
        "QDRANT_ENDPOINT", "LLAMAINDEX_API_KEY", "DEEPGRAM_API_KEY"]
# What the build needs, and nothing else (no .env files, data, training material or personal projects).
INCLUDE = [
    "package.json", "package-lock.json", ".npmrc", "shared/omnipilot.json",
    "server/package.json", "server/tsconfig.json", "server/src/**/*",
    "server/workspace/code/**/*", "server/workspace/docs/**/*", "server/workspace/notes/**/*", "server/workspace/robotics-arm/**/*",
    "web/package.json", "web/index.html", "web/tsconfig.json", "web/vite.config.ts", "web/public/**/*", "web/src/**/*",
    "engine/pyproject.toml", "engine/uv.lock", "engine/omnipilot_engine/**/*",
    "deploy/cloud/launch.py", "deploy/cloud/datasync.py",
]
NOT_SECRET = {"LANGFUSE_BASE_URL"}  # a public web address, also written in server/.env.example
SKIP = re.compile(r"(^|/)(__pycache__|node_modules|\.venv|dist)(/|$)|\.pyc$|(^|/)\.env|\.test\.tsx?$|\.sqlite")

SPACE_README = """---
title: OmniPilot
emoji: 🧭
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
short_description: A multi-agent AI assistant (sign-in required)
---

# OmniPilot

A chat-first, multi-agent AI assistant. This copy is private to its owner: visitors must sign in with the
owner's password. Open it at https://{host}

Runs the whole OmniPilot stack in this Space: the Python engine, the local AI model (Ollama, qwen3:4b-instruct)
with Groq for hard jobs, and the web app. Its data is kept in a private dataset.
"""


def files_to_upload() -> list[str]:
    out = set()
    for pattern in INCLUDE:
        for p in ([ROOT / pattern] if "*" not in pattern else ROOT.glob(pattern)):
            rel = p.relative_to(ROOT).as_posix()
            if p.is_file() and not SKIP.search(rel):
                out.add(rel)
    return sorted(out)


def check_no_keys(paths: list[str], values: list[str]) -> None:
    """Stops the deploy if any uploaded file contains one of the keys."""
    for rel in paths:
        text = (ROOT / rel).read_bytes()
        for v in values:
            if len(v) >= 12 and v.encode() in text:
                sys.exit(f"Stopped: {rel} contains one of your keys. Remove it from that file first.")


def password() -> str:
    """The sign-in password, or a new random one saved to server/.env (never printed)."""
    p = envfiles.secret("OMNIPILOT_PASSWORD")
    if len(p) >= 12:
        return p
    p = secrets.token_urlsafe(15)
    env_file = ROOT / "server" / ".env"
    with open(env_file, "a", encoding="utf-8") as f:
        f.write(f"\n# Password for the hosted OmniPilot (Hugging Face Space)\nOMNIPILOT_PASSWORD={p}\n")
    os.chmod(env_file, 0o600)
    print("  Made a sign-in password and saved it to server/.env (OMNIPILOT_PASSWORD). Open that file to see it.")
    return p


def main() -> None:
    envfiles.load()
    if "--dry-run" in sys.argv:  # what would be uploaded, checked for keys; nothing is created or sent
        paths = files_to_upload()
        check_no_keys(paths, [envfiles.secret(k) for k in KEYS if envfiles.secret(k) and k not in NOT_SECRET])
        print(f"  {len(paths)} files would be uploaded (none contains a key):")
        for top in sorted({"/".join(p.split("/")[:2]) for p in paths}):
            print(f"    {top} ({sum(1 for p in paths if p.startswith(top))})")
        return
    api = HfApi()
    user = api.whoami()["name"]
    space, data = f"{user}/{SPACE_NAME}", f"{user}/{DATA_NAME}"
    host = f"{user}-{SPACE_NAME}".lower().replace("_", "-") + ".hf.space"
    print(f"  Hugging Face account: {user}")

    api.create_repo(data, repo_type="dataset", private=True, exist_ok=True)
    if not api.repo_info(data, repo_type="dataset").private:
        sys.exit(f"Stopped: the dataset {data} exists but is public; make it private (its settings page) and run this again.")
    if "knowledge.sqlite" not in api.list_repo_files(data, repo_type="dataset") and (ROOT / "server/data/knowledge.sqlite").exists():
        print("  Uploading the encyclopedia to the private dataset (177 MB, once)…")
        api.upload_file(path_or_fileobj=str(ROOT / "server/data/knowledge.sqlite"), path_in_repo="knowledge.sqlite", repo_id=data, repo_type="dataset",
                        commit_message="Add the encyclopedia")
    api.create_repo(space, repo_type="space", space_sdk="docker", private=False, exist_ok=True)

    values = {k: envfiles.secret(k) for k in KEYS if envfiles.secret(k)}
    values["OMNIPILOT_PASSWORD"] = password()
    from huggingface_hub import get_token

    values["HF_TOKEN"] = get_token()  # lets the Space save its data to the private dataset
    for k, v in values.items():
        api.add_space_secret(space, k, v)
    api.add_space_variable(space, "OMNIPILOT_SYNC_REPO", data)
    api.add_space_variable(space, "OMNIPILOT_PUBLIC_URL", f"https://{host}")
    print(f"  Space secrets set: {len(values)} ({', '.join(sorted(values))})")

    paths = files_to_upload()
    check_no_keys(paths, [v for k, v in values.items() if k not in NOT_SECRET])
    readme = SPACE_README.format(host=host)
    ops = [CommitOperationAdd(path_in_repo=p, path_or_fileobj=str(ROOT / p)) for p in paths]
    ops += [CommitOperationAdd(path_in_repo="Dockerfile", path_or_fileobj=str(ROOT / "deploy/huggingface/Dockerfile")),
            CommitOperationAdd(path_in_repo="README.md", path_or_fileobj=readme.encode())]
    keep = {o.path_in_repo for o in ops} | {".gitattributes"}
    ops += [CommitOperationDelete(path_in_repo=p) for p in api.list_repo_files(space, repo_type="space") if p not in keep]
    api.create_commit(space, repo_type="space", operations=ops, commit_message="Deploy OmniPilot")
    print(f"  Uploaded {len(paths) + 2} files. The Space is building (15-25 minutes the first time).")
    print(f"  Build progress: https://huggingface.co/spaces/{space}")
    print(f"  OmniPilot: https://{host}")


if __name__ == "__main__":
    main()
