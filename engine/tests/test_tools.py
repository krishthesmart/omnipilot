"""The tool router and service adapters, against fake services (nothing reaches a real provider)."""
import json

import httpx
import pytest
import respx

from omnipilot_engine.tools import base, router, status
from omnipilot_engine.tools.base import Budget, BudgetExceeded, ToolError

KEYS = {"SERPAPI_API_KEY": "serp-test", "MEM0_API_KEY": "m0-test", "RESEND_API_KEY": "re-test", "LLAMAINDEX_API_KEY": "llx-test", "EXA_API_KEY": "exa-test", "TAVILY_API_KEY": "tvly-test", "BROWSERBASE_API_KEY": "bb-test", "TABSTACK_API_KEY": "ts-test", "COMPOSIO_API_KEY": "cp-test", "CONTEXT7_API_KEY": "c7-test", "APIFY_API_KEY": "ap-test"}


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("OMNIPILOT_TOOLS_DB", str(tmp_path / "tools.sqlite"))
    base.reset_db_for_tests()
    for k in ("EXA_API_KEY", "TAVILY_API_KEY", "SERPAPI_API_KEY", "BROWSERBASE_API_KEY", "YDC_API_KEY", "TABSTACK_API_KEY", "COMPOSIO_API_KEY", "CONTEXT7_API_KEY", "APIFY_API_KEY", "MEM0_API_KEY", "ZEP_API_KEY", "RESEND_API_KEY", "LLAMAINDEX_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    yield
    base.reset_db_for_tests()


def keys(monkeypatch, *names):
    for n in names:
        monkeypatch.setenv(n, KEYS[n])


@respx.mock
async def test_search_uses_the_first_configured_service_only(monkeypatch):
    keys(monkeypatch, "EXA_API_KEY", "TAVILY_API_KEY")
    exa = respx.post("https://api.exa.ai/search").mock(return_value=httpx.Response(200, json={"results": [{"title": "A", "url": "https://a.example", "highlights": ["about A"]}]}))
    tavily = respx.post("https://api.tavily.com/search").mock(return_value=httpx.Response(200, json={"results": []}))
    out = await router.run("web_search", {"query": "a"}, Budget())
    assert out["provider"] == "exa" and out["results"][0]["url"] == "https://a.example"
    assert exa.called and not tavily.called  # no duplicate paid work
    assert exa.calls[0].request.headers["x-api-key"] == "exa-test"


@respx.mock
async def test_falls_back_when_a_service_fails_and_caches_the_result(monkeypatch):
    keys(monkeypatch, "EXA_API_KEY", "TAVILY_API_KEY")
    respx.post("https://api.exa.ai/search").mock(return_value=httpx.Response(401, json={"error": "bad key"}))
    tavily = respx.post("https://api.tavily.com/search").mock(return_value=httpx.Response(200, json={"results": [{"title": "T", "url": "https://t.example", "content": "tee"}]}))
    budget = Budget()
    out = await router.run("web_search", {"query": "b"}, budget)
    assert out["provider"] == "tavily"
    assert [e["outcome"] for e in budget.log] == ["failed: auth", "ok"]
    assert status.last_status("exa")["state"] == "failed"  # a rejected key is recorded
    again = await router.run("web_search", {"query": "b"}, Budget())
    assert again["cached"] and tavily.call_count == 1


@respx.mock
async def test_retries_rate_limits_a_bounded_number_of_times(monkeypatch):
    keys(monkeypatch, "TAVILY_API_KEY")
    route = respx.post("https://api.tavily.com/search").mock(side_effect=[httpx.Response(429), httpx.Response(429), httpx.Response(200, json={"results": []})])
    out = await router.run("web_search", {"query": "c"}, Budget())
    assert out["provider"] == "tavily" and route.call_count == 3


async def test_budget_limits_calls_cost_and_time():
    b = Budget(max_calls=1, max_cost_usd=0.01)
    b.take("exa", 0.006)
    with pytest.raises(BudgetExceeded):
        b.take("exa", 0.006)
    with pytest.raises(BudgetExceeded):
        Budget(max_cost_usd=0.001).take("apify", 0.03)
    with pytest.raises(BudgetExceeded):
        Budget(deadline_s=1).take("exa", 0)


async def test_says_what_to_configure_when_nothing_is_set_up():
    with pytest.raises(router.NoProvider) as err:
        await router.run("web_search", {"query": "d"})
    assert "EXA_API_KEY" in str(err.value) and "exa-test" not in str(err.value)


@respx.mock
async def test_page_reading_prefers_tabstack(monkeypatch):
    keys(monkeypatch, "TABSTACK_API_KEY", "BROWSERBASE_API_KEY")
    ts = respx.post("https://api.tabstack.ai/v1/extract/markdown").mock(return_value=httpx.Response(200, json={"url": "https://x.example", "content": "# X"}))
    out = await router.run("read_page", {"url": "https://x.example"})
    assert out["provider"] == "tabstack" and out["markdown"] == "# X" and ts.calls[0].request.headers["authorization"] == "Bearer ts-test"


@respx.mock
async def test_library_docs_from_context7(monkeypatch):
    keys(monkeypatch, "CONTEXT7_API_KEY")
    respx.get("https://context7.com/api/v1/search").mock(return_value=httpx.Response(200, json={"results": [{"id": "/tiangolo/fastapi", "title": "FastAPI"}]}))
    respx.get("https://context7.com/api/v1/tiangolo/fastapi").mock(return_value=httpx.Response(200, text="## Routing\nUse @app.get"))
    out = await router.run("library_docs", {"library": "fastapi", "topic": "routing"})
    assert out["library"] == "FastAPI" and "Routing" in out["docs"]


async def test_app_actions_that_change_things_need_approval(monkeypatch):
    keys(monkeypatch, "COMPOSIO_API_KEY")
    with pytest.raises(ToolError) as err:
        await router.run("app_action", {"tool": "GMAIL_SEND_EMAIL", "arguments": {}})
    assert err.value.code == "needs_approval"


@respx.mock
async def test_apify_runs_an_actor_synchronously(monkeypatch):
    keys(monkeypatch, "APIFY_API_KEY")
    route = respx.post("https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items").mock(return_value=httpx.Response(200, json=[{"url": "https://s.example", "text": "page"}]))
    out = await router.run("scrape", {"url": "https://s.example", "max_pages": 2}, Budget(max_cost_usd=0.05))
    assert out["items"][0]["text"] == "page"
    assert json.loads(route.calls[0].request.content)["maxCrawlPages"] == 2


def test_status_lists_every_service_without_values(monkeypatch):
    keys(monkeypatch, "EXA_API_KEY")
    rows = {r["name"]: r for r in status.table()}
    assert rows["exa"]["configured"] and rows["you"]["state"] == "not configured" and rows["you"]["missing"] == ["YDC_API_KEY"]
    assert "exa-test" not in json.dumps(rows)


@respx.mock
async def test_serpapi_backs_up_search(monkeypatch):
    keys(monkeypatch, "SERPAPI_API_KEY")
    route = respx.get("https://serpapi.com/search.json").mock(return_value=httpx.Response(200, json={"organic_results": [{"title": "G", "link": "https://g.example", "snippet": "gee"}]}))
    out = await router.run("web_search", {"query": "g"})
    assert out["provider"] == "serpapi" and out["results"][0]["url"] == "https://g.example"
    assert route.calls[0].request.url.params["engine"] == "google"


@respx.mock
async def test_memory_saves_and_searches_with_mem0(monkeypatch):
    keys(monkeypatch, "MEM0_API_KEY")
    add = respx.post("https://api.mem0.ai/v3/memories/add/").mock(return_value=httpx.Response(200, json={"status": "PENDING"}))
    respx.post("https://api.mem0.ai/v3/memories/search/").mock(return_value=httpx.Response(200, json={"results": [{"memory": "Likes robotics"}]}))
    assert (await router.run("memory_add", {"text": "I like robotics"}))["saved"]
    assert add.calls[0].request.headers["authorization"] == "Token m0-test"
    assert (await router.run("memory_search", {"query": "hobbies"}))["memories"] == ["Likes robotics"]


@respx.mock
async def test_email_is_never_sent_without_approval(monkeypatch):
    keys(monkeypatch, "RESEND_API_KEY")
    send = respx.post("https://api.resend.com/emails").mock(return_value=httpx.Response(200, json={"id": "em_1"}))
    with pytest.raises(ToolError) as err:
        await router.run("send_email", {"to": "a@example.com", "subject": "Hi", "text": "Hello"})
    assert err.value.code == "needs_approval" and not send.called
    out = await router.run("send_email", {"to": "a@example.com", "subject": "Hi", "text": "Hello", "approved": True})
    assert out["sent"] and json.loads(send.calls[0].request.content)["to"] == ["a@example.com"]


@respx.mock
async def test_documents_parse_with_llamaparse_v2(monkeypatch):
    keys(monkeypatch, "LLAMAINDEX_API_KEY")
    respx.post("https://api.cloud.llamaindex.ai/api/v2/parse/upload").mock(return_value=httpx.Response(200, json={"id": "job1", "status": "PENDING"}))
    respx.get("https://api.cloud.llamaindex.ai/api/v2/parse/job1").mock(
        side_effect=[httpx.Response(200, json={"job": {"status": "COMPLETED"}}), httpx.Response(200, json={"job": {"status": "COMPLETED"}, "markdown_full": "# Notes"})]
    )
    out = await router.run("parse_document", {"filename": "n.pdf", "content": b"%PDF-1.4"})
    assert out["markdown"] == "# Notes"
