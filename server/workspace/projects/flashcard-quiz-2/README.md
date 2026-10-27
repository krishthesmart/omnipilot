# Flashcard Quiz Web App

A minimal flashcard quiz web application written **only with the Python standard library**.  
The project serves a static HTML front‑end and provides a tiny JSON API for flashcard data.  
All logic (storage, API handling, and server orchestration) is implemented in pure Python, making the app easy to run, test, and extend without any external dependencies.

## Table of Contents

- [Features](#features)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation & Setup](#installation--setup)
- [Running the Application](#running-the-application)
- [Running the Test Suite](#running-the-test-suite)
- [API Overview](#api-overview)
- [Extending the App](#extending-the-app)
- [License](#license)

---

## Features

- **Static front‑end** served from the `public/` directory (HTML, CSS, JavaScript).
- **JSON API** with three endpoints:
  - `GET /card` – fetch a random question.
  - `POST /check` – verify an answer.
  - `POST /add` – add a new flashcard.
- **In‑memory flashcard store** with optional JSON file persistence.
- **Threaded servers** – a simple static file server (port 8000) and an API server (port 8001) run concurrently.
- **Comprehensive unit & integration tests** using only `unittest` and the standard library HTTP client.

---

## Project Structure

```
flashcard-quiz/
├─ flashcards/
│   ├─ __init__.py          # Makes the package importable
│   ├─ data.py              # FlashcardStore implementation
│   └─ api.py               # HTTP JSON API handler
├─ public/
│   ├─ index.html           # UI markup
│   ├─ style.css            # Basic styling
│   └─ app.js               # Front‑end logic (fetch API)
├─ tests/
│   ├─ test_data.py         # Unit tests for FlashcardStore
│   └─ test_api.py          # Integration tests for the API
├─ main.py                  # Entry point – starts both servers
└─ README.md                # This documentation
```

---

## Prerequisites

- **Python 3.9+** (the code uses type hints and `pathlib` features available in recent versions).
- No third‑party packages are required.

---

## Installation & Setup

1. **Clone the repository** (or copy the source files into a directory of your choice).

   ```bash
   git clone https://github.com/yourusername/flashcard-quiz.git
   cd flashcard-quiz
   ```

2. (Optional) Create a virtual environment to keep the environment clean.

   ```bash
   python -m venv venv
   source venv/bin/activate   # On Windows: venv\Scripts\activate
   ```

3. Verify that the required Python version is available:

   ```bash
   python --version
   ```

   The command should output `Python 3.9` or newer.

---

## Running the Application

The project launches **two HTTP servers**:

- **Static file server** – serves the front‑end from `public/` on **port 8000**.
- **API server** – handles flashcard requests on **port 8001**.

Run both servers with a single command:

```bash
python -m http.server 8000 --directory public &
python main.py
```

*Explanation*:

- The first command starts a simple file server that serves `public/index.html` and related assets.
- `main.py` starts the API server in a background thread and keeps the process alive.

Open your browser and navigate to `http://localhost:8000`. The UI will load, request a random question from the API, and allow you to answer or add new cards.

### Custom Ports

If you need to use different ports, you can call the helper directly:

```bash
python -c "import main; main.run_servers(port=8080)"
```

- The static server will listen on `port` (default 8000).
- The API server will always listen on `port + 1` (default 8001).

---

## Running the Test Suite

All tests are written with the standard library `unittest` framework and do **not** require network access beyond the local API server started by the test harness.

```bash
python -m unittest discover -s tests
```

The command discovers `test_*.py` files inside the `tests/` directory, runs them, and reports the results. The test suite includes:

- **Unit tests** for `FlashcardStore` (random selection, answer checking, adding cards, JSON serialization).
- **Integration tests** for the API endpoints (GET `/card`, POST `/check`, POST `/add`).

The tests use a temporary directory (`tempfile.TemporaryDirectory`) for any file I/O, ensuring a clean environment on each run.

---

## API Overview

| Method | Path   | Description                              | Request Body (JSON)                     | Response (JSON)                     |
|--------|--------|------------------------------------------|----------------------------------------|-------------------------------------|
| GET    | `/card`| Returns a random flashcard (question only). | *none*                                 | `{ "question": "What is …?" }`      |
| POST   | `/check`| Checks a submitted answer.               | `{ "question": "...", "answer": "…" }` | `{ "correct": true|false }`         |
| POST   | `/add` | Adds a new flashcard to the store.       | `{ "question": "...", "answer": "…" }` | `{ "status": "added" }`             |

All endpoints return `application/json` and use UTF‑8 encoding. Errors (e.g., malformed JSON or unknown paths) result in a `400 Bad Request` with a JSON error description.

---

## Extending the App

- **Persisting cards**: Pass a file path to `FlashcardStore(source="cards.json")` to load/save cards from a JSON file. The `to_json()` method can be used to write the current store back to disk.
- **Custom UI**: Modify `public/index.html`, `style.css`, or `app.js` to change the look and feel or add new interactions.
- **Additional API endpoints**: Extend `flashcards/api.py` by adding new routes in `FlashcardHandler.do_GET` or `do_POST`. Remember to keep the implementation within the standard library.

---

## License

This project is released under the **MIT License** – feel free to use, modify, and distribute it as you see fit.

--- 

*Happy coding! 🎉*  
