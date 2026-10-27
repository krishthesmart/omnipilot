"""On-device speech to text (local Whisper): the endpoint, its limits, and that audio never goes to the TypeScript engine."""
import asyncio
from dataclasses import replace

import httpx

from conftest import TOKEN
from omnipilot_engine import config, speech
from omnipilot_engine.app import create_app

AUDIO = b"\x1aE\xdf\xa3" + b"\0" * 4000  # a webm header and some bytes; the fake transcriber doesn't decode it


def client_with(node, transcriber, **overrides):
    settings = replace(config.load(), internal_token="internal-secret", api_token=TOKEN, allowed_origins=(), allow_any_host=False, **overrides)
    app = create_app(settings, transport=httpx.MockTransport(node), transcriber=transcriber)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost:8899")


async def test_transcribes_on_this_computer(node):
    heard = []
    async def fake(audio, content_type):
        heard.append((audio, content_type))
        return "  visit google  "

    async with client_with(node, fake) as c:
        assert (await c.get("/api/speech/status")).json()["available"] is True
        r = await c.post("/api/speech/transcribe", content=AUDIO, headers={"content-type": "audio/webm"})
    assert r.status_code == 200 and r.json() == {"ok": True, "text": "visit google", "where": "local"}
    assert heard == [(AUDIO, "audio/webm")]
    assert not any("speech" in req.url.path for req in node.requests)  # handled here, never forwarded


async def test_rejects_empty_and_silent_recordings(node):
    async def silent(audio, content_type):
        return ""

    async with client_with(node, silent) as c:
        assert (await c.post("/api/speech/transcribe", content=b"tiny")).status_code == 422
        r = await c.post("/api/speech/transcribe", content=AUDIO)
    assert r.status_code == 422 and r.json()["error"] == "empty"


async def test_failures_are_reported_plainly(node):
    async def broken(audio, content_type):
        raise RuntimeError("secret detail")

    async with client_with(node, broken) as c:
        r = await c.post("/api/speech/transcribe", content=AUDIO)
    assert r.status_code == 500 and "secret detail" not in r.text


async def test_local_only_and_size_limited(node):
    async def hi(audio, content_type):
        return "hi"

    async with client_with(node, hi) as c:
        assert (await c.post("/api/speech/transcribe", content=AUDIO, headers={"authorization": f"Bearer {TOKEN}"})).status_code == 403
        assert (await c.post("/api/speech/transcribe", content=AUDIO, headers={"origin": "https://evil.example"})).status_code == 403
        assert (await c.post("/api/speech/transcribe", content=b"\0" * (300 * 1024))).status_code == 413


async def test_one_at_a_time_with_a_time_limit(monkeypatch):
    monkeypatch.setattr(speech, "TIMEOUT_S", 0.2)

    async def slow(audio, content_type):
        await asyncio.sleep(0.5)
        return "late"
    first = asyncio.create_task(speech.transcribe(AUDIO, transcriber=slow))
    await asyncio.sleep(0.05)
    assert (await speech.transcribe(AUDIO, transcriber=slow))["error"] == "busy"
    assert (await first)["error"] == "timeout"



async def test_uses_the_local_whisper_model_not_a_network_service(monkeypatch):
    """The recording is transcribed on this computer: nothing is sent anywhere."""
    calls = []
    monkeypatch.setattr(speech, "_transcribe_sync", lambda audio: calls.append(audio) or "hello")
    monkeypatch.setattr(speech, "available", lambda: True)
    assert (await speech.transcribe(AUDIO)) == {"ok": True, "text": "hello", "where": "local"}
    assert calls == [AUDIO]
