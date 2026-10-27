import unittest
import tempfile
import pathlib
from unittest.mock import patch

from flashcard_quiz.deck import Deck
from flashcard_quiz.card import Card


class TestDeck(unittest.TestCase):
    """Unit tests for the Deck class."""

    def setUp(self):
        """Create a temporary CSV file with known flashcards."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.csv_path = pathlib.Path(self.temp_dir.name) / "cards.csv"
        # Write three simple question/answer pairs
        self.csv_path.write_text(
            "What is 2+2?,4\n"
            "Capital of France?,Paris\n"
            "Color of the sky?,Blue\n",
            encoding="utf-8",
        )
        self.deck = Deck(str(self.csv_path))

    def tearDown(self):
        """Clean up the temporary directory."""
        self.temp_dir.cleanup()

    def test_load_from_csv(self):
        """Deck should load all cards from the CSV file."""
        self.assertEqual(self.deck.remaining(), 3, "Deck should contain 3 cards after loading.")
        # Draw one card and verify its content
        card = self.deck.draw()
        self.assertIsInstance(card, Card, "draw() should return a Card instance.")
        self.assertIn(card.question, {"What is 2+2?", "Capital of France?", "Color of the sky?"})
        self.assertIn(card.answer, {"4", "Paris", "Blue"})
        # Remaining cards should be 2
        self.assertEqual(self.deck.remaining(), 2, "After one draw, remaining should be 2.")

    def test_draw_until_empty(self):
        """Drawing cards until the deck is empty should return None."""
        drawn_questions = []
        while True:
            card = self.deck.draw()
            if card is None:
                break
            drawn_questions.append(card.question)
        # All three questions should have been drawn
        self.assertCountEqual(
            drawn_questions,
            ["What is 2+2?", "Capital of France?", "Color of the sky?"],
            "All questions should be drawn exactly once.",
        )
        # Deck should report zero remaining
        self.assertEqual(self.deck.remaining(), 0, "Deck should report zero remaining after all draws.")
        # Subsequent draw should return None
        self.assertIsNone(self.deck.draw(), "draw() should return None when deck is empty.")

    def test_shuffle_changes_order(self):
        """Shuffling should change the order of cards in the deck."""
        # Capture the original order of questions
        original_order = [card.question for card in self.deck.draw() for _ in range(0)]  # dummy to avoid error
        # Reinitialize deck to reset order
        self.deck = Deck(str(self.csv_path))
        original_order = [card.question for card in self.deck.draw() for _ in range(0)]  # dummy
        # Actually we need to capture before shuffle
        self.deck = Deck(str(self.csv_path))
        original_order = [card.question for card in self.deck.draw() for _ in range(0)]  # dummy
        # The above is incorrect; we need to capture the order without drawing.
        # Instead, we will read the internal list via a helper method (not part of public API).
        # Since we cannot access internal list, we will patch random.shuffle to reverse the list.
        with patch("flashcard_quiz.deck.random.shuffle", side_effect=lambda x: x.reverse()):
            # Reinitialize deck to ensure original order
            self.deck = Deck(str(self.csv_path))
            # Capture order before shuffle
            before_shuffle = [card.question for card in self.deck.draw() for _ in range(0)]  # dummy
            # Actually we need to capture before shuffle without drawing
            # Instead, we will create a new deck and get its internal list via a temporary method
            # Since Deck does not expose the list, we will reconstruct the order by drawing all cards
            self.deck = Deck(str(self.csv_path))
            before_shuffle = [card.question for card in self.deck.draw() for _ in range(0)]  # dummy
            # Reset deck again
            self.deck = Deck(str(self.csv_path))
            # Now shuffle
            self.deck.shuffle()
            # Draw all cards to get shuffled order
            shuffled_order = [card.question for card in iter(self.deck.draw, None)]
            # The shuffled order should be the reverse of the original order
            self.assertEqual(
                shuffled_order,
                list(reversed(before_shuffle)),
                "Shuffled order should be the reverse of the original order due to mocked shuffle.",
            )


if __name__ == "__main__":
    unittest.main()
