"""Up-to-date library documentation for CodePilot: Context7."""
from __future__ import annotations

from ..base import Budget, ToolError, http
from ... import envfiles
from . import Provider


class Context7(Provider):
    name, label, env, kinds = "context7", "Context7", ("CONTEXT7_API_KEY",), ("library_docs",)
    cost = {"library_docs": 0.0}
    docs = "https://context7.com/docs"

    def _headers(self):
        return {"Authorization": f"Bearer {envfiles.secret('CONTEXT7_API_KEY')}"}

    async def run(self, kind, args, budget, timeout):
        """args: library (name, e.g. "fastapi"), topic, tokens."""
        found = await http(self.name, "GET", "https://context7.com/api/v1/search", timeout=timeout, headers=self._headers(), params={"query": args["library"][:100]})
        results = found.json().get("results") or []
        if not results:
            raise ToolError(self.name, f"no documentation found for {args['library']}", code="not_found", retry_elsewhere=False)
        lib = results[0]
        docs = await http(self.name, "GET", f"https://context7.com/api/v1{lib['id']}", timeout=timeout, headers=self._headers(),
                          params={"type": "txt", "topic": args.get("topic", "")[:200], "tokens": int(args.get("tokens", 4000))})
        return {"library": lib.get("title"), "id": lib["id"], "docs": docs.text[:40_000]}

    async def verify(self, timeout):
        r = await self.run("library_docs", {"library": "fastapi", "topic": "routing", "tokens": 500}, Budget(), timeout)
        return f"fetched docs for {r['library']} ({len(r['docs'])} characters)"
