import json
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from .data import FlashcardStore

# Global flashcard store shared by all handler instances.
_store = FlashcardStore()
_store_lock = threading.Lock()  # protect mutations (add)


def _json_response(handler: BaseHTTPRequestHandler, data, status=HTTPStatus.OK):
    """Send a JSON response with the given status code."""
    payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def _read_json_body(handler: BaseHTTPRequestHandler):
    """Read and decode a JSON body from the request."""
    length = int(handler.headers.get("Content-Length", 0))
    if length == 0:
        raise ValueError("Empty request body")
    raw = handler.rfile.read(length)
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON: {exc}") from exc


def _find_card_by_question(question: str):
    """Return the stored card dict matching *question* or None."""
    # FlashcardStore keeps its cards in a private list; we access it safely
    # via the public API where possible. Since the spec does not expose a
    # lookup method, we perform a linear search on the internal attribute.
    # This is acceptable for the tiny in‑memory store used here.
    for card in getattr(_store, "_cards", []):
        if card.get("question") == question:
            return card
    return None


class FlashcardHandler(BaseHTTPRequestHandler):
    """HTTP handler exposing a tiny JSON API for flashcards."""

    # Suppress default logging; uncomment for debugging.
    # def log_message(self, format, *args):
    #     super().log_message(format, *args)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path != "/card":
            _json_response(self, {"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return

        with _store_lock:
            card = _store.get_random()
        # Only expose the question; the answer stays server‑side.
        _json_response(self, {"question": card["question"]})

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            payload = _read_json_body(self)
        except ValueError as exc:
            _json_response(self, {"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return

        if parsed.path == "/check":
            self._handle_check(payload)
        elif parsed.path == "/add":
            self._handle_add(payload)
        else:
            _json_response(self, {"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def _handle_check(self, payload):
        if not isinstance(payload, dict):
            _json_response(self, {"error": "Invalid payload"}, HTTPStatus.BAD_REQUEST)
            return

        question = payload.get("question")
        answer = payload.get("answer")
        if not isinstance(question, str) or not isinstance(answer, str):
            _json_response(
                self,
                {"error": "Both 'question' and 'answer' must be strings"},
                HTTPStatus.BAD_REQUEST,
            )
            return

        card = _find_card_by_question(question)
        if card is None:
            # Unknown question – treat as incorrect.
            _json_response(self, {"correct": False})
            return

        correct = _store.check_answer(card, answer)
        _json_response(self, {"correct": correct})

    def _handle_add(self, payload):
        if not isinstance(payload, dict):
            _json_response(self, {"error": "Invalid payload"}, HTTPStatus.BAD_REQUEST)
            return

        question = payload.get("question")
        answer = payload.get("answer")
        if not isinstance(question, str) or not isinstance(answer, str):
            _json_response(
                self,
                {"error": "Both 'question' and 'answer' must be strings"},
                HTTPStatus.BAD_REQUEST,
            )
            return

        with _store_lock:
            _store.add_card(question, answer)
        _json_response(self, {"added": True}, HTTPStatus.CREATED)


def run_api(port: int = 8001) -> None:
    """Start the flashcard JSON API server.

    The server runs in the current thread and blocks until interrupted.
    """
    server_address = ("", port)
    httpd = ThreadingHTTPServer(server_address, FlashcardHandler)
    try:
        print(f"Flashcard API listening on http://localhost:{port}")
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down API server.")
    finally:
        httpd.server_close()
