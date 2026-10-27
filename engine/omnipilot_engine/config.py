"""Settings, read from the environment (server/.env is loaded by the launcher)."""
import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    # The TypeScript engine, on an internal loopback port, reachable only through this service.
    node_url: str
    internal_token: str
    api_token: str | None
    # OMNIPILOT_PASSWORD is set: visitors from other devices may reach the TypeScript engine, which asks them to sign in.
    owner_password_set: bool
    allowed_origins: tuple[str, ...]
    allow_any_host: bool
    web_dist: Path
    shared_file: Path


def load() -> Settings:
    token = (os.environ.get("OMNIPILOT_API_TOKEN") or "").strip()
    return Settings(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8899")),
        node_url=os.environ.get("OMNIPILOT_NODE_URL", "http://127.0.0.1:8898"),
        internal_token=os.environ.get("OMNIPILOT_INTERNAL_TOKEN", ""),
        api_token=token if len(token) >= 16 else None,
        owner_password_set=len(os.environ.get("OMNIPILOT_PASSWORD", "")) >= 12,
        allowed_origins=tuple(o.strip() for o in os.environ.get("OMNIPILOT_ALLOWED_ORIGINS", "").split(",") if o.strip()),
        allow_any_host=os.environ.get("OMNIPILOT_ALLOW_ANY_HOST") == "1",
        web_dist=ROOT / "web" / "dist",
        shared_file=ROOT / "shared" / "omnipilot.json",
    )
