#!/usr/bin/env python3
"""OmniPilot SDK for Python: one file, standard library only (works on a Raspberry Pi).

As a library:
    from omnipilot import OmniPilot
    op = OmniPilot()                                   # http://localhost:8899
    print(op.ask("Is (a+b)^2 = a^2 + b^2?")["answer"])
    for piece in op.stream("Explain magnets for a 4th grader"):
        print(piece, end="", flush=True)

From the command line:
    python3 omnipilot.py "How do I connect an LED to my Arduino?"
    python3 omnipilot.py              # chat, with follow-ups
    python3 omnipilot.py --check "sin(x)^2 + cos(x)^2 = 1"
    python3 omnipilot.py --discoveries

From another device, start OmniPilot with HOST=0.0.0.0 and OMNIPILOT_API_TOKEN, then set
OMNIPILOT_URL=http://<that computer's IP>:8899 and OMNIPILOT_TOKEN=<the token>.
"""

import json
import os
import sys
import urllib.error
import urllib.request
import uuid

__version__ = "1.2.0"
_DONE = {"final_response", "clarification_needed", "run_failed"}


class OmniPilotError(Exception):
    def __init__(self, message, status=0, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


class OmniPilot:
    def __init__(self, base_url=None, token=None, timeout=300):
        self.base_url = (base_url or os.environ.get("OMNIPILOT_URL") or "http://localhost:8899").rstrip("/")
        if not self.base_url.startswith(("http://", "https://")):
            raise ValueError("base_url must start with http:// or https://")
        self.token = token or os.environ.get("OMNIPILOT_TOKEN")
        self.timeout = timeout

    def _open(self, path, body=None, extra_headers=None):
        headers = dict(extra_headers or {})
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method="POST" if data else "GET")
        try:
            return urllib.request.urlopen(req, timeout=self.timeout)
        except urllib.error.HTTPError as err:
            try:
                payload = json.loads(err.read().decode("utf-8"))
            except ValueError:
                payload = {}
            raise OmniPilotError(payload.get("message") or payload.get("error") or "HTTP %d" % err.code, err.code, payload)
        except urllib.error.URLError as err:
            raise OmniPilotError("Can't reach OmniPilot at %s (%s). Is it running?" % (self.base_url, err.reason))

    def _json(self, path, body=None):
        with self._open(path, body) as res:
            return json.loads(res.read().decode("utf-8"))

    def ask(self, message, conversation_id=None, text_only=False):
        """Ask a question and wait for the whole answer (a dict with "answer", "confidence", "agents"...)."""
        body = {"message": message, "textOnly": bool(text_only)}
        if conversation_id:
            body["conversationId"] = conversation_id
        return self._json("/api/ask", body)

    def stream(self, message, conversation_id=None, on_event=None):
        """Yields the answer piece by piece as it's written. The final result is stored in self.last."""
        body = {"message": message}
        if conversation_id:
            body["conversationId"] = conversation_id
        started = self._json("/api/chat", body)
        run_id = started["runId"]
        # From another device (token), a run can only be read with the key returned when it was started.
        key = {"x-run-key": started["runKey"]} if started.get("runKey") else None
        self.last = None
        streamed = False
        with self._open("/api/runs/%s/events" % run_id, extra_headers=key) as res:
            data_lines = []
            for raw in res:
                line = raw.decode("utf-8").rstrip("\r\n")
                if line.startswith("data: "):
                    data_lines.append(line[6:])
                    continue
                if line or not data_lines:
                    continue  # heartbeat or blank
                event = json.loads("\n".join(data_lines))
                data_lines = []
                if on_event:
                    on_event(event)
                kind = event.get("type")
                if kind == "answer_delta":
                    streamed = True
                    yield event["delta"]
                elif kind in _DONE:
                    if kind == "run_failed":
                        raise OmniPilotError(event.get("error", "run failed"), 500, event)
                    if kind == "clarification_needed":
                        self.last = {"runId": run_id, "status": "needs_clarification", "answer": event["question"]}
                        yield event["question"]
                        return
                    response = event["response"]
                    self.last = {"runId": run_id, "status": "completed", "answer": response["summary"], "confidence": response["confidence"]}
                    # Answers that weren't composed by the model arrive in one piece.
                    if not streamed:
                        yield response["summary"]
                    return

    def conversation(self):
        """Returns a conversation id; pass it to ask()/stream() so follow-ups can refer back."""
        return "sdk-" + uuid.uuid4().hex

    def check_identity(self, equation):
        """MathPilot: checks "left = right" numerically. Returns {"verdict", "detail", ...}."""
        return self._json("/api/math/check", {"equation": equation})

    def math_status(self):
        return self._json("/api/math/status")

    def discoveries(self, after=0, limit=100):
        return self._json("/api/math/discoveries?after=%d&limit=%d" % (after, limit))["discoveries"]

    def status(self):
        return self._json("/api/status")


def _main(argv):
    op = OmniPilot()
    try:
        if argv[:1] == ["--check"] and len(argv) > 1:
            r = op.check_identity(" ".join(argv[1:]))
            print("%s: %s" % (r["verdict"].upper(), r["detail"]))
            return 0
        if argv[:1] == ["--discoveries"]:
            s = op.math_status()
            print("%s formulas checked, %d verified identities" % ("{:,}".format(s["checked"]), s["discoveries"]))
            for d in op.discoveries(limit=10):
                print("  " + d["text"].split("   [")[0])
            return 0
        if argv and not argv[0].startswith("--"):
            for piece in op.stream(" ".join(argv)):
                sys.stdout.write(piece)
                sys.stdout.flush()
            print()
            return 0
        if argv:
            print(__doc__)
            return 0
        conversation = op.conversation()
        print("OmniPilot chat (%s). Empty line or Ctrl+C to quit." % op.base_url)
        while True:
            question = input("\nyou> ").strip()
            if not question:
                return 0
            sys.stdout.write("omnipilot> ")
            for piece in op.stream(question, conversation_id=conversation):
                sys.stdout.write(piece)
                sys.stdout.flush()
            print()
    except OmniPilotError as err:
        print("error: %s" % err, file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print()
        return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
