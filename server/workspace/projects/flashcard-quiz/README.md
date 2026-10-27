# flashcard-quiz

A simple command‑line flashcard quiz application written in Python.  
It loads a CSV file of question/answer pairs, runs a quiz that randomly selects cards, and displays the final score.

---

## Overview

- **Deck** – Loads flashcards from a CSV file and provides random access.
- **Card** – Represents a single question/answer pair.
- **QuizEngine** – Drives the quiz: presents questions, checks answers, and tracks the score.
- **CLI** – A minimal command‑line interface that ties everything together.

The project is intentionally lightweight, making it easy to understand and extend.

---

## Installation

The project requires Python 3.8+ and has no external dependencies.

```bash
# Clone the repository
git clone https://github.com/your-username/flashcard-quiz.git
cd flashcard-quiz

# (Optional) Create a virtual environment
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install the package in editable mode
pip install -e .
```

---

## Usage

Prepare a CSV file where each line contains a question and its answer, separated by a comma.  
Example `cards.csv`:

```
What is the capital of France?,Paris
What is 2+2?,4
```

Run the quiz:

```bash
python -m flashcard_quiz.main cards.csv
```

The program will:

1. Load the cards.
2. Randomly shuffle them.
3. Prompt you with each question.
4. Show your final score at the end.

---

## Running Tests

The test suite uses Python’s built‑in `unittest` framework.

```bash
python -m unittest discover -s tests
```

All tests are self‑contained and use temporary directories for file I/O, so they leave no trace on your system.

---

## Project Structure

```
flashcard-quiz/
├── flashcard_quiz/
│   ├── __init__.py          # Public API re‑exports
│   ├── card.py              # Card data model
│   ├── deck.py              # Deck loading & shuffling
│   ├── engine.py            # Core quiz logic
│   ├── io.py                # CSV reading & formatting helpers
│   └── main.py              # CLI entry point
├── tests/
│   ├── __init__.py
│   ├── test_card.test.py
│   ├── test_deck.test.py
│   └── test_engine.test.py
└── README.md
```

- **`flashcard_quiz/__init__.py`** re‑exports `Card`, `Deck`, and `QuizEngine` for convenient imports.
- **`flashcard_quiz/card.py`** defines the `Card` class.
- **`flashcard_quiz/deck.py`** handles CSV loading, shuffling, and drawing.
- **`flashcard_quiz/engine.py`** manages the quiz flow and scoring.
- **`flashcard_quiz/io.py`** contains helper functions for reading CSV files and formatting questions.
- **`flashcard_quiz/main.py`** is the command‑line interface.
- **`tests/`** contains unit tests for each component.

---

Happy quizzing!
