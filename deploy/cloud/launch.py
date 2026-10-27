"""Starts a hosted OmniPilot (Render, a Hugging Face Space, any container host), the same stack as `npm start`:
  1. refuses to run on the internet without OMNIPILOT_PASSWORD (12+ characters), so only you can sign in;
  2. restores the database, workspace and encyclopedia from the private dataset (datasync.py), or starts
     with the starter workspace the first time;
  3. starts the local AI model when the image has one (Ollama), the TypeScript engine on an internal
     loopback port with a secret made fresh for this launch, and the Python front door on the public port;
  4. saves the data when it changes (every few minutes) and once more when the Space stops.
If any part stops, everything stops (the Space then restarts it)."""
from __future__ import annotations

import os
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import datasync  # noqa: E402

APP = Path("/app")
DATA = Path(os.environ.get("OMNIPILOT_DATA_DIR", "/data"))
PORT = int(os.environ.get("PORT", "7860"))
NODE_PORT = PORT + 1
SAVE_EVERY_S = int(os.environ.get("OMNIPILOT_SAVE_EVERY_S", "600"))
children: list[subprocess.Popen] = []
stopping = threading.Event()


def log(msg: str) -> None:
    print(f"[omnipilot] {msg}", flush=True)


def wait_for(url: str, seconds: int) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except Exception:
            time.sleep(0.5)
    return False


def start(name: str, cmd: list[str], env: dict, cwd: Path | None = None) -> None:
    p = subprocess.Popen(cmd, env=env, cwd=cwd)
    p.name = name  # type: ignore[attr-defined]
    children.append(p)


def save(reason: str) -> None:
    if not datasync.configured():
        return
    try:
        datasync.save(DATA, f"Save OmniPilot data ({reason})")
        log(f"data saved ({reason})")
    except Exception as err:
        log(f"couldn't save data ({reason}): {type(err).__name__}: {str(err)[:200]}")


def saver() -> None:
    last = datasync.fingerprint(DATA)
    while not stopping.wait(SAVE_EVERY_S):
        now = datasync.fingerprint(DATA)
        if now != last:
            save("changed")
            last = datasync.fingerprint(DATA)


def shutdown(code: int = 0) -> None:
    if stopping.is_set():
        return
    stopping.set()
    for p in children:
        if p.poll() is None:
            p.terminate()
    for p in children:
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            p.kill()
    save("shutdown")
    sys.exit(code)


def main() -> None:
    if len(os.environ.get("OMNIPILOT_PASSWORD", "")) < 12:
        log("set OMNIPILOT_PASSWORD (12+ characters) as a Space secret so only you can sign in. Not starting.")
        sys.exit(1)
    DATA.mkdir(parents=True, exist_ok=True)
    if datasync.configured():
        try:
            log(f"restored: {', '.join(datasync.restore(DATA)) or 'nothing yet (first start)'}")
        except Exception as err:
            log(f"couldn't restore data ({type(err).__name__}: {str(err)[:200]}); starting fresh, and saving is OFF so nothing is overwritten")
            os.environ.pop("HF_TOKEN", None)
    else:
        log("warning: HF_TOKEN / OMNIPILOT_SYNC_REPO aren't set, so data is lost whenever the Space restarts")
    workspace = DATA / "workspace"
    if not workspace.is_dir():
        shutil.copytree(APP / "server" / "workspace-seed", workspace)

    # The public address: Render and Hugging Face each tell the container its own.
    public = (os.environ.get("RENDER_EXTERNAL_URL") or (f"https://{os.environ['SPACE_HOST']}" if os.environ.get("SPACE_HOST") else "")).rstrip("/")
    env = {
        **os.environ,
        "OMNIPILOT_DATA_DIR": str(DATA),
        "OMNIPILOT_WORKSPACE": str(workspace),
        "OMNIPILOT_KNOWLEDGE": str(DATA / "knowledge.sqlite"),
        "OMNIPILOT_INFISICAL": "0",
        "OLLAMA_HOST": "127.0.0.1:11434",
        "OLLAMA_KEEP_ALIVE": "24h",
        "PYTHON": str(APP / "engine" / ".venv" / "bin" / "python"),
    }
    if public and not env.get("OMNIPILOT_PUBLIC_URL"):
        env["OMNIPILOT_PUBLIC_URL"] = public
    env.pop("HF_TOKEN", None)  # only the data sync (this process) needs it; the engines never see it
    internal = secrets.token_urlsafe(32)

    if shutil.which("ollama"):
        start("The local AI model", ["ollama", "serve"], env)
        if not wait_for("http://127.0.0.1:11434/api/tags", 60):
            log("warning: the local AI model didn't start; OmniPilot will use Groq")
    else:
        log("no local AI model in this image (small hosting plan): answers come from Groq")
    start("The TypeScript engine", ["node", "dist/index.js"], {
        **env, "PORT": str(NODE_PORT), "HOST": "127.0.0.1", "OMNIPILOT_INTERNAL_TOKEN": internal,
        "OMNIPILOT_BEHIND_FRONT_DOOR": "1", "OMNIPILOT_ENGINE_URL": f"http://127.0.0.1:{PORT}"}, cwd=APP / "server")
    start("The Python front door", [str(APP / "engine" / ".venv" / "bin" / "uvicorn"), "omnipilot_engine.app:app", "--app-dir", str(APP / "engine"),
                                    "--host", "0.0.0.0", "--port", str(PORT), "--log-level", "warning", "--no-server-header"],
          {**env, "PORT": str(PORT), "HOST": "0.0.0.0", "OMNIPILOT_NODE_URL": f"http://127.0.0.1:{NODE_PORT}", "OMNIPILOT_INTERNAL_TOKEN": internal})

    signal.signal(signal.SIGTERM, lambda *_: shutdown(0))
    signal.signal(signal.SIGINT, lambda *_: shutdown(0))
    if wait_for(f"http://127.0.0.1:{PORT}/api/engine/health", 120):
        log(f"OmniPilot is running{f' at {public}' if public else ''}")
    threading.Thread(target=saver, daemon=True).start()
    while not stopping.is_set():
        for p in children:
            if p.poll() is not None:
                log(f"{p.name} stopped (exit code {p.returncode}); shutting OmniPilot down")  # type: ignore[attr-defined]
                shutdown(p.returncode or 1)
        time.sleep(1)


if __name__ == "__main__":
    main()
