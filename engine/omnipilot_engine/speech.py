"""Speech to text on this computer, with Whisper (faster-whisper, int8 on the CPU): the mic button.

Whisper is the one model OmniPilot runs locally (everything else uses the Groq API), so
recordings are transcribed here and never leave the machine.

Limits: one transcription at a time, a short clip (the front door caps the upload at 256 KB,
about a minute of compressed audio), at most 60 seconds of speech, and a time limit. The model
("base", about 140 MB) downloads once on first use into server/data/models.
"""
from __future__ import annotations

import asyncio
import io
import os
import threading
from typing import Any, Awaitable, Callable

from . import config

MODEL_NAME = os.environ.get("OMNIPILOT_WHISPER_MODEL", "base")
MODEL_DIR = config.ROOT / "server" / "data" / "models" / "whisper"
MAX_SECONDS = 60
TIMEOUT_S = 90
MIN_BYTES = 1000

Transcriber = Callable[[bytes, str], Awaitable[str]]

_lock = asyncio.Lock()
_model: Any = None
_model_lock = threading.Lock()


def available() -> bool:
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        return False
    return True


def _load() -> Any:
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel  # imported lazily: it's large

            _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", download_root=str(MODEL_DIR))
    return _model


def _transcribe_sync(audio: bytes) -> str:
    segments, _info = _load().transcribe(io.BytesIO(audio), beam_size=1, vad_filter=True, condition_on_previous_text=False)
    words: list[str] = []
    for segment in segments:  # a generator: decoding happens while iterating
        if segment.start > MAX_SECONDS:
            break
        words.append(segment.text.strip())
    return " ".join(w for w in words if w)


async def _whisper(audio: bytes, _content_type: str) -> str:
    return await asyncio.to_thread(_transcribe_sync, audio)


async def transcribe(audio: bytes, content_type: str = "audio/webm", transcriber: Transcriber | None = None, cloud: Transcriber | None = None) -> dict[str, Any]:
    """On this computer first; Deepgram only when on-device speech can't run (see tools/providers/speech_cloud.py)."""
    result = await _local(audio, content_type, transcriber)
    if result["ok"] or result["error"] not in ("not_installed", "failed"):
        return {**result, "where": "local"} if result["ok"] else result
    from .tools.providers import speech_cloud

    if cloud is None and not speech_cloud.allowed():
        return result
    try:
        if cloud:
            text = (await cloud(audio, content_type)).strip()
        else:
            from .tools.router import run

            text = (await run("transcribe", {"audio": audio, "content_type": content_type}))["text"]
    except Exception:  # noqa: BLE001 -- report the on-device problem; the cloud one is a fallback
        return result
    if not text:
        return {"ok": False, "error": "empty", "message": "I didn't catch any words. Tap the mic and try again."}
    return {"ok": True, "text": text[:2000], "where": "deepgram"}


async def _local(audio: bytes, content_type: str, transcriber: Transcriber | None) -> dict[str, Any]:
    if len(audio) < MIN_BYTES:
        return {"ok": False, "error": "empty", "message": "I didn't hear anything. Tap the mic and try again."}
    if transcriber is None and not available():
        return {"ok": False, "error": "not_installed", "message": "On-device speech isn't installed. Restart OmniPilot with npm start to install it."}
    if _lock.locked():
        return {"ok": False, "error": "busy", "message": "Still working on the last recording."}
    async with _lock:
        try:
            text = (await asyncio.wait_for((transcriber or _whisper)(audio, content_type), TIMEOUT_S)).strip()
        except asyncio.TimeoutError:
            return {"ok": False, "error": "timeout", "message": "Turning that into text took too long. Try a shorter message."}
        except Exception as err:  # noqa: BLE001 -- unreadable audio, a failed model download...
            return {"ok": False, "error": "failed", "message": f"Couldn't turn that into text ({type(err).__name__})."}
    if not text:
        return {"ok": False, "error": "empty", "message": "I didn't catch any words. Tap the mic and try again."}
    return {"ok": True, "text": text[:2000]}
