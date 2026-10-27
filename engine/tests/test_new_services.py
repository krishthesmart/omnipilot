"""Arcade, Qdrant and Deepgram adapters, against fake services (nothing reaches a real provider)."""
import json

import pytest
import respx

from omnipilot_engine import speech
from omnipilot_engine.tools import base, router
from omnipilot_engine.tools.base import ToolError

NEW = ("ARCADE_API_KEY", "COMPOSIO_API_KEY", "QDRANT_API_KEY", "QDRANT_ENDPOINT", "DEEPGRAM_API_KEY")
QD = "https://qdrant.test:6333"
OLLAMA = "http://127.0.0.1:11434"
AUDIO = b"\x1aE\xdf\xa3" + b"0" * 2000


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("OMNIPILOT_TOOLS_DB", str(tmp_path / "tools.sqlite"))
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    base.reset_db_for_tests()
    for k in NEW:
        monkeypatch.delenv(k, raising=False)
    yield
    base.reset_db_for_tests()


# --- Arcade ---


@respx.mock
async def test_arcade_runs_read_only_tools_and_asks_approval_for_the_rest(monkeypatch):
    monkeypatch.setenv("ARCADE_API_KEY", "arc-test")
    respx.get("https://api.arcade.dev/v1/tools/Gmail.ListEmails").respond(json={"metadata": {"behavior": {"read_only": True}}})
    respx.get("https://api.arcade.dev/v1/tools/Gmail.SendEmail").respond(json={"metadata": {"behavior": {"read_only": False}}})
    respx.post("https://api.arcade.dev/v1/tools/authorize").respond(json={"status": "completed"})
    execute = respx.post("https://api.arcade.dev/v1/tools/execute").respond(json={"success": True, "output": {"value": {"emails": []}}})
    out = await router.run("app_action", {"tool": "Gmail.ListEmails", "arguments": {"n": 3}})
    assert out["provider"] == "arcade" and out["data"] == {"emails": []}
    sent = json.loads(execute.calls[0].request.content)
    assert sent == {"tool_name": "Gmail.ListEmails", "input": {"n": 3}, "user_id": "omnipilot-owner"}
    assert execute.calls[0].request.headers["authorization"] == "Bearer arc-test"
    with pytest.raises(ToolError) as e:
        await router.run("app_action", {"tool": "Gmail.SendEmail", "arguments": {}})
    assert e.value.code == "needs_approval" and execute.call_count == 1
    await router.run("app_action", {"tool": "Gmail.SendEmail", "arguments": {}, "approved": True})
    assert execute.call_count == 2


@respx.mock
async def test_arcade_returns_the_sign_in_link_before_running_anything(monkeypatch):
    monkeypatch.setenv("ARCADE_API_KEY", "arc-test")
    respx.get("https://api.arcade.dev/v1/tools/Slack.ListChannels").respond(json={})
    respx.post("https://api.arcade.dev/v1/tools/authorize").respond(json={"status": "pending", "url": "https://accounts.arcade.dev/x"})
    execute = respx.post("https://api.arcade.dev/v1/tools/execute")
    with pytest.raises(ToolError) as e:
        await router.run("app_action", {"tool": "Slack.ListChannels"})
    assert e.value.code == "needs_authorization" and "https://accounts.arcade.dev/x" in str(e.value)
    assert not execute.called


async def test_tool_names_pick_the_service(monkeypatch):
    monkeypatch.setenv("ARCADE_API_KEY", "a")
    monkeypatch.setenv("COMPOSIO_API_KEY", "c")
    assert router.PROVIDERS["arcade"].accepts("app_action", {"tool": "Gmail.ListEmails"})
    assert not router.PROVIDERS["composio"].accepts("app_action", {"tool": "Gmail.ListEmails"})
    assert router.PROVIDERS["composio"].accepts("app_action", {"tool": "GMAIL_FETCH_EMAILS"})
    monkeypatch.delenv("ARCADE_API_KEY")
    with pytest.raises(router.NoProvider):
        await router.run("app_action", {"tool": "Gmail.ListEmails"})


# --- Qdrant ---


@respx.mock
async def test_qdrant_embeds_locally_and_creates_the_collection_once(monkeypatch):
    monkeypatch.setenv("QDRANT_API_KEY", "qd-test")
    monkeypatch.setenv("QDRANT_ENDPOINT", QD)
    emb = respx.post(f"{OLLAMA}/api/embed").respond(json={"embeddings": [[0.1, 0.2, 0.3], [0.3, 0.2, 0.1]]})
    respx.get(f"{QD}/collections/omnipilot").respond(404, json={"status": {"error": "Not found"}})
    create = respx.put(f"{QD}/collections/omnipilot").respond(json={"result": True})
    upsert = respx.put(f"{QD}/collections/omnipilot/points").respond(json={"result": {"status": "completed"}})
    out = await router.run("vector_upsert", {"items": [{"text": "photosynthesis notes", "source": "bio.md"}, {"text": "algebra notes"}]})
    assert out["indexed"] == 2 and out["provider"] == "qdrant"
    assert json.loads(create.calls[0].request.content) == {"vectors": {"size": 3, "distance": "Cosine"}}
    points = json.loads(upsert.calls[0].request.content)["points"]
    assert points[0]["payload"] == {"text": "photosynthesis notes", "source": "bio.md"} and points[0]["vector"] == [0.1, 0.2, 0.3]
    assert upsert.calls[0].request.headers["api-key"] == "qd-test"
    assert json.loads(emb.calls[0].request.content)["model"] == "nomic-embed-text"
    # The same text gets the same id, so indexing it again replaces it instead of duplicating it.
    await router.run("vector_upsert", {"items": [{"text": "photosynthesis notes", "source": "bio.md"}, {"text": "algebra notes"}]})
    assert json.loads(upsert.calls[1].request.content)["points"][0]["id"] == points[0]["id"]


@respx.mock
async def test_qdrant_search_returns_matches_and_explains_a_missing_model(monkeypatch):
    monkeypatch.setenv("QDRANT_API_KEY", "qd-test")
    monkeypatch.setenv("QDRANT_ENDPOINT", QD)
    route = respx.post(f"{OLLAMA}/api/embed").respond(json={"embeddings": [[0.1, 0.2, 0.3]]})
    respx.post(f"{QD}/collections/omnipilot/points/query").respond(json={"result": {"points": [{"score": 0.91234, "payload": {"text": "photosynthesis notes", "source": "bio.md"}}]}})
    out = await router.run("vector_search", {"query": "how do plants eat"})
    assert out["matches"] == [{"text": "photosynthesis notes", "source": "bio.md", "score": 0.912}]
    route.respond(404, json={"error": "model not found"})
    with pytest.raises(ToolError) as e:
        await router.run("vector_search", {"query": "x"})
    assert "ollama pull nomic-embed-text" in str(e.value)


# --- Deepgram (speech fallback) ---


@respx.mock
async def test_deepgram_transcribes_with_the_key_as_a_token(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "dg-test")
    route = respx.post("https://api.deepgram.com/v1/listen").respond(json={"results": {"channels": [{"alternatives": [{"transcript": "hello there"}]}]}})
    out = await router.run("transcribe", {"audio": AUDIO, "content_type": "audio/webm"})
    assert out["text"] == "hello there"
    req = route.calls[0].request
    assert req.headers["authorization"] == "Token dg-test" and req.content == AUDIO and "model=nova-3" in str(req.url)


async def test_speech_stays_on_this_computer_when_whisper_works():
    async def whisper(audio, ct):
        return "local words"

    async def cloud(audio, ct):
        raise AssertionError("must not be called")

    assert await speech.transcribe(AUDIO, transcriber=whisper, cloud=cloud) == {"ok": True, "text": "local words", "where": "local"}


async def test_speech_uses_deepgram_only_when_whisper_fails():
    async def broken(audio, ct):
        raise RuntimeError("model download failed")

    async def cloud(audio, ct):
        return "cloud words"

    assert await speech.transcribe(AUDIO, transcriber=broken, cloud=cloud) == {"ok": True, "text": "cloud words", "where": "deepgram"}
    # Without a cloud fallback allowed (OMNIPILOT_CLOUD_SPEECH=0 in tests), the local error is reported.
    assert (await speech.transcribe(AUDIO, transcriber=broken))["error"] == "failed"


def test_app_tools_that_change_things_always_need_approval():
    """Found in the security review: a read word anywhere in the name used to make a tool run without asking."""
    from omnipilot_engine.tools.providers.apps import ARCADE_READ_VERB, ARCADE_WRITE_WORD, composio_read_only

    assert composio_read_only("GMAIL_FETCH_EMAILS") and composio_read_only("GITHUB_LIST_REPOS")
    for slug in ("GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE_AND_GET_LINK", "GOOGLEDRIVE_GET_AND_DELETE_FILE", "GMAIL_LIST_AND_TRASH", "GMAIL_DELETE_LIST"):
        assert not composio_read_only(slug), slug
    arcade = lambda t: bool(ARCADE_READ_VERB.search(t)) and not ARCADE_WRITE_WORD.search(t.split(".", 1)[1])
    assert arcade("Gmail.ListEmails") and not arcade("Gmail.GetAndDeleteEmail") and not arcade("Gmail.SendEmail")
