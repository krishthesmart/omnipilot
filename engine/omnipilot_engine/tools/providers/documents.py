"""Turning documents (PDF, Word, slides, spreadsheets, images) into text: LlamaParse (LlamaIndex's
LlamaCloud). The file is uploaded to LlamaCloud for parsing."""
from __future__ import annotations

import asyncio

from ..base import ToolError, http
from ... import envfiles
from . import Provider

API = "https://api.cloud.llamaindex.ai/api/v1"
API2 = "https://api.cloud.llamaindex.ai/api/v2"


def _markdown(full: dict) -> str:
    """The parsed text, wherever this API version puts it (a string, or pages with markdown)."""
    for key in ("markdown_full", "markdown"):
        v = full.get(key)
        if isinstance(v, str):
            return v
        if isinstance(v, dict):
            for inner in ("markdown", "content", "text"):
                if isinstance(v.get(inner), str):
                    return v[inner]
            pages = v.get("pages")
            if isinstance(pages, list):
                return "\n\n".join(str(p.get("markdown") or p.get("md") or "") for p in pages if isinstance(p, dict))
        if isinstance(v, list):
            return "\n\n".join(str(p.get("markdown") or p.get("md") or p) if isinstance(p, dict) else str(p) for p in v)
    return ""


class LlamaParse(Provider):
    name, label, env, kinds = "llamaparse", "LlamaParse (LlamaIndex)", ("LLAMAINDEX_API_KEY",), ("parse_document",)
    cost = {"parse_document": 0.01}
    docs = "https://docs.cloud.llamaindex.ai/llamaparse/getting_started"

    def _headers(self):
        return {"Authorization": f"Bearer {envfiles.secret('LLAMAINDEX_API_KEY')}"}

    async def run(self, kind, args, budget, timeout):
        """args: filename, content (bytes, or base64 text). Uses the v2 Parse API, "cost_effective" tier."""
        import base64
        import json as _json

        data = args["content"] if isinstance(args["content"], (bytes, bytearray)) else base64.b64decode(args["content"])
        up = await http(
            self.name, "POST", f"{API2}/parse/upload", timeout=60, retries=0, headers=self._headers(),
            files={"file": (args.get("filename", "document"), data)},
            data={"configuration": _json.dumps({"tier": args.get("tier", "cost_effective"), "version": "latest"})},
        )
        body = up.json()
        job = body.get("id") or (body.get("job") or {}).get("id")
        if not job:
            raise ToolError(self.name, "LlamaParse didn't start the job")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            await asyncio.sleep(2)
            info = (await http(self.name, "GET", f"{API2}/parse/{job}", timeout=20, headers=self._headers())).json()
            status = (info.get("job") or info).get("status")
            if status == "COMPLETED":
                full = (await http(self.name, "GET", f"{API2}/parse/{job}", timeout=30, headers=self._headers(), params={"expand": "markdown_full"})).json()
                return {"markdown": _markdown(full)[:200_000], "job": job}
            if status in ("FAILED", "CANCELLED"):
                raise ToolError(self.name, f"LlamaParse couldn't parse the file ({status})", retry_elsewhere=False)
        raise ToolError(self.name, "LlamaParse took too long", code="timeout")

    async def verify(self, timeout):
        res = await http(self.name, "GET", f"{API}/projects", timeout=timeout, headers=self._headers())
        projects = res.json()
        return f"key accepted ({len(projects) if isinstance(projects, list) else 1} project)"
