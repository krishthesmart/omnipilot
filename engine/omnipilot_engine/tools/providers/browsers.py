"""Cloud browsers for jobs that need a real browser and clicking around: Stagehand (Browserbase's AI
browser framework, using OmniPilot's Groq key for its model) and Browser Use Cloud. Both are read-only
here: OmniPilot never asks them to sign in, buy, post or send. Sessions are always closed."""
from __future__ import annotations

import asyncio

from ..base import Budget, ToolError, http
from ... import envfiles
from . import Provider

RULES = (
    "Only look things up and read. Do NOT sign in or create accounts, do NOT buy, order, book, post, send, delete or "
    "submit anything except search boxes and filters, and do NOT type personal information. If the job needs any of that, stop and say so."
)
STAGEHAND_MODEL = "groq/openai/gpt-oss-120b"


class Stagehand(Provider):
    name, label, env, kinds = "stagehand", "Stagehand (Browserbase)", ("BROWSERBASE_API_KEY", "GROQ_API_KEY"), ("browse",)
    cost = {"browse": 0.02}
    docs = "https://docs.stagehand.dev"

    async def run(self, kind, args, budget, timeout):
        """args: url (where to start), instruction (what to find)."""
        try:
            from stagehand import Stagehand as SH, browserbase
        except ImportError:  # pragma: no cover
            raise ToolError(self.name, "the stagehand package isn't installed", code="not_installed")
        browser = sh = None
        try:
            browser = await asyncio.wait_for(browserbase.launch(api_key=envfiles.secret("BROWSERBASE_API_KEY"), timeout=min(timeout, 300)), timeout=60)
            sh = await SH.create(browser=browser, model=STAGEHAND_MODEL, model_api_key=envfiles.secret("GROQ_API_KEY"))
            page = await sh.browser.context.active_page()
            if args.get("url"):
                await page.goto(args["url"], wait_until="domcontentloaded", timeout=int(min(timeout, 45) * 1000))
            result = await asyncio.wait_for(sh.extract(f"{args['instruction']}\n\n{RULES}"), timeout=max(10, timeout - 15))
            data = getattr(result, "data", result)
            text = getattr(data, "extraction", None) if hasattr(data, "extraction") else (data.model_dump() if hasattr(data, "model_dump") else data)
            if not str(text or "").strip():
                raise ToolError(self.name, "the cloud browser found nothing for that on the page", code="empty")
            return {"answer": text if isinstance(text, str) else str(text), "url": args.get("url")}
        except ToolError:
            raise
        except asyncio.TimeoutError:
            raise ToolError(self.name, "the cloud browser took too long", code="timeout")
        except Exception as err:
            raise ToolError(self.name, f"Stagehand failed: {type(err).__name__}: {str(err)[:160]}")
        finally:
            for closer in (sh, browser):
                if closer is not None:
                    try:
                        await asyncio.wait_for(closer.close(), timeout=15)
                    except Exception:
                        pass

    async def verify(self, timeout):
        r = await self.run("browse", {"url": "https://example.com", "instruction": "the first sentence of text on the page"}, Budget(), timeout)
        if "documentation" not in str(r["answer"]).lower():
            raise ToolError(self.name, f"the browser opened, but the answer was wrong or empty: {str(r['answer'])[:80]}")
        return f"opened a cloud browser and read example.com correctly: {str(r['answer'])[:70]}"


class BrowserUse(Provider):
    name, label, env, kinds = "browser_use", "Browser Use", ("BROWSER_USE_API_KEY",), ("browse",)
    cost = {"browse": 0.03}
    docs = "https://docs.browser-use.com/cloud"
    API = "https://api.browser-use.com/api/v2"

    def _headers(self):
        return {"X-Browser-Use-API-Key": envfiles.secret("BROWSER_USE_API_KEY"), "Content-Type": "application/json"}

    async def run(self, kind, args, budget, timeout):
        task = f"{args['instruction']}" + (f" Start at {args['url']}." if args.get("url") else "") + f"\n\n{RULES} Finish with a clear answer and the URLs you used."
        res = await http(self.name, "POST", f"{self.API}/tasks", timeout=20, headers=self._headers(), json={"task": task})
        task_id = res.json().get("id")
        if not task_id:
            raise ToolError(self.name, "Browser Use didn't start the task")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        try:
            while loop.time() < deadline:
                await asyncio.sleep(3)
                s = (await http(self.name, "GET", f"{self.API}/tasks/{task_id}/status", timeout=15, headers=self._headers())).json()
                if s.get("status") in ("finished", "failed", "stopped"):
                    if s.get("status") != "finished" or s.get("isSuccess") is False:
                        raise ToolError(self.name, f"the browser task {s.get('status')}")
                    return {"answer": str(s.get("output") or "")[:20_000], "cost_usd": s.get("cost")}
            raise ToolError(self.name, "the browser task took too long", code="timeout")
        finally:
            # Don't leave a task running (and billing) after we stop waiting.
            try:
                await http(self.name, "PATCH", f"{self.API}/tasks/{task_id}", timeout=10, retries=0, headers=self._headers(), json={"action": "stop"})
            except ToolError:
                pass

    async def verify(self, timeout):
        # Free check: the account endpoint (the task list can be very slow on their side).
        data = (await http(self.name, "GET", f"{self.API}/billing/account", timeout=min(timeout, 20), headers=self._headers())).json()
        credits = data.get("totalCreditsBalanceUsd")
        return f"key accepted ({'$%.2f of credit left' % credits if isinstance(credits, (int, float)) else 'account readable'})"
