"""Services that aren't tools agents call, but whose keys OmniPilot uses: Langfuse (tracing) and Groq
(the stronger AI model, used only when the local one isn't enough)."""
from __future__ import annotations

import base64

from ..base import http
from ... import envfiles
from . import Provider


class Langfuse(Provider):
    name, label, env, kinds = "langfuse", "Langfuse", ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"), ("tracing",)
    docs = "https://langfuse.com/docs"

    async def verify(self, timeout):
        base = (envfiles.secret("LANGFUSE_BASE_URL") or "https://cloud.langfuse.com").rstrip("/")
        auth = base64.b64encode(f"{envfiles.secret('LANGFUSE_PUBLIC_KEY')}:{envfiles.secret('LANGFUSE_SECRET_KEY')}".encode()).decode()
        res = await http(self.name, "GET", f"{base}/api/public/projects", timeout=timeout, headers={"Authorization": f"Basic {auth}"})
        return f"keys accepted ({len(res.json().get('data') or [])} project)"


class Groq(Provider):
    name, label, env, kinds = "groq", "Groq (strong AI, used when needed)", ("GROQ_API_KEY",), ("llm",)
    docs = "https://console.groq.com/docs"

    async def verify(self, timeout):
        res = await http(self.name, "GET", "https://api.groq.com/openai/v1/models", timeout=timeout, headers={"Authorization": f"Bearer {envfiles.secret('GROQ_API_KEY')}"})
        return f"key accepted ({len(res.json().get('data') or [])} models available)"
