"""In-memory storage of flashcards with optional JSON file loading."""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any


# Built-in sample set used when no source file is provided.
_SAMPLE_CARDS: list[dict[str, str]] = [
    {"question": "What is the capital of France?", "answer": "Paris"},
    {"question": "What is 2 + 2?", "answer": "4"},
    {"question": "Which planet is known as the Red Planet?", "answer": "Mars"},
    {"question": "What is the chemical symbol for water?", "answer": "H2O"},
    {"question": "Who wrote 'Romeo and Juliet'?", "answer": "William Shakespeare"},
]


class FlashcardStore:
    """A simple in-memory collection of flashcards.

    Each card is a dict with the keys ``"question"`` and ``"answer"``.
    """

    def __init__(self, source: str | None = None) -> None:
        """Initialise the store.

        Args:
            source: Optional path to a JSON file containing a list of cards.
                If ``None`` (the default), a built-in sample set is used.

        Raises:
            FileNotFoundError: If ``source`` is given but the file does not exist.
            ValueError: If the JSON file does not contain a list of valid cards.
        """
        self._cards: list[dict[str, str]] = []

        if source is not None:
            self._load_from_file(source)
        else:
            # Copy the sample set so external mutation of the module constant
            # does not affect the store.
            self._cards = [dict(card) for card in _SAMPLE_CARDS]

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _load_from_file(self, source: str) -> None:
        """Load cards from a JSON file.

        The file must contain a JSON array of objects, each with string
        ``"question"`` and ``"answer"`` fields.
        """
        path = Path(source)
        if not path.exists():
            raise FileNotFoundError(f"Flashcard source file not found: {source}")

        try:
            raw = path.read_text(encoding="utf-8")
            data: Any = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON in flashcard source file: {exc}") from exc

        if not isinstance(data, list):
            raise ValueError("Flashcard source file must contain a JSON array of cards.")

        cards: list[dict[str, str]] = []
        for index, item in enumerate(data):
            if not isinstance(item, dict):
                raise ValueError(f"Card at index {index} is not a JSON object.")
            question = item.get("question")
            answer = item.get("answer")
            if not isinstance(question, str) or not isinstance(answer, str):
                raise ValueError(
                    f"Card at index {index} must have string 'question' and 'answer' fields."
                )
            cards.append({"question": question, "answer": answer})

        self._cards = cards

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def get_random(self) -> dict:
        """Return a random card as ``{"question": str, "answer": str}``.

        Raises:
            ValueError: If the store is empty.
        """
        if not self._cards:
            raise ValueError("Cannot get a random card from an empty store.")
        return dict(random.choice(self._cards))

    def check_answer(self, card: dict, answer: str) -> bool:
        """Check whether ``answer`` matches the card's answer.

        The comparison is case-insensitive and ignores surrounding whitespace.

        Args:
            card: A card dict with an ``"answer"`` key.
            answer: The user-supplied answer string.

        Returns:
            ``True`` if the answer is correct, ``False`` otherwise.
        """
        expected = card.get("answer", "")
        if not isinstance(expected, str):
            return False
        return expected.strip().lower() == answer.strip().lower()

    def add_card(self, question: str, answer: str) -> None:
        """Add a new card to the store.

        Args:
            question: The question text.
            answer: The answer text.
        """
        self._cards.append({"question": question, "answer": answer})

    def to_json(self) -> str:
        """Serialise the current store to a JSON string.

        Returns:
            A JSON array of card objects.
        """
        return json.dumps(self._cards, ensure_ascii=False, indent=2)
