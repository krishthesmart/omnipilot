"""Bulk scraping with Apify Actors (only when a request really needs many pages or a site-specific
scraper: it costs more than reading a page)."""
from __future__ import annotations

from ..base import http
from ... import envfiles
from . import Provider

DEFAULT_ACTOR = "apify~website-content-crawler"


class Apify(Provider):
    name, label, env, kinds = "apify", "Apify", ("APIFY_API_KEY",), ("scrape",)
    cost = {"scrape": 0.03}
    docs = "https://docs.apify.com/api/v2"

    def _headers(self):
        return {"Authorization": f"Bearer {envfiles.secret('APIFY_API_KEY')}"}

    async def run(self, kind, args, budget, timeout):
        """args: url, max_pages (default 3), or actor + input for a specific Actor."""
        actor = args.get("actor", DEFAULT_ACTOR).replace("/", "~")
        run_input = args.get("input") or {"startUrls": [{"url": args["url"]}], "maxCrawlPages": int(args.get("max_pages", 3)), "crawlerType": "cheerio"}
        res = await http(
            self.name, "POST", f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items", timeout=timeout + 10, retries=0,
            headers=self._headers(), json=run_input,
            params={"timeout": int(min(timeout, 280)), "maxItems": int(args.get("max_items", 20)), "memory": 1024},
        )
        items = res.json()
        pages = [{"url": i.get("url"), "text": str(i.get("text") or i.get("markdown") or "")[:8000]} for i in items if isinstance(i, dict)]
        return {"items": pages if pages else items[:20]}

    async def verify(self, timeout):
        res = await http(self.name, "GET", "https://api.apify.com/v2/users/me", timeout=timeout, headers=self._headers())
        plan = (res.json().get("data") or {}).get("plan", {}).get("id", "unknown plan")
        return f"key accepted (account on {plan})"
