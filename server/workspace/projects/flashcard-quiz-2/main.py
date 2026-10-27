"""
Entry point for the flashcard quiz web application.

This module starts two HTTP servers in separate threads:

* A static file server that serves the front‑end assets from the ``public`` directory.
* A JSON API server that exposes flashcard data and operations.

The :func:`run_servers` function blocks until a KeyboardInterrupt is received.
"""

import http.server
import threading
import time
from pathlib import Path
from functools import partial

from flashcards.api import run_api


def run_servers(port: int = 8000) -> None:
    """
    Start the static file server and the flashcard API server.

    Parameters
    ----------
    port : int, optional
        The base port number. The static server listens on ``port`` and the
        API server on ``port + 1``. Defaults to ``8000``.

    The function launches both servers in daemon threads and then blocks
    indefinitely until a KeyboardInterrupt is received. On interruption the
    process exits; the daemon threads terminate automatically.
    """
    static_port = port
    api_port = port + 1

    # Resolve the directory that contains the front‑end assets.
    static_dir = Path(__file__).parent / "public"
    if not static_dir.is_dir():
        raise FileNotFoundError(f"Static directory not found: {static_dir}")

    # ------------------------------------------------------------------
    # Static file server
    # ------------------------------------------------------------------
    def _start_static_server() -> None:
        """Run a simple HTTP server that serves files from ``static_dir``."""
        handler_cls = partial(http.server.SimpleHTTPRequestHandler, directory=str(static_dir))
        httpd = http.server.ThreadingHTTPServer(("", static_port), handler_cls)
        print(f"Static file server listening on http://localhost:{static_port}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            httpd.server_close()

    static_thread = threading.Thread(target=_start_static_server, daemon=True)
    static_thread.start()

    # ------------------------------------------------------------------
    # API server
    # ------------------------------------------------------------------
    api_thread = threading.Thread(target=run_api, args=(api_port,), daemon=True)
    api_thread.start()

    # ------------------------------------------------------------------
    # Keep the main thread alive until interrupted.
    # ------------------------------------------------------------------
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nShutting down servers.")


# If this module is executed directly, start the servers.
if __name__ == "__main__":
    run_servers()
