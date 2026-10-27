"""The local-first model policy, against fake Ollama and Groq servers."""
import json

import httpx
import pytest
import respx

from omnipilot_engine import llm

OLLAMA = "http://127.0.0.1:9/api/chat"  # conftest points every test at this (dead) address
GROQ = llm.GROQ_URL


@pytest.fixture(autouse=True)
def key(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test")


def groq_answer(text):
    return httpx.Response(200, json={"choices": [{"message": {"content": text}}]})


@respx.mock
async def test_answers_on_this_computer_first():
    local = respx.post(OLLAMA).mock(return_value=httpx.Response(200, json={"message": {"content": "Rayleigh scattering."}}))
    groq = respx.post(GROQ).mock(return_value=groq_answer("x"))
    out = await llm.chat([{"role": "user", "content": "why is the sky blue"}])
    assert out["where"] == "local" and out["text"] == "Rayleigh scattering." and not groq.called
    assert json.loads(local.calls[0].request.content)["model"] == llm.local_model()


@respx.mock
async def test_uses_groq_when_the_local_answer_is_unusable():
    respx.post(OLLAMA).mock(return_value=httpx.Response(200, json={"message": {"content": '{"wrong": 1}'}}))
    respx.post(GROQ).mock(return_value=groq_answer('{"category": "science"}'))
    schema = {"type": "object", "properties": {"category": {"type": "string"}}, "required": ["category"]}
    out = await llm.chat([{"role": "user", "content": "classify"}], fmt=schema)
    assert out["where"] == "groq" and json.loads(out["text"]) == {"category": "science"}


@respx.mock
async def test_uses_groq_when_the_local_model_is_not_running():
    respx.post(OLLAMA).mock(side_effect=httpx.ConnectError("refused"))
    respx.post(GROQ).mock(return_value=groq_answer("hello"))
    assert (await llm.chat([{"role": "user", "content": "hi"}]))["where"] == "groq"


@respx.mock
async def test_hard_jobs_go_to_groq_first_and_fall_back_to_local():
    respx.post(GROQ).mock(return_value=httpx.Response(429))
    respx.post(OLLAMA).mock(return_value=httpx.Response(200, json={"message": {"content": "done"}}))
    out = await llm.chat([{"role": "user", "content": "build a whole app"}], hard=True)
    assert out["where"] == "local"


@respx.mock
async def test_says_so_when_no_model_answers(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "")
    respx.post(OLLAMA).mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(llm.NoModel):
        await llm.chat([{"role": "user", "content": "hi"}])
