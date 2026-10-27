"""Small text helpers with no dependencies (safe to import from anywhere in brain/)."""
from __future__ import annotations


def clip(text: str, limit: int) -> str:
    """Shortens text for display at a word boundary, with "…" (never "environment v")."""
    text = " ".join(str(text).split())
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0].rstrip(".,;:-–— ")
    return (cut or text[: limit - 1]) + "…"
