"""Speech to text in the cloud with Deepgram: only a fallback for when on-device Whisper can't run
(not installed, or it failed), and never if OMNIPILOT_CLOUD_SPEECH=0. The recording goes to Deepgram."""
from __future__ import annotations

import os

from ..base import http
from ... import envfiles
from . import Provider


def allowed() -> bool:
    return os.environ.get("OMNIPILOT_CLOUD_SPEECH", "1") != "0" and envfiles.is_set("DEEPGRAM_API_KEY")


class Deepgram(Provider):
    name, label, env, kinds = "deepgram", "Deepgram (speech fallback)", ("DEEPGRAM_API_KEY",), ("transcribe",)
    cost = {"transcribe": 0.005}
    docs = "https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded"

    def _auth(self):
        return {"Authorization": f"Token {envfiles.secret('DEEPGRAM_API_KEY')}"}

    async def run(self, kind, args, budget, timeout):
        """args: audio (bytes), content_type."""
        res = await http(self.name, "POST", "https://api.deepgram.com/v1/listen", timeout=timeout, retries=1,
                         params={"model": "nova-3", "smart_format": "true"}, headers={**self._auth(), "Content-Type": args.get("content_type") or "audio/webm"}, content=args["audio"])
        alts = (((res.json().get("results") or {}).get("channels") or [{}])[0].get("alternatives") or [{}])
        return {"text": (alts[0].get("transcript") or "").strip()}

    async def verify(self, timeout):
        res = await http(self.name, "GET", "https://api.deepgram.com/v1/projects", timeout=timeout, headers=self._auth())
        return f"key accepted ({len(res.json().get('projects') or [])} project(s))"
