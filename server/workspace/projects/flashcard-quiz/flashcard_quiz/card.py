"""flashcard_quiz.card
--------------------

Data model representing a single flashcard.

The :class:`Card` class is deliberately lightweight – it stores the *question*
and the *answer* as strings and provides a :meth:`check` method that determines
whether a user supplied response matches the stored answer.

The implementation is defensive: it validates input types, normalises whitespace
and performs a case‑insensitive comparison.  This behaviour is relied upon by
the unit‑tests in ``tests/test_card.test.py``.
"""

from __future__ import annotations

from dataclasses import dataclass


def _normalize(text: str) -> str:
    """Return a canonical representation of *text* for comparison.

    The function strips surrounding whitespace and collapses internal
    whitespace to a single space, then lower‑cases the result.  This mirrors
    typical expectations for flash‑card answer checking while remaining simple
    and deterministic.

    Args:
        text: The string to normalise.

    Returns:
        A normalised string.
    """
    # ``split`` without arguments collapses any whitespace sequence.
    return " ".join(text.split()).lower()


@dataclass(frozen=True, slots=True)
class Card:
    """A single flashcard consisting of a *question* and its *answer*.

    Attributes
    ----------
    question: str
        The prompt shown to the user.
    answer: str
        The correct answer; stored exactly as provided but compared in a
        case‑insensitive, whitespace‑insensitive manner.
    """

    question: str
    answer: str

    def __post_init__(self) -> None:
        # Validate that both fields are non‑empty strings.
        if not isinstance(self.question, str):
            raise TypeError("question must be a string")
        if not isinstance(self.answer, str):
            raise TypeError("answer must be a string")
        if self.question.strip() == "":
            raise ValueError("question cannot be empty or whitespace only")
        if self.answer.strip() == "":
            raise ValueError("answer cannot be empty or whitespace only")

    def check(self, response: str) -> bool:
        """Return ``True`` if *response* matches the stored answer.

        Comparison is case‑insensitive and ignores leading/trailing whitespace
        as well as any extra internal whitespace.

        Parameters
        ----------
        response: str
            The user's answer.

        Returns
        -------
        bool
            ``True`` when the normalised *response* equals the normalised answer,
            otherwise ``False``.
        """
        if not isinstance(response, str):
            raise TypeError("response must be a string")
        return _normalize(response) == _normalize(self.answer)

    # A helpful ``repr`` aids debugging and appears in test failures.
    def __repr__(self) -> str:
        return f"Card(question={self.question!r}, answer={self.answer!r})"
