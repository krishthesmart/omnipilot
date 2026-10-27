"""Semantic search over things the user asks OmniPilot to index (notes, documents), in their Qdrant
cluster. Embeddings are made on this computer by Ollama (nomic-embed-text), so only the vectors and the
text being indexed go to Qdrant; nothing is indexed unless the user asks."""
from __future__ import annotations

import hashlib
import os
import uuid

import httpx

from ..base import ToolError, http
from ... import envfiles
from . import Provider

COLLECTION = "omnipilot"


def embed_model() -> str:
    return os.environ.get("OMNIPILOT_EMBED_MODEL", "nomic-embed-text")


async def embed(texts: list[str], timeout: float) -> list[list[float]]:
    url = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/") + "/api/embed"
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(url, json={"model": embed_model(), "input": texts})
    except httpx.HTTPError:
        raise ToolError("qdrant", "Ollama isn't running on this computer, so nothing could be indexed", code="unavailable", retry_elsewhere=False)
    if r.status_code == 404:
        raise ToolError("qdrant", f"The local embedding model isn't installed: run  ollama pull {embed_model()}", code="unavailable", retry_elsewhere=False)
    r.raise_for_status()
    return r.json()["embeddings"]


class Qdrant(Provider):
    name, label, env, kinds = "qdrant", "Qdrant (vector search)", ("QDRANT_API_KEY", "QDRANT_ENDPOINT"), ("vector_upsert", "vector_search")
    cost = {"*": 0.0}
    docs = "https://api.qdrant.tech/api-reference"

    def _url(self, path: str) -> str:
        return envfiles.secret("QDRANT_ENDPOINT").rstrip("/") + path

    def _headers(self):
        return {"api-key": envfiles.secret("QDRANT_API_KEY"), "Content-Type": "application/json"}

    async def _ensure_collection(self, name: str, size: int, timeout: float) -> None:
        try:
            await http(self.name, "GET", self._url(f"/collections/{name}"), timeout=timeout, retries=0, headers=self._headers())
        except ToolError as err:
            if err.code == "auth":
                raise
            await http(self.name, "PUT", self._url(f"/collections/{name}"), timeout=timeout, headers=self._headers(), json={"vectors": {"size": size, "distance": "Cosine"}})

    async def run(self, kind, args, budget, timeout):
        collection = args.get("collection", COLLECTION)
        if kind == "vector_upsert":
            # args: items [{text, source?}] (or text). Point ids come from the text, so re-indexing is free of duplicates.
            items = args.get("items") or [{"text": args["text"], "source": args.get("source")}]
            items = [i for i in items if str(i.get("text", "")).strip()][:100]
            vectors = await embed([f"search_document: {i['text'][:8000]}" for i in items], timeout)
            await self._ensure_collection(collection, len(vectors[0]), timeout)
            points = [{"id": str(uuid.UUID(hashlib.sha256(i["text"].encode()).hexdigest()[:32])), "vector": v, "payload": {"text": i["text"][:8000], "source": i.get("source")}} for i, v in zip(items, vectors)]
            await http(self.name, "PUT", self._url(f"/collections/{collection}/points"), timeout=timeout, headers=self._headers(), params={"wait": "true"}, json={"points": points})
            return {"indexed": len(points), "collection": collection}
        vector = (await embed([f"search_query: {args['query'][:2000]}"], timeout))[0]
        try:
            res = await http(self.name, "POST", self._url(f"/collections/{collection}/points/query"), timeout=timeout, headers=self._headers(),
                             json={"query": vector, "limit": int(args.get("limit", 5)), "with_payload": True})
        except ToolError as err:
            if err.code == "auth":
                raise
            return {"matches": []}  # nothing indexed yet
        points = (res.json().get("result") or {}).get("points") or []
        return {"matches": [{"text": (p.get("payload") or {}).get("text", ""), "source": (p.get("payload") or {}).get("source"), "score": round(p.get("score", 0), 3)} for p in points]}

    async def verify(self, timeout):
        res = await http(self.name, "GET", self._url("/collections"), timeout=timeout, headers=self._headers())
        n = len((res.json().get("result") or {}).get("collections") or [])
        return f"key accepted ({n} collection(s))"
