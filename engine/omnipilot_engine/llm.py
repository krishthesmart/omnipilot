"""OmniPilot's AI model, private by default: questions go to the model on this computer (Ollama, a
2–5 GB model, qwen3:4b-instruct unless OMNIPILOT_LOCAL_MODEL says otherwise) and only reach Groq's stronger
models when that's really needed:
  - the job is marked hard (building a whole project, designing a 3D model, long research write-ups),
  - the local model isn't running, or
  - its answer is unusable (empty, or not the JSON that was asked for).
Every answer says where it was made ("local" or "groq"), so the app can show it. GROQ_API_KEY stays
on this computer and is only sent to Groq."""
from __future__ import annotations

import contextvars
import json
import os
import re
import time
from typing import Callable

import httpx

from . import envfiles

envfiles.load()

def ollama_url() -> str:
    return os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODELS = ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"]
# NVIDIA NIM (build.nvidia.com), OpenAI-compatible. Big, capable models for the hard jobs; needs NVIDIA_API_KEY
# (a free tier exists). Local stays the default; NVIDIA/Groq are the smarter fallback for hard work.
NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
# Most powerful free NVIDIA models first (405B instruct, then the DeepSeek-R1 reasoner, then Nemotron-70B).
NVIDIA_MODELS = ["meta/llama-3.1-405b-instruct", "deepseek-ai/deepseek-r1", "nvidia/llama-3.1-nemotron-70b-instruct"]
# Each cloud provider: its endpoint, key, models, and whether it uses Groq's gpt-oss reasoning params.
CLOUD = {
    "groq": {"url": GROQ_URL, "env": "GROQ_API_KEY", "models": GROQ_MODELS, "gpt_oss": True},
    "nvidia": {"url": NVIDIA_URL, "env": "NVIDIA_API_KEY", "models": NVIDIA_MODELS, "gpt_oss": False},
}


def local_model() -> str:
    # Qwen3 4B "instruct" (2.5 GB): answers directly (the plain qwen3:4b tag is a thinking model that writes
    # out its reasoning first, which is slow and leaks into answers).
    return os.environ.get("OMNIPILOT_LOCAL_MODEL", "qwen3:4b-instruct")


class NoModel(Exception):
    pass


def _valid(text: str | None, want_json: bool, schema: dict | None = None) -> bool:
    """A usable answer: not empty; for JSON, parseable and (with a schema) carrying every required field."""
    if not text or not text.strip():
        return False
    if not want_json:
        return True
    try:
        data = json.loads(_strip_fences(text))
    except ValueError:
        return False
    if schema and isinstance(data, dict):
        return all(k in data for k in schema.get("required", []))
    return isinstance(data, (dict, list))


def _strip_fences(text: str) -> str:
    return re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", text.strip())


# The run a model call belongs to (set by the pipeline), and that run's lessons from earlier feedback.
current_run: contextvars.ContextVar[str | None] = contextvars.ContextVar("omnipilot_run", default=None)
# Usage capture (slice 9): a run that wants its model usage sets a list here; every answered call appends one
# entry. Token counts come from the provider's reply when it reports them, otherwise they're None ("unavailable").
usage_sink: contextvars.ContextVar[list | None] = contextvars.ContextVar("omnipilot_usage", default=None)
_tokens: contextvars.ContextVar[tuple | None] = contextvars.ContextVar("omnipilot_tokens", default=None)
# Reasoning capture: when a call is asked to reason (reasoning=True) and the model emits its working
# (Ollama's `thinking`, Groq gpt-oss's `reasoning`), it's appended here if a run set a sink. It is the model's
# own reasoning, kept separate from the answer and never mixed into it; it can be imperfect.
reasoning_sink: contextvars.ContextVar[list | None] = contextvars.ContextVar("omnipilot_reasoning", default=None)
_reasoning: contextvars.ContextVar[str | None] = contextvars.ContextVar("omnipilot_reasoning_text", default=None)


def _note_tokens(prompt, completion) -> None:
    _tokens.set((prompt if isinstance(prompt, int) else None, completion if isinstance(completion, int) else None))


def _note_reasoning(text) -> None:
    _reasoning.set(text.strip() if isinstance(text, str) and text.strip() else None)


def _record_reasoning(where: str, model: str | None) -> None:
    sink, text = reasoning_sink.get(), _reasoning.get()
    if sink is not None and text:
        sink.append({"where": where, "model": model, "text": text[:8000]})


def _record_usage(where: str, model: str | None, ms: int) -> None:
    sink = usage_sink.get()
    if sink is None:
        return
    prompt, completion = _tokens.get() or (None, None)
    # The local model costs nothing to call; Groq's free tier isn't priced here, so its cost is left unknown.
    sink.append({"where": where, "model": model, "ms": ms, "promptTokens": prompt, "completionTokens": completion, "costUsd": 0.0 if where == "local" else None})
# The model that gave the last answer in this task ({"model", "where"}), for "written by ..." notes.
last_answer: contextvars.ContextVar[dict | None] = contextvars.ContextVar("omnipilot_last_answer", default=None)


def answered_by() -> str:
    """"qwen3:4b-instruct on this computer" / "openai/gpt-oss-120b on Groq" / "… on NVIDIA" for the last answer."""
    a = last_answer.get() or {"model": local_model(), "where": "local"}
    where = {"local": "this computer", "groq": "Groq", "nvidia": "NVIDIA"}.get(a["where"], a["where"])
    return f"{a['model']} on {where}"
_lesson_notes: dict[str, str] = {}


def set_lesson_note(run_id: str, note: str) -> None:
    if note:
        _lesson_notes[run_id] = note
    else:
        _lesson_notes.pop(run_id, None)


def _with_lessons(messages: list[dict]) -> list[dict]:
    note = _lesson_notes.get(current_run.get() or "")
    if not note or not messages or messages[0].get("role") != "system":
        return messages
    return [{**messages[0], "content": messages[0]["content"] + note}, *messages[1:]]


def _context_size(messages: list[dict], max_tokens: int) -> int:
    approx = sum(len(m.get("content") or "") for m in messages) // 3 + max_tokens + 256
    size = 4096
    while size < approx and size < 32768:
        size *= 2
    return size


async def _local(messages: list[dict], fmt, temperature: float, max_tokens: int, timeout: float, on_token: Callable[[str], None] | None = None, reasoning: bool = False, model: str | None = None) -> str | None:
    if isinstance(fmt, dict):
        # Ollama's schema mode returns empty answers with this model; plain JSON mode plus the schema in the
        # instructions works, and the answer is checked for the required fields afterwards.
        messages = [{"role": "system", "content": f"Reply with JSON only, matching this JSON schema: {json.dumps(fmt)}"}, *messages]
    body = {
        "model": model or local_model(),
        "messages": messages,
        "stream": bool(on_token),
        # qwen3's "thinking" is slow and the small "instruct" build can fold it into the answer, so local
        # reasoning stays off unless explicitly opted in (OMNIPILOT_LOCAL_REASONING). Groq's reasoning model
        # returns its reasoning in a separate field, so that is captured without this. Default: off.
        "think": bool(reasoning) and os.environ.get("OMNIPILOT_LOCAL_REASONING") == "on",
        # Ollama's default context (about 4k tokens) silently cuts long prompts: size it to the prompt.
        "options": {"temperature": temperature, "num_predict": max_tokens, "num_ctx": _context_size(messages, max_tokens)},
        **({"format": "json"} if fmt else {}),
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            if not on_token:
                r = await c.post(f"{ollama_url()}/api/chat", json=body)
                if r.status_code == 404:  # the model isn't downloaded
                    return None
                r.raise_for_status()
                data = r.json()
                _note_tokens(data.get("prompt_eval_count"), data.get("eval_count"))
                if reasoning:
                    _note_reasoning((data.get("message") or {}).get("thinking"))
                return (data.get("message") or {}).get("content")
            parts: list[str] = []
            think_parts: list[str] = []
            async with c.stream("POST", f"{ollama_url()}/api/chat", json=body) as r:
                if r.status_code == 404:
                    return None
                r.raise_for_status()
                async for line in r.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    if chunk.get("done"):
                        _note_tokens(chunk.get("prompt_eval_count"), chunk.get("eval_count"))
                    msg = chunk.get("message") or {}
                    if reasoning and msg.get("thinking"):  # the model's reasoning streams before the answer
                        think_parts.append(msg["thinking"])
                    piece = msg.get("content") or ""
                    if piece:
                        parts.append(piece)
                        on_token(piece)  # only the answer is streamed to the reader, never the reasoning
            if reasoning:
                _note_reasoning("".join(think_parts))
            return "".join(parts)
    except (httpx.HTTPError, ValueError):
        return None


def _reasoning_of(obj: dict) -> str | None:
    """Reasoning is in `reasoning` (Groq gpt-oss) or `reasoning_content` (NVIDIA / DeepSeek-style) models."""
    return obj.get("reasoning") or obj.get("reasoning_content")


async def _cloud(where: str, messages: list[dict], fmt, temperature: float, max_tokens: int, timeout: float, effort: str | None,
                 on_token: Callable[[str], None] | None = None, reasoning: bool = False) -> tuple[str | None, str | None]:
    """One OpenAI-compatible provider (Groq or NVIDIA): tries its models in order; returns (text, model)."""
    spec = CLOUD[where]
    key = envfiles.secret(spec["env"])
    if not key:
        return None, None
    async with httpx.AsyncClient(timeout=timeout) as c:
        for model in spec["models"]:
            gpt_oss = spec["gpt_oss"] and "gpt-oss" in model
            body = {
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_completion_tokens": max_tokens + (1500 if gpt_oss else 0),
                **({"reasoning_effort": effort or "medium"} if gpt_oss else {}),
                **({"reasoning_format": "parsed"} if gpt_oss and reasoning else {}),
                **(
                    {"response_format": {"type": "json_object"} if not isinstance(fmt, dict) else {"type": "json_schema", "json_schema": {"name": "reply", "strict": False, "schema": fmt}}}
                    if fmt
                    else {}
                ),
            }
            if on_token and not fmt:
                text = await _cloud_stream(c, spec["url"], body, key, on_token, reasoning=reasoning)
                if text:
                    return text, model
                continue
            try:
                r = await c.post(spec["url"], json=body, headers={"Authorization": f"Bearer {key}"})
            except httpx.HTTPError:
                continue
            if r.status_code in (429, 500, 502, 503):
                continue  # busy or rate-limited: try the next model
            if r.status_code >= 400:
                return None, None
            data = r.json()
            msg = (data.get("choices") or [{}])[0].get("message") or {}
            text = msg.get("content")
            _note_tokens((data.get("usage") or {}).get("prompt_tokens"), (data.get("usage") or {}).get("completion_tokens"))
            if reasoning:  # kept apart from the answer
                _note_reasoning(_reasoning_of(msg))
            if text:
                return text, model
    return None, None


async def _cloud_stream(c: httpx.AsyncClient, url: str, body: dict, key: str, on_token: Callable[[str], None], reasoning: bool = False) -> str | None:
    parts: list[str] = []
    think_parts: list[str] = []
    try:
        async with c.stream("POST", url, json={**body, "stream": True}, headers={"Authorization": f"Bearer {key}"}) as r:
            if r.status_code >= 400:
                return None
            async for line in r.aiter_lines():
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                delta = ((json.loads(line[6:]).get("choices") or [{}])[0].get("delta") or {})
                if reasoning and _reasoning_of(delta):
                    think_parts.append(_reasoning_of(delta))
                piece = delta.get("content") or ""
                if piece:
                    parts.append(piece)
                    on_token(piece)  # only the answer reaches the reader, not the reasoning
    except (httpx.HTTPError, ValueError):
        pass
    if reasoning:
        _note_reasoning("".join(think_parts))
    return "".join(parts) or None


async def chat(
    messages: list[dict],
    *,
    fmt: dict | str | None = None,
    temperature: float = 0.3,
    max_tokens: int = 800,
    hard: bool = False,
    effort: str | None = None,
    timeout: float = 120,
    on_token: Callable[[str], None] | None = None,
    reasoning: bool = False,
    model: str | None = None,
) -> dict:
    """One answer. Returns {"text", "model", "where": "local" | "groq", "ms"}; raises NoModel if no model could answer.
    With on_token, plain-text answers arrive piece by piece as they're written. With reasoning, the model is asked
    to reason and its reasoning is captured separately (never mixed into the answer) for a run that set a sink."""
    t0 = time.monotonic()
    messages = _with_lessons(messages)
    streamed = on_token if not fmt else None
    want_json = bool(fmt)
    # Smart mode (default when a cloud key is set) answers with the powerful cloud model first — NVIDIA, then
    # Groq, then local. Hard jobs always do. Otherwise local answers first (free, private) and cloud is fallback.
    cloud_first = hard or smart_mode()
    order = ["nvidia", "groq", "local"] if cloud_first else ["local", "nvidia", "groq"]
    for where in order:
        _tokens.set(None)
        _reasoning.set(None)
        if where == "local":
            lm = model or local_model()
            text = await _local(messages, fmt, temperature, max_tokens, timeout, streamed, reasoning=reasoning, model=lm)
            if _valid(text, want_json, fmt if isinstance(fmt, dict) else None):
                last_answer.set({"model": lm, "where": "local"})
                _record_usage("local", lm, int((time.monotonic() - t0) * 1000))
                _record_reasoning("local", lm)
                return {"text": _strip_fences(text) if want_json else text.strip(), "model": lm, "where": "local", "ms": int((time.monotonic() - t0) * 1000)}
        else:
            text, model = await _cloud(where, messages, fmt, temperature, max_tokens, timeout, effort, streamed, reasoning=reasoning)
            if _valid(text, want_json, fmt if isinstance(fmt, dict) else None):
                last_answer.set({"model": model, "where": where})
                _record_usage(where, model, int((time.monotonic() - t0) * 1000))
                _record_reasoning(where, model)
                return {"text": _strip_fences(text) if want_json else text.strip(), "model": model, "where": where, "ms": int((time.monotonic() - t0) * 1000)}
    raise NoModel("No AI model answered: start Ollama (with the local model), or add GROQ_API_KEY / NVIDIA_API_KEY.")


def _messages(system: str, user: str, examples: list[dict] | None, want_json: bool, max_input: int) -> list[dict]:
    if want_json and "json" not in system.lower():
        system += "\nReply in JSON."
    out = [{"role": "system", "content": system}]
    for ex in examples or []:
        out += [{"role": "user", "content": ex["user"]}, {"role": "assistant", "content": ex["assistant"]}]
    return out + [{"role": "user", "content": user[:max_input]}]


async def generate_text(system: str, user: str, *, examples: list[dict] | None = None, temperature: float = 0.3, max_tokens: int = 400,
                        hard: bool = False, effort: str | None = None, on_token: Callable[[str], None] | None = None, max_input: int = 12_000, reasoning: bool = False) -> str | None:
    """One plain-text answer (None if no model could answer)."""
    try:
        return (await chat(_messages(system, user, examples, False, max_input), temperature=temperature, max_tokens=max_tokens, hard=hard, effort=effort, on_token=on_token, reasoning=reasoning))["text"]
    except NoModel:
        return None


async def generate_json(system: str, user: str, *, schema: dict | None = None, examples: list[dict] | None = None, temperature: float = 0.2,
                        max_tokens: int = 400, hard: bool = False, max_input: int = 12_000, model: str | None = None) -> dict | list | None:
    """A JSON answer, checked against the schema's required fields (None if no model gave a usable one)."""
    try:
        out = await chat(_messages(system, user, examples, True, max_input), fmt=schema or "json", temperature=temperature, max_tokens=max_tokens, hard=hard, effort="low", model=model)
        return json.loads(out["text"])
    except (NoModel, ValueError):
        return None


def tool_model() -> str:
    """The model that decides which tool an agent should call. Default: functiongemma (a Gemma function-caller on
    this computer). Override with OMNIPILOT_TOOL_MODEL. Falls back to the normal model if it isn't installed."""
    return os.environ.get("OMNIPILOT_TOOL_MODEL", "functiongemma")


async def choose_tool_json(system: str, user: str, *, schema: dict | None = None, temperature: float = 0.1, max_tokens: int = 400) -> dict | list | None:
    """Pick a tool/function with the dedicated tool model; fall back to the normal model if it can't answer."""
    out = await generate_json(system, user, schema=schema, temperature=temperature, max_tokens=max_tokens, model=tool_model())
    if out is None:
        out = await generate_json(system, user, schema=schema, temperature=temperature, max_tokens=max_tokens)
    return out


def smart_mode() -> bool:
    """Whether answers should use the powerful cloud model first. The 'answer_mode' setting ('smart'/'fast')
    decides; the default is off (local-first, free/private) — turn Smart on in Settings once a cloud key is set."""
    try:
        from . import store

        return store.get_setting("answer_mode") == "smart"
    except Exception:  # noqa: BLE001 -- no DB yet just means the default (off)
        return False


def set_smart_mode(on: bool) -> None:
    from . import store

    store.set_setting("answer_mode", "smart" if on else "fast")


async def available() -> bool:
    """Whether any model can answer: a cloud key is set (Groq or NVIDIA), or the local model is running."""
    if any(envfiles.secret(spec["env"]) for spec in CLOUD.values()):
        return True
    return bool((await local_status()).get("running"))


async def local_status() -> dict:
    """Whether the local model is installed and running."""
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            tags = (await c.get(f"{ollama_url()}/api/tags")).json().get("models", [])
    except (httpx.HTTPError, ValueError):
        return {"running": False, "model": local_model(), "installed": False}
    names = {m.get("name") for m in tags}
    return {"running": True, "model": local_model(), "installed": local_model() in names or f"{local_model()}:latest" in names}
