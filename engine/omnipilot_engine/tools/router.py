"""Picks the service for each kind of job, so a request never pays several providers for the same work.

  web_search     Exa -> Tavily -> SerpApi -> Browserbase -> You.com   (first that's configured and works)
  read_page      Tabstack -> Browserbase                         (cheap page-to-text)
  browse         Stagehand -> Browser Use                        (pages that need a real browser)
  scrape         Apify                                           (many pages; only when asked for)
  run_code       E2B -> Daytona                                  (never on this computer)
  library_docs   Context7
  app_action     Composio or Arcade, by tool name format         (changes need approval)
  background_job Trigger.dev
  memory_add/memory_search  Mem0 -> Zep                          (only when asked to remember/recall)
  parse_document LlamaParse                                      (PDFs, Word, slides... to text)
  send_email     Resend                                          (always needs approval)
  vector_upsert/vector_search  Qdrant, embeddings made locally  (only when asked to index)
  transcribe     Deepgram                                        (only when on-device Whisper can't)

The next service is tried only when one fails in a way another could fix (unreachable, rate-limited,
out of credits, bad key) -- never after a success, and never when the request's budget is used up.
Search, page and docs results are cached for a day, so repeating a look-up costs nothing.
"""
from __future__ import annotations

import time

from .base import Budget, BudgetExceeded, run_spend, ToolError, cache_get, cache_key, cache_put, record_status
from .providers import Provider
from .providers.apps import Arcade, Composio, TriggerDev
from .providers.browsers import BrowserUse, Stagehand
from .providers.docs import Context7
from .providers.observability import Groq, Langfuse
from .providers.pages import Tabstack
from .providers.sandboxes import Daytona, E2B
from .providers.scrape import Apify
from .providers.documents import LlamaParse
from .providers.email import Resend
from .providers.memory import Mem0, Zep
from .providers.speech_cloud import Deepgram
from .providers.vectors import Qdrant
from .providers.search import BrowserbaseSearch, Exa, SerpApi, Tavily, YouCom

PROVIDERS: dict[str, Provider] = {
    p.name: p
    for p in (Exa(), Tavily(), SerpApi(), BrowserbaseSearch(), YouCom(), Tabstack(), Stagehand(), BrowserUse(), Apify(), E2B(), Daytona(), Context7(), Composio(), TriggerDev(), Mem0(), Zep(), LlamaParse(), Resend(), Arcade(), Qdrant(), Deepgram(), Langfuse(), Groq())
}

ROUTES: dict[str, list[str]] = {
    "web_search": ["exa", "tavily", "serpapi", "browserbase", "you"],
    "read_page": ["tabstack", "browserbase"],
    "browse": ["stagehand", "browser_use"],
    "scrape": ["apify"],
    "run_code": ["e2b", "daytona"],
    "library_docs": ["context7"],
    "app_action": ["composio", "arcade"],
    "background_job": ["trigger"],
    "memory_add": ["mem0", "zep"],
    "memory_search": ["mem0", "zep"],
    "parse_document": ["llamaparse"],
    "send_email": ["resend"],
    "vector_upsert": ["qdrant"],
    "vector_search": ["qdrant"],
    "transcribe": ["deepgram"],
}
CACHEABLE = {"web_search": 86400, "read_page": 86400, "library_docs": 7 * 86400}
TIMEOUTS = {"web_search": 20, "read_page": 40, "browse": 180, "scrape": 280, "run_code": 240, "library_docs": 30, "app_action": 60, "background_job": 30, "memory_add": 30, "memory_search": 20, "parse_document": 180, "send_email": 30, "vector_upsert": 120, "vector_search": 30, "transcribe": 60}


class NoProvider(ToolError):
    def __init__(self, kind: str, why: str):
        super().__init__("router", why, code="unavailable", retry_elsewhere=False)
        self.kind = kind


async def run(kind: str, args: dict, budget: Budget | None = None, prefer: str | None = None) -> dict:
    """Does one job with the first suitable service. Returns the result plus which service did it."""
    if kind not in ROUTES:
        raise NoProvider(kind, f"unknown kind of job: {kind}")
    budget = budget or Budget()
    order = ROUTES[kind]
    if prefer in order:
        order = [prefer] + [p for p in order if p != prefer]
    candidates = [PROVIDERS[p] for p in order if PROVIDERS[p].configured() and PROVIDERS[p].accepts(kind, args)]
    if not candidates:
        needed = " or ".join(f"{PROVIDERS[p].label} ({', '.join(PROVIDERS[p].env)})" for p in order)
        raise NoProvider(kind, f"no service is set up for {kind.replace('_', ' ')}: add {needed} to your .env")

    key = cache_key(kind, args) if kind in CACHEABLE else None
    if key and (hit := cache_get(key, CACHEABLE[kind])) is not None:
        budget.note(hit.get("provider", "?"), kind, "cached", 0, 0.0)
        return {**hit, "cached": True}

    errors: list[str] = []
    for p in candidates:
        cost = p.est_cost(kind)
        if (spend := run_spend.get()) is not None:
            spend.take(cost)  # the project's per-run budget, checked before the call (raises BudgetExceeded)
        left = budget.take(p.name, cost)  # raises BudgetExceeded: never go over
        t0 = time.monotonic()
        try:
            out = await p.run(kind, args, budget, timeout=min(TIMEOUTS[kind], left - 1))
        except BudgetExceeded:
            raise
        except ToolError as err:
            ms = int((time.monotonic() - t0) * 1000)
            budget.note(p.name, kind, f"failed: {err.code}", ms, cost)
            if err.code in ("auth", "credits"):
                record_status(p.name, "failed", str(err), ms)
            errors.append(f"{p.label}: {err}")
            if not err.retry_elsewhere:
                raise
            continue
        ms = int((time.monotonic() - t0) * 1000)
        budget.note(p.name, kind, "ok", ms, cost)
        result = {**out, "provider": p.name, "provider_label": p.label}
        if key:
            cache_put(key, result)
        return result
    raise NoProvider(kind, "every service for this failed: " + "; ".join(errors))
