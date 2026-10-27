"""Model providers: local stays the free default; hard jobs prefer the strongest cloud (NVIDIA, then Groq).
Reasoning and usage are captured whichever provider answers. No real provider is called (all faked)."""

from omnipilot_engine import llm


def test_reasoning_field_handles_groq_and_nvidia_shapes():
    assert llm._reasoning_of({"reasoning": "a"}) == "a"               # Groq gpt-oss
    assert llm._reasoning_of({"reasoning_content": "b"}) == "b"       # NVIDIA / DeepSeek-style
    assert llm._reasoning_of({"content": "answer only"}) is None


def test_nvidia_is_a_configured_cloud_provider():
    assert "nvidia" in llm.CLOUD and llm.CLOUD["nvidia"]["env"] == "NVIDIA_API_KEY"
    assert "integrate.api.nvidia.com" in llm.CLOUD["nvidia"]["url"] and llm.CLOUD["nvidia"]["models"]


async def test_hard_jobs_try_nvidia_first_then_fall_back(monkeypatch):
    seen = []

    async def fake_cloud(where, *a, **k):
        seen.append(where)
        return ("A smart answer.", f"{where}-model") if where == "nvidia" else (None, None)

    async def no_local(*a, **k):
        return None

    monkeypatch.setattr(llm, "_cloud", fake_cloud)
    monkeypatch.setattr(llm, "_local", no_local)
    out = await llm.chat([{"role": "user", "content": "a hard question"}], hard=True)
    assert seen[0] == "nvidia" and out["where"] == "nvidia" and out["model"] == "nvidia-model"
    assert llm.answered_by().endswith("on NVIDIA")


async def test_ordinary_jobs_stay_local_first_and_never_touch_cloud(monkeypatch):
    seen = []

    async def fake_cloud(where, *a, **k):
        seen.append(where)
        return (None, None)

    async def local_ok(*a, **k):
        return "a local answer"

    monkeypatch.setattr(llm, "_cloud", fake_cloud)
    monkeypatch.setattr(llm, "_local", local_ok)
    out = await llm.chat([{"role": "user", "content": "easy"}])
    assert out["where"] == "local" and seen == []  # cloud is never called when local answers


async def test_usage_and_reasoning_are_recorded_for_the_cloud_provider_that_answers(monkeypatch):
    async def fake_cloud(where, *a, **k):
        if where == "nvidia":
            llm._note_tokens(100, 20)
            llm._note_reasoning("stepped through it")
            return ("done", "nvidia/model")
        return (None, None)

    async def no_local(*a, **k):
        return None

    monkeypatch.setattr(llm, "_cloud", fake_cloud)
    monkeypatch.setattr(llm, "_local", no_local)
    usage: list = []
    reasoning: list = []
    ut, rt = llm.usage_sink.set(usage), llm.reasoning_sink.set(reasoning)
    try:
        await llm.chat([{"role": "user", "content": "x"}], hard=True, reasoning=True)
    finally:
        llm.usage_sink.reset(ut)
        llm.reasoning_sink.reset(rt)
    assert usage and usage[0]["where"] == "nvidia" and usage[0]["promptTokens"] == 100 and usage[0]["costUsd"] is None
    assert reasoning and reasoning[0]["where"] == "nvidia" and reasoning[0]["text"] == "stepped through it"


def test_env_keys_are_case_forgiving(tmp_path, monkeypatch):
    """A key written as "Nvidia_API_Key" in .env is still found as NVIDIA_API_KEY (names are case-sensitive)."""
    from omnipilot_engine import envfiles

    for name in ("NVIDIA_API_KEY", "Nvidia_API_Key"):
        monkeypatch.delenv(name, raising=False)
    f = tmp_path / ".env"
    f.write_text("Nvidia_API_Key = nvapi-abc123\n")
    envfiles.load((f,))
    assert envfiles.secret("NVIDIA_API_KEY") == "nvapi-abc123"


async def test_smart_mode_sends_even_ordinary_jobs_to_the_cloud_first(monkeypatch):
    from omnipilot_engine import llm

    llm.set_smart_mode(True)
    seen = []

    async def fake_cloud(where, *a, **k):
        seen.append(where)
        return ("a smart answer", f"{where}-m") if where == "nvidia" else (None, None)

    async def local_spy(*a, **k):
        seen.append("local")
        return "local"

    monkeypatch.setattr(llm, "_cloud", fake_cloud)
    monkeypatch.setattr(llm, "_local", local_spy)
    out = await llm.chat([{"role": "user", "content": "hi"}])  # not hard
    assert seen[0] == "nvidia" and out["where"] == "nvidia"  # cloud answered first, before local


def test_smart_mode_is_off_by_default_and_toggles(monkeypatch):
    from omnipilot_engine import llm, store

    store.set_setting("answer_mode", None)  # no explicit choice
    assert llm.smart_mode() is False       # default: local-first (free, private)
    llm.set_smart_mode(True)
    assert llm.smart_mode() is True
    llm.set_smart_mode(False)
    assert llm.smart_mode() is False


async def test_tool_choice_uses_functiongemma_then_falls_back(monkeypatch):
    from omnipilot_engine import llm

    calls = []

    async def gen_ok(system, user, *, schema=None, model=None, **k):
        calls.append(model)
        return {"tool": "picked"} if model == llm.tool_model() else {"tool": "fallback"}

    monkeypatch.setattr(llm, "generate_json", gen_ok)
    out = await llm.choose_tool_json("s", "u", schema={})
    assert calls[0] == llm.tool_model() and out["tool"] == "picked"  # the tool model chooses

    calls.clear()

    async def gen_toolmodel_missing(system, user, *, schema=None, model=None, **k):
        calls.append(model)
        return None if model == llm.tool_model() else {"tool": "fb"}  # functiongemma not installed

    monkeypatch.setattr(llm, "generate_json", gen_toolmodel_missing)
    out = await llm.choose_tool_json("s", "u")
    assert calls == [llm.tool_model(), None] and out["tool"] == "fb"  # falls back to the normal model


async def test_a_specific_local_model_can_be_requested(monkeypatch):
    from omnipilot_engine import llm

    seen = {}

    async def fake_local(messages, fmt, temperature, max_tokens, timeout, on_token=None, reasoning=False, model=None):
        seen["model"] = model
        return "ok"

    monkeypatch.setattr(llm, "_local", fake_local)
    out = await llm.chat([{"role": "user", "content": "hi"}], model="functiongemma")
    assert seen["model"] == "functiongemma" and out["model"] == "functiongemma" and out["where"] == "local"
