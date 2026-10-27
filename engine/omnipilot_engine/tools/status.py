"""The status of every service OmniPilot knows: configured (its key is in .env), implemented (there's
an adapter), verified or failed (the last live check, with when and why). Never includes key values."""
from __future__ import annotations

from .. import envfiles

import asyncio
import time

from .base import ToolError, last_status, record_status
from .router import PROVIDERS

# Mentioned by the user but needing a variable that isn't set; listed so nothing is silently missing.
EXPECTED = ["browserbase", "browser_use", "e2b", "apify", "composio", "context7", "exa", "tavily", "daytona", "langfuse", "trigger", "you", "tabstack", "stagehand", "serpapi", "mem0", "zep", "llamaparse", "resend", "arcade", "qdrant", "deepgram", "groq"]


def table() -> list[dict]:
    rows = []
    for name in EXPECTED:
        p = PROVIDERS[name]
        last = last_status(name)
        rows.append(
            {
                "name": name,
                "label": p.label,
                "env": list(p.env),
                "configured": p.configured(),
                "missing": p.missing(),
                "keySource": sorted({envfiles.source(e) for e in p.env if envfiles.source(e)}),
                "implemented": True,
                "kinds": list(p.kinds),
                "state": (last or {}).get("state") if p.configured() else "not configured",
                "detail": (last or {}).get("detail") if p.configured() else f"add {', '.join(p.missing())} to .env",
                "checked_at": (last or {}).get("checked_at"),
                "docs": p.docs,
            }
        )
    return rows


async def verify(names: list[str] | None = None, timeout: float = 90) -> list[dict]:
    """Runs each configured service's cheapest working check (one at a time), records the result."""
    for name in names or EXPECTED:
        p = PROVIDERS[name]
        if not p.configured():
            continue
        t0 = time.monotonic()
        try:
            detail = await asyncio.wait_for(p.verify(timeout), timeout=timeout + 10)
            record_status(name, "verified", detail, int((time.monotonic() - t0) * 1000))
        except ToolError as err:
            record_status(name, "failed", str(err), int((time.monotonic() - t0) * 1000))
        except asyncio.TimeoutError:
            record_status(name, "failed", "the check took too long", int((time.monotonic() - t0) * 1000))
        except Exception as err:  # an adapter bug shows up as a failure, not a crash
            record_status(name, "failed", f"{type(err).__name__}: {str(err)[:200]}", int((time.monotonic() - t0) * 1000))
    return table()


def main() -> None:
    """uv run python -m omnipilot_engine.tools.status [verify] [names...]"""
    import sys

    args = sys.argv[1:]
    rows = asyncio.run(verify(args[1:] or None)) if args[:1] == ["verify"] else table()
    for r in rows:
        print(f"{r['label']:<34} {'configured' if r['configured'] else 'NOT configured':<15} {'+'.join(r['keySource']) or '-':<12} {str(r['state'] or 'not checked'):<15} {r['detail'] or ''}")


if __name__ == "__main__":
    main()
