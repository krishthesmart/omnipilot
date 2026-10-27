"""Long-term memory in the cloud: Mem0 (first choice) and Zep (backup). OmniPilot is private by default,
so these are used only when the user explicitly asks OmniPilot to remember or recall something; what's
stored goes to that service. Everything is filed under one user id for the owner."""
from __future__ import annotations

from ..base import Budget, ToolError, http
from ... import envfiles
from . import Provider

OWNER = "omnipilot-owner"


class Mem0(Provider):
    name, label, env, kinds = "mem0", "Mem0 (cloud memory)", ("MEM0_API_KEY",), ("memory_add", "memory_search")
    cost = {"*": 0.0}
    docs = "https://docs.mem0.ai/platform/quickstart"

    def _headers(self):
        return {"Authorization": f"Token {envfiles.secret('MEM0_API_KEY')}", "Content-Type": "application/json"}

    async def run(self, kind, args, budget, timeout):
        if kind == "memory_add":
            res = await http(self.name, "POST", "https://api.mem0.ai/v3/memories/add/", timeout=timeout, headers=self._headers(),
                             json={"messages": [{"role": "user", "content": args["text"][:4000]}], "user_id": args.get("user_id", OWNER)})
            data = res.json()
            return {"saved": True, "status": data.get("status") if isinstance(data, dict) else "ok"}
        res = await http(self.name, "POST", "https://api.mem0.ai/v3/memories/search/", timeout=timeout, headers=self._headers(),
                         json={"query": args["query"][:500], "filters": {"user_id": args.get("user_id", OWNER)}})
        data = res.json()
        items = data.get("results", data) if isinstance(data, dict) else data
        return {"memories": [str(m.get("memory") or m.get("text") or "") for m in (items or []) if isinstance(m, dict)][: int(args.get("limit", 5))]}

    async def verify(self, timeout):
        r = await self.run("memory_search", {"query": "OmniPilot check", "limit": 1}, Budget(), timeout)
        return f"key accepted (memory search works, {len(r['memories'])} match)"


class Zep(Provider):
    name, label, env, kinds = "zep", "Zep (cloud memory)", ("ZEP_API_KEY",), ("memory_add", "memory_search")
    cost = {"*": 0.0}
    docs = "https://help.getzep.com"

    def _client(self, timeout):
        from zep_cloud.client import AsyncZep

        return AsyncZep(api_key=envfiles.secret("ZEP_API_KEY"), timeout=timeout)

    async def _ensure_user(self, z, user_id):
        try:
            await z.user.get(user_id)
        except Exception:
            await z.user.add(user_id=user_id)

    async def run(self, kind, args, budget, timeout):
        z = self._client(timeout)
        user_id = args.get("user_id", OWNER)
        try:
            if kind == "memory_add":
                await self._ensure_user(z, user_id)
                await z.graph.add(user_id=user_id, type="text", data=args["text"][:4000])
                return {"saved": True}
            res = await z.graph.search(user_id=user_id, query=args["query"][:400], limit=int(args.get("limit", 5)), scope="edges")
            return {"memories": [getattr(e, "fact", "") for e in (res.edges or [])]}
        except Exception as err:
            msg = str(err)
            if "404" in msg and kind == "memory_search":
                return {"memories": []}  # nothing stored for this user yet
            raise ToolError(self.name, f"Zep failed: {msg[:160]}", code="auth" if "401" in msg or "403" in msg else "failed")

    async def verify(self, timeout):
        z = self._client(timeout)
        try:
            await z.user.list_ordered(page_size=1)
        except Exception as err:
            raise ToolError(self.name, f"Zep rejected the request: {str(err)[:160]}", code="auth")
        return "key accepted (user list readable)"
