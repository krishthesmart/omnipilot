"""Deploys OmniPilot to Render's free plan: public link, no card, $0 (it sleeps after 15 minutes without
visitors; the Cloudflare Worker's scheduled visit keeps it awake).

    cd engine && uv run python ../scripts/deploy_render.py

Needs:
  - RENDER_API_KEY in Infisical or server/.env (Render dashboard -> Account settings -> API keys);
  - the code in a GitHub repository that Render can read (the `origin` remote of this folder);
  - `hf auth login` on this computer: the data lives in a PRIVATE Hugging Face dataset, because Render's
    free disk is wiped on every restart.
It creates (or updates) the Render service "omnipilot" from render.yaml's settings, copies OmniPilot's
service keys into the service's environment (values are never printed), and starts a deploy."""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "engine"))

from deploy_hf import DATA_NAME, KEYS, password  # noqa: E402
from omnipilot_engine import envfiles  # noqa: E402

API = "https://api.render.com/v1"
NAME = "omnipilot"


def repo_url() -> str:
    url = subprocess.run(["git", "remote", "get-url", "origin"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if not url:
        sys.exit("Stopped: this folder has no GitHub remote yet (git remote add origin https://github.com/<you>/omnipilot).")
    if url.startswith("git@github.com:"):
        url = "https://github.com/" + url.split(":", 1)[1]
    return url.removesuffix(".git")


def main() -> None:
    envfiles.load()
    key = envfiles.secret("RENDER_API_KEY")
    if not key:
        sys.exit("Stopped: add RENDER_API_KEY to Infisical (or server/.env). Render dashboard -> Account settings -> API keys.")
    c = httpx.Client(base_url=API, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"}, timeout=60)

    def call(method: str, path: str, **kw):
        r = c.request(method, path, **kw)
        if r.status_code >= 400:
            sys.exit(f"Stopped: Render answered {r.status_code} to {method} {path}: {r.text[:300]}")
        return r.json() if r.content else None

    from huggingface_hub import HfApi, get_token

    hf_user = HfApi().whoami()["name"]
    values = {k: envfiles.secret(k) for k in KEYS if envfiles.secret(k)}
    values["OMNIPILOT_PASSWORD"] = password()
    values["HF_TOKEN"] = get_token()
    values["OMNIPILOT_SYNC_REPO"] = f"{hf_user}/{DATA_NAME}"
    env_vars = [{"key": k, "value": v} for k, v in values.items()]

    owner = call("GET", "/owners", params={"limit": 20})[0]["owner"]
    found = [s["service"] for s in call("GET", "/services", params={"name": NAME, "limit": 20}) if s["service"]["name"] == NAME]
    if found:
        service = found[0]
        call("PUT", f"/services/{service['id']}/env-vars", json=env_vars)
        call("POST", f"/services/{service['id']}/deploys", json={})
        print(f"  Updated the Render service and started a deploy ({len(values)} settings: {', '.join(sorted(values))}).")
    else:
        body = {
            "type": "web_service", "name": NAME, "ownerId": owner["id"], "repo": repo_url(), "branch": "main", "autoDeploy": "yes",
            "envVars": env_vars,
            "serviceDetails": {"runtime": "docker", "plan": "free", "region": "oregon", "healthCheckPath": "/api/engine/health",
                               "envSpecificDetails": {"dockerfilePath": "./deploy/render/Dockerfile", "dockerContext": "."}},
        }
        service = call("POST", "/services", json=body)["service"]
        print(f"  Created the Render service ({len(values)} settings: {', '.join(sorted(values))}).")
    url = (service.get("serviceDetails") or {}).get("url") or f"https://{NAME}.onrender.com"
    print(f"  Building (10-20 minutes the first time): https://dashboard.render.com/web/{service['id']}")
    print(f"  OmniPilot: {url}")
    if "--wait" in sys.argv:
        for _ in range(120):
            time.sleep(15)
            deploy = call("GET", f"/services/{service['id']}/deploys", params={"limit": 1})[0]["deploy"]
            print(f"  deploy: {deploy['status']}", flush=True)
            if deploy["status"] in ("live", "build_failed", "update_failed", "canceled", "deactivated"):
                break


if __name__ == "__main__":
    main()
