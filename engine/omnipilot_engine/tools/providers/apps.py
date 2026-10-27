"""Actions in the user's other apps through Composio (Gmail, Calendar, GitHub, Notion, 800+ more),
using accounts the user connected through Composio themselves. Anything that changes something needs
the user's approval first (args["approved"]); reads run directly. Background jobs: Trigger.dev."""
from __future__ import annotations

import asyncio
import re

from ..base import ToolError, http
from ... import envfiles
from . import Provider

# Read-only means: the action starts with a read verb right after the app name (GMAIL_FETCH_EMAILS) AND names no
# write anywhere (SLACK_SEND_MESSAGE_AND_GET_LINK and GOOGLEDRIVE_GET_AND_DELETE_FILE change things, so they need approval).
WRITE_WORDS = (r"SEND|DELETE|TRASH|CREATE|UPDATE|REMOVE|POST|ADD|MOVE|MODIFY|PATCH|PUT|SET|REPLY|FORWARD|ARCHIVE|INVITE|SHARE|UPLOAD|"
               r"EDIT|WRITE|EXECUTE|RUN|CANCEL|APPROVE|MERGE|CLOSE|STAR|LABEL|MARK|PIN|ASSIGN|TRANSFER|PAY|PURCHASE|BOOK|SCHEDULE|DRAFT|PUBLISH|REVOKE|GRANT|ENABLE|DISABLE|RENAME|COPY|IMPORT|SUBSCRIBE|UNSUBSCRIBE|BLOCK|MUTE|RESTORE|EMPTY|CLEAR|RESET|SYNC|TRIGGER|START|STOP")
READ_LIKE = re.compile(r"^[A-Z0-9]+_(GET|LIST|FETCH|SEARCH|FIND|READ|RETRIEVE|DESCRIBE|QUERY|LOOKUP)(_|$)")
WRITE_LIKE = re.compile(rf"(^|_)({WRITE_WORDS})(_|$)")


def composio_read_only(slug: str) -> bool:
    return bool(READ_LIKE.search(slug)) and not WRITE_LIKE.search(slug)
COMPOSIO_USER = "omnipilot-owner"


class Composio(Provider):
    name, label, env, kinds = "composio", "Composio", ("COMPOSIO_API_KEY",), ("app_action",)
    cost = {"app_action": 0.0}
    docs = "https://docs.composio.dev"

    def accepts(self, kind, args):
        return "." not in str(args.get("tool", ""))  # Composio slugs: GMAIL_FETCH_EMAILS

    def _client(self):
        from composio import Composio as C

        return C(api_key=envfiles.secret("COMPOSIO_API_KEY"))

    async def run(self, kind, args, budget, timeout):
        """args: tool (slug, e.g. GMAIL_FETCH_EMAILS), arguments, approved."""
        slug = str(args["tool"]).upper()
        if not composio_read_only(slug) and not args.get("approved"):
            raise ToolError(self.name, f"{slug} can change something, so it needs your approval first", code="needs_approval", retry_elsewhere=False)

        def call():
            return self._client().tools.execute(slug, args.get("arguments") or {}, user_id=args.get("user_id", COMPOSIO_USER), dangerously_skip_version_check=True)

        try:
            res = await asyncio.wait_for(asyncio.to_thread(call), timeout=timeout)
        except asyncio.TimeoutError:
            raise ToolError(self.name, "Composio took too long", code="timeout")
        except Exception as err:
            raise ToolError(self.name, f"Composio failed: {str(err)[:180]}", retry_elsewhere=False)
        data = res if isinstance(res, dict) else getattr(res, "model_dump", lambda: {"result": str(res)})()
        if data.get("successful") is False:
            raise ToolError(self.name, f"{slug} failed: {str(data.get('error'))[:180]}", retry_elsewhere=False)
        return {"tool": slug, "data": data.get("data", data)}

    async def verify(self, timeout):
        def call():
            return self._client().connected_accounts.list()

        try:
            res = await asyncio.wait_for(asyncio.to_thread(call), timeout=timeout)
        except Exception as err:
            raise ToolError(self.name, f"Composio rejected the request: {str(err)[:160]}", code="auth")
        items = getattr(res, "items", None) or (res.get("items") if isinstance(res, dict) else []) or []
        return f"key accepted ({len(items)} connected app account(s) in Composio)"


ARCADE_API = "https://api.arcade.dev/v1"
ARCADE_READ_VERB = re.compile(r"\.(Get|List|Search|Read|Fetch|Find|Retrieve|Query|Lookup|Describe|Count|Who)[A-Z]?")
ARCADE_WRITE_WORD = re.compile(r"(Send|Delete|Trash|Create|Update|Remove|Post|Add|Move|Modify|Patch|Put|Set|Reply|Forward|Archive|Invite|Share|Upload|Edit|Write|Execute|Run|Cancel|"
                               r"Approve|Merge|Close|Star|Label|Mark|Pin|Assign|Transfer|Pay|Purchase|Book|Schedule|Draft|Publish|Revoke|Grant|Enable|Disable|Rename|Copy|Import|"
                               r"Subscribe|Block|Mute|Restore|Empty|Clear|Reset|Sync|Trigger|Start|Stop)(?=[A-Z]|$)")


class Arcade(Provider):
    """Actions in the user's apps through Arcade (tools named like "Gmail.ListEmails"). The first use of an
    app asks the user to sign in to it at Arcade (a link is returned; nothing runs until they do). Tools
    Arcade marks read-only run directly; anything else needs the user's approval (args["approved"])."""

    name, label, env, kinds = "arcade", "Arcade", ("ARCADE_API_KEY",), ("app_action",)
    cost = {"app_action": 0.0}
    docs = "https://docs.arcade.dev"

    def accepts(self, kind, args):
        return "." in str(args.get("tool", ""))

    def _headers(self):
        return {"Authorization": f"Bearer {envfiles.secret('ARCADE_API_KEY')}", "Content-Type": "application/json"}

    async def _read_only(self, tool, timeout) -> bool:
        try:
            spec = (await http(self.name, "GET", f"{ARCADE_API}/tools/{tool}", timeout=timeout, headers=self._headers())).json()
            flag = ((spec.get("metadata") or {}).get("behavior") or {}).get("read_only")
            if isinstance(flag, bool):
                return flag
        except ToolError as err:
            if err.code == "auth":
                raise
        name = tool.split(".", 1)[-1]
        return bool(ARCADE_READ_VERB.search(tool)) and not ARCADE_WRITE_WORD.search(name)

    async def run(self, kind, args, budget, timeout):
        """args: tool (e.g. Gmail.ListEmails), arguments, approved."""
        tool, user = str(args["tool"]), args.get("user_id", COMPOSIO_USER)
        if not args.get("approved") and not await self._read_only(tool, timeout):
            raise ToolError(self.name, f"{tool} can change something, so it needs your approval first", code="needs_approval", retry_elsewhere=False)
        auth = (await http(self.name, "POST", f"{ARCADE_API}/tools/authorize", timeout=timeout, headers=self._headers(), json={"tool_name": tool, "user_id": user})).json()
        if auth.get("status") not in (None, "completed"):
            raise ToolError(self.name, f"Sign in to use {tool.split('.')[0]}: {auth.get('url')}", code="needs_authorization", retry_elsewhere=False)
        res = (await http(self.name, "POST", f"{ARCADE_API}/tools/execute", timeout=timeout, retries=0, headers=self._headers(),
                          json={"tool_name": tool, "input": args.get("arguments") or {}, "user_id": user})).json()
        out = res.get("output") or {}
        if not res.get("success", False) or out.get("error"):
            raise ToolError(self.name, f"{tool} failed: {str((out.get('error') or {}).get('message') or res.get('status'))[:180]}", retry_elsewhere=False)
        return {"tool": tool, "data": out.get("value")}

    async def verify(self, timeout):
        res = await http(self.name, "GET", f"{ARCADE_API}/tools", timeout=timeout, headers=self._headers(), params={"limit": 1})
        total = res.json().get("total_count")
        return f"key accepted ({total} tools available)" if total is not None else "key accepted (tool list readable)"


class TriggerDev(Provider):
    name, label, env, kinds = "trigger", "Trigger.dev", ("TRIGGER_SECRET_KEY",), ("background_job",)
    cost = {"background_job": 0.0}
    docs = "https://trigger.dev/docs/management/overview"

    def _headers(self):
        return {"Authorization": f"Bearer {envfiles.secret('TRIGGER_SECRET_KEY')}", "Content-Type": "application/json"}

    async def run(self, kind, args, budget, timeout):
        """args: task (a task id deployed in your Trigger.dev project), payload."""
        res = await http(self.name, "POST", f"https://api.trigger.dev/api/v1/tasks/{args['task']}/trigger", timeout=timeout, retries=0,
                         headers=self._headers(), json={"payload": args.get("payload", {})})
        return {"run_id": res.json().get("id")}

    async def verify(self, timeout):
        res = await http(self.name, "GET", "https://api.trigger.dev/api/v1/runs", timeout=timeout, headers=self._headers(), params={"page[size]": 1})
        n = len(res.json().get("data") or [])
        return f"key accepted ({'runs found' if n else 'no runs yet'} in the project)"
