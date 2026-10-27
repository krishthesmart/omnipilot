"""Flashcard Quiz package initializer.

This module makes the ``flashcards`` package importable and exposes the
primary public symbols for convenience:

- :class:`flashcards.data.FlashcardStore`
- :class:`flashcards.api.FlashcardHandler`
- :func:`flashcards.api.run_api`

The package contains only standard‑library dependencies, so importing it
has no side effects.
"""

from .data import FlashcardStore  # noqa: F401
from .api import FlashcardHandler, run_api  # noqa: F401

__all__ = [
    "FlashcardStore",
    "FlashcardHandler",
    "run_api",
]
