"""Attached documents as text, private by default: PDFs are read on this computer (pypdf). Only Word and
PowerPoint files, or a PDF with no text layer (a scan), go to LlamaParse, and only if it's set up."""
from __future__ import annotations

import asyncio
import io
import re

from ..tools import router as tools
from ..tools.base import Budget

MAX_BYTES = 15_000_000
CLOUD_EXT = re.compile(r"\.(docx|pptx|doc|ppt|xlsx|rtf|odt|epub)$", re.I)


class Unsupported(Exception):
    pass


def _pdf_text(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    pages = []
    for i, page in enumerate(reader.pages[:200]):
        t = (page.extract_text() or "").strip()
        if t:
            pages.append(f"[Page {i + 1}]\n{t}")
    return "\n\n".join(pages)


async def _cloud(name: str, data: bytes) -> str:
    if not tools.PROVIDERS["llamaparse"].configured():
        raise Unsupported("Reading this kind of file needs LlamaParse (LLAMAINDEX_API_KEY), which isn't set up.")
    out = await tools.run("parse_document", {"filename": name, "content": data}, Budget(max_calls=1, deadline_s=200))
    return out.get("markdown") or out.get("text") or ""


async def to_text(name: str, data: bytes) -> tuple[str, str]:
    """(text, where it was read: "local" or "llamaparse")."""
    if len(data) > MAX_BYTES:
        raise Unsupported("That file is too big (the limit is 15 MB).")
    if data[:5] == b"%PDF-" or name.lower().endswith(".pdf"):
        try:
            text = await asyncio.to_thread(_pdf_text, data)
        except Exception as e:  # noqa: BLE001 -- a damaged PDF
            raise Unsupported(f"That PDF couldn't be read ({type(e).__name__}).")
        if len(text.strip()) >= 40:
            return text, "local"
        return await _cloud(name, data), "llamaparse"  # a scan: no text layer
    if CLOUD_EXT.search(name):
        return await _cloud(name, data), "llamaparse"
    try:
        return data.decode("utf-8"), "local"
    except UnicodeDecodeError:
        raise Unsupported("Attach a PDF, Word, PowerPoint or text file.")
