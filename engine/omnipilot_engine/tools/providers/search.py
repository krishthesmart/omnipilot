"""Web search services: Exa (neural search with page text), Tavily (search built for AI agents),
You.com, and Browserbase Search."""
from __future__ import annotations

from ..base import Budget, ToolError, http
from ... import envfiles
from . import Provider


def _results(items, title="title", url="url", text=("text", "content", "snippet")) -> list[dict]:
    out = []
    for r in items or []:
        if not isinstance(r, dict) or not r.get(url):
            continue
        body = next((r.get(k) for k in text if r.get(k)), "")
        if isinstance(body, list):
            body = " ".join(map(str, body))
        out.append({"title": str(r.get(title) or r.get(url))[:200], "url": r[url], "text": str(body or "")[:2000]})
    return out


class Exa(Provider):
    name, label, env, kinds = "exa", "Exa", ("EXA_API_KEY",), ("web_search",)
    cost = {"web_search": 0.006}
    docs = "https://exa.ai/docs/reference/search"

    async def run(self, kind, args, budget, timeout):
        res = await http(
            self.name, "POST", "https://api.exa.ai/search", timeout=timeout,
            headers={"x-api-key": envfiles.secret("EXA_API_KEY"), "content-type": "application/json"},
            json={"query": args["query"][:400], "type": "auto", "numResults": min(int(args.get("count", 5)), 10), "contents": {"highlights": True}},
        )
        data = res.json()
        items = [{**r, "text": " … ".join(r.get("highlights") or []) or r.get("text", "")} for r in data.get("results", [])]
        return {"results": _results(items), "cost_usd": (data.get("costDollars") or {}).get("total")}

    async def verify(self, timeout):
        r = await self.run("web_search", {"query": "OmniPilot test", "count": 1}, Budget(), timeout)
        return f"search returned {len(r['results'])} result(s)"


class Tavily(Provider):
    name, label, env, kinds = "tavily", "Tavily", ("TAVILY_API_KEY",), ("web_search",)
    cost = {"web_search": 0.008}
    docs = "https://docs.tavily.com"

    async def run(self, kind, args, budget, timeout):
        res = await http(
            self.name, "POST", "https://api.tavily.com/search", timeout=timeout,
            headers={"Authorization": f"Bearer {envfiles.secret('TAVILY_API_KEY')}", "Content-Type": "application/json"},
            json={"query": args["query"][:400], "search_depth": "basic", "max_results": min(int(args.get("count", 5)), 10), "include_answer": bool(args.get("answer"))},
        )
        data = res.json()
        return {"results": _results(data.get("results")), "answer": data.get("answer")}

    async def verify(self, timeout):
        r = await self.run("web_search", {"query": "OmniPilot test", "count": 1}, Budget(), timeout)
        return f"search returned {len(r['results'])} result(s)"


class YouCom(Provider):
    name, label, env, kinds = "you", "You.com", ("YDC_API_KEY",), ("web_search",)
    cost = {"web_search": 0.005}
    docs = "https://you.com/docs/api-reference/search/v1-search"

    async def run(self, kind, args, budget, timeout):
        res = await http(
            self.name, "GET", "https://ydc-index.io/v1/search", timeout=timeout,
            headers={"X-API-Key": envfiles.secret("YDC_API_KEY")},
            params={"query": args["query"][:400], "count": min(int(args.get("count", 5)), 10)},
        )
        data = res.json()
        web = (data.get("results") or {}).get("web") if isinstance(data.get("results"), dict) else data.get("hits")
        return {"results": _results(web, text=("snippets", "description", "snippet"))}

    async def verify(self, timeout):
        r = await self.run("web_search", {"query": "OmniPilot test", "count": 1}, Budget(), timeout)
        return f"search returned {len(r['results'])} result(s)"


class BrowserbaseSearch(Provider):
    name, label, env, kinds = "browserbase", "Browserbase", ("BROWSERBASE_API_KEY",), ("web_search", "read_page")
    cost = {"web_search": 0.002, "read_page": 0.002}
    docs = "https://docs.browserbase.com"

    def _headers(self):
        return {"X-BB-API-Key": envfiles.secret("BROWSERBASE_API_KEY"), "Content-Type": "application/json"}

    async def run(self, kind, args, budget, timeout):
        if kind == "web_search":
            res = await http(self.name, "POST", "https://api.browserbase.com/v1/search", timeout=timeout, headers=self._headers(),
                             json={"query": args["query"][:200], "numResults": min(int(args.get("count", 5)), 10)})
            return {"results": _results(res.json().get("results"))}
        res = await http(self.name, "POST", "https://api.browserbase.com/v1/fetch", timeout=timeout, headers=self._headers(),
                         json={"url": args["url"], "format": "markdown", "allowRedirects": True})
        data = res.json()
        content = data.get("content")
        return {"url": args["url"], "markdown": str(content or "")[:60_000], "status": data.get("statusCode")}

    async def verify(self, timeout):
        r = await self.run("web_search", {"query": "OmniPilot test", "count": 1}, Budget(), timeout)
        return f"search returned {len(r['results'])} result(s)"


class SerpApi(Provider):
    name, label, env, kinds = "serpapi", "SerpApi (Google results)", ("SERPAPI_API_KEY",), ("web_search",)
    cost = {"web_search": 0.01}
    docs = "https://serpapi.com/search-api"

    async def run(self, kind, args, budget, timeout):
        res = await http(
            self.name, "GET", "https://serpapi.com/search.json", timeout=timeout,
            params={"engine": "google", "q": args["query"][:400], "num": min(int(args.get("count", 5)), 10), "api_key": envfiles.secret("SERPAPI_API_KEY")},
        )
        data = res.json()
        if data.get("error"):
            raise ToolError(self.name, f"SerpApi: {str(data['error'])[:160]}")
        answer = (data.get("answer_box") or {}).get("answer") or (data.get("answer_box") or {}).get("snippet")
        return {"results": _results(data.get("organic_results"), url="link", text=("snippet",)), "answer": answer}

    async def verify(self, timeout):
        # Free: the account endpoint doesn't use a search credit.
        data = (await http(self.name, "GET", "https://serpapi.com/account.json", timeout=timeout, params={"api_key": envfiles.secret("SERPAPI_API_KEY")})).json()
        left = data.get("total_searches_left", data.get("plan_searches_left"))
        return f"key accepted ({left} searches left this month)" if left is not None else "key accepted"
