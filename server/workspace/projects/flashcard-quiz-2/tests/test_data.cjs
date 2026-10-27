"""Unit tests for the flashcard storage logic."""

import json
import os
import tempfile
import unittest
from pathlib import Path

from flashcards.data import FlashcardStore, _SAMPLE_CARDS


class TestFlashcardStore(unittest.TestCase):
    """Test the FlashcardStore implementation."""

    def setUp(self) -> None:
        """Create a fresh store for each test."""
        self.store = FlashcardStore()

    # ------------------------------------------------------------------
    # Basic functionality
    # ------------------------------------------------------------------
    def test_initialise_with_none_source(self) -> None:
        """Store should contain the built‑in sample set when no source is given."""
        self.assertEqual(len(self.store._cards), len(_SAMPLE_CARDS))
        # Ensure a copy was made
        self.store._cards[0]["question"] = "Modified"
        self.assertNotEqual(_SAMPLE_CARDS[0]["question"], "Modified")

    def test_get_random_returns_card(self) -> None:
        """get_random should return a card dict with question and answer."""
        card = self.store.get_random()
        self.assertIsInstance(card, dict)
        self.assertIn("question", card)
        self.assertIn("answer", card)
        # Ensure the returned card is a copy
        card["question"] = "Changed"
        self.assertNotEqual(self.store._cards[0]["question"], "Changed")

    def test_get_random_empty_store_raises(self) -> None:
        """get_random should raise ValueError if the store is empty."""
        self.store._cards.clear()
        with self.assertRaises(ValueError):
            self.store.get_random()

    def test_check_answer_case_insensitive(self) -> None:
        """check_answer should ignore case and surrounding whitespace."""
        card = {"question": "Q", "answer": "Answer"}
        self.assertTrue(self.store.check_answer(card, "answer"))
        self.assertTrue(self.store.check_answer(card, "  ANSWER  "))
        self.assertFalse(self.store.check_answer(card, "wrong"))

    def test_add_card_increases_count(self) -> None:
        """add_card should append a new card to the store."""
        initial_len = len(self.store._cards)
        self.store.add_card("New Q", "New A")
        self.assertEqual(len(self.store._cards), initial_len + 1)
        self.assertEqual(self.store._cards[-1], {"question": "New Q", "answer": "New A"})

    def test_to_json_serialises_store(self) -> None:
        """to_json should return a JSON string representing the store."""
        json_str = self.store.to_json()
        data = json.loads(json_str)
        self.assertIsInstance(data, list)
        self.assertEqual(len(data), len(self.store._cards))
        self.assertEqual(data, self.store._cards)

    # ------------------------------------------------------------------
    # Loading from file
    # ------------------------------------------------------------------
    def test_load_from_valid_file(self) -> None:
        """Initialising with a valid JSON file should load its cards."""
        sample = [
            {"question": "Q1", "answer": "A1"},
            {"question": "Q2", "answer": "A2"},
        ]
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as tmp:
            json.dump(sample, tmp)
            tmp_path = Path(tmp.name)

        try:
            store = FlashcardStore(str(tmp_path))
            self.assertEqual(len(store._cards), 2)
            self.assertEqual(store._cards, sample)
        finally:
            os.unlink(tmp_path)

    def test_load_from_missing_file_raises(self) -> None:
        """Providing a non‑existent file path should raise FileNotFoundError."""
        with self.assertRaises(FileNotFoundError):
            FlashcardStore("nonexistent_file.json")

    def test_load_from_invalid_json_raises(self) -> None:
        """Invalid JSON content should raise ValueError."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as tmp:
            tmp.write("not a json")
            tmp_path = Path(tmp.name)

        try:
            with self.assertRaises(ValueError):
                FlashcardStore(str(tmp_path))
        finally:
            os.unlink(tmp_path)

    def test_load_from_non_list_json_raises(self) -> None:
        """JSON that is not a list should raise ValueError."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as tmp:
            json.dump({"question": "Q", "answer": "A"}, tmp)
            tmp_path = Path(tmp.name)

        try:
            with self.assertRaises(ValueError):
                FlashcardStore(str(tmp_path))
        finally:
            os.unlink(tmp_path)

    def test_load_from_invalid_card_structure_raises(self) -> None:
        """Each item must be a dict with string question and answer."""
        bad_data = [
            {"question": "Q1", "answer": 123},  # answer not string
            {"question": 456, "answer": "A2"},  # question not string
            "just a string",
        ]
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as tmp:
            json.dump(bad_data, tmp)
            tmp_path = Path(tmp.name)

        try:
            with self.assertRaises(ValueError):
                FlashcardStore(str(tmp_path))
        finally:
            os.unlink(tmp_path)


if __name__ == "__main__":
    unittest.main()
