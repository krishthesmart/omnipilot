"""Reading a page as clean text: Tabstack (Mozilla's extraction API)."""
from __future__ import annotations

from ..base import Budget, http
from ... import envfiles
from . import Provider


class Tabstack(Provider):
    name, label, env, kinds = "tabstack", "Tabstack", ("TABSTACK_API_KEY",), ("read_page",)
    cost = {"read_page": 0.001}
    docs = "https://docs.tabstack.ai"

    async def run(self, kind, args, budget, timeout):
        res = await http(
            self.name, "POST", "https://api.tabstack.ai/v1/extract/markdown", timeout=timeout,
            headers={"Authorization": f"Bearer {envfiles.secret('TABSTACK_API_KEY')}", "Content-Type": "application/json"},
            json={"url": args["url"]},
        )
        data = res.json()
        return {"url": data.get("url", args["url"]), "markdown": str(data.get("content") or data.get("markdown") or "")[:60_000]}

    async def verify(self, timeout):
        r = await self.run("read_page", {"url": "https://example.com"}, Budget(), timeout)
        return f"read example.com ({len(r['markdown'])} characters)"
