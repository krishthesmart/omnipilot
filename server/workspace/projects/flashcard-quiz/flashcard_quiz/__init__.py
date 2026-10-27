"""flashcard_quiz -- a simple command-line flashcard quiz application.

This package exposes the public API at the top level so callers can do::

    from flashcard_quiz import Card, Deck, QuizEngine
"""

from flashcard_quiz.card import Card
from flashcard_quiz.deck import Deck
from flashcard_quiz.engine import QuizEngine

__all__ = ["Card", "Deck", "QuizEngine"]
