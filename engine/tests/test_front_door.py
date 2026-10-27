"""The FastAPI front door keeps every rule of server/src/lib/security.ts (and its tests)."""
from conftest import TOKEN

LAN = {"host": "192.168.1.20:8899"}


async def test_rejects_other_hosts_and_websites(make_client):
    async with make_client() as c:
        assert (await c.get("/api/status", headers=LAN)).json() == {"error": "forbidden_host"}
        r = await c.get("/api/status", headers={"origin": "https://evil.example"})
        assert r.status_code == 403 and r.json() == {"error": "forbidden_origin"}
        ok = await c.get("/api/status", headers={"origin": "http://localhost:5173"})
        assert ok.status_code == 200 and ok.headers["access-control-allow-origin"] == "http://localhost:5173"


async def test_extension_may_only_use_watcher_endpoints(make_client):
    ext = {"origin": "chrome-extension://abcdefghijklmnop"}
    async with make_client() as c:
        assert (await c.get("/api/watcher/policy", headers=ext)).status_code == 200
        assert (await c.post("/api/watcher/check", headers=ext, json={"url": "https://x.com"})).status_code == 200
        assert (await c.post("/api/watcher/policy", headers=ext, json={})).status_code == 403  # can't change the policy
        assert (await c.get("/api/connectors", headers=ext)).status_code == 403


async def test_security_headers_on_every_response(make_client):
    async with make_client() as c:
        for r in [await c.get("/api/status"), await c.get("/api/status", headers=LAN), await c.get("/")]:
            assert r.headers["x-content-type-options"] == "nosniff"
            assert r.headers["x-frame-options"] == "DENY"
            assert "frame-ancestors 'none'" in r.headers["content-security-policy"]


async def test_preflight_rate_limit_and_body_limit(make_client):
    async with make_client() as c:
        assert (await c.options("/api/chat", headers={"origin": "http://localhost:8899"})).status_code == 204
        codes = [(await c.post("/api/chat", json={"message": "hi"})).status_code for _ in range(31)]
        assert codes[:30] == [200] * 30 and codes[30] == 429
        assert (await c.post("/api/approvals/x/decision", content=b"x" * (256 * 1024 + 1), headers={"content-type": "application/json"})).status_code == 413


async def test_sdk_token_opens_only_question_answering(make_client):
    async with make_client(api_token=TOKEN) as c:
        auth = {**LAN, "authorization": f"Bearer {TOKEN}"}
        assert (await c.get("/api/math/status", headers=auth)).status_code == 200
        assert (await c.post("/api/ask", headers=auth, json={"message": "hi"})).status_code == 200
        assert (await c.get("/api/connectors", headers=auth)).json() == {"error": "forbidden_for_token"}
        assert (await c.post("/api/watcher/policy", headers=auth, json={})).status_code == 403
        assert (await c.get("/api/status", headers={**auth, "origin": "https://evil.example"})).status_code == 403  # never from a web page
        assert (await c.get("/api/status", headers={**LAN, "authorization": "Bearer wrong-token-wrong-token"})).status_code == 401


async def test_a_short_token_is_never_accepted(make_client):
    async with make_client(api_token=None) as c:  # config.load() ignores tokens under 16 characters
        assert (await c.get("/api/status", headers={**LAN, "authorization": "Bearer short"})).status_code == 401


async def test_passes_requests_through_with_the_internal_token(make_client, node):
    async with make_client() as c:
        r = await c.post("/api/chat?x=1", json={"message": "hello"})
        assert r.status_code == 200 and r.json()["path"] == "/api/chat" and r.json()["query"] == "x=1"
    sent = node.requests[-1]
    assert sent.headers["x-omnipilot-internal"] == "internal-secret"
    assert sent.content == b'{"message":"hello"}'
    assert sent.headers["host"] == "localhost:8899"  # the engine's own checks see the original host


async def test_streams_server_sent_events(make_client):
    async with make_client() as c:
        async with c.stream("GET", "/api/runs/r1/events") as r:
            assert r.headers["content-type"].startswith("text/event-stream")
            body = b"".join([chunk async for chunk in r.aiter_raw()])
    assert body.count(b"data: ") == 2


async def test_reports_a_stopped_engine_plainly(make_client, node):
    node.down = True
    async with make_client() as c:
        r = await c.get("/api/status")
    assert r.status_code == 502 and r.json()["error"] == "engine_unavailable"


async def test_serves_the_web_app(make_client):
    async with make_client() as c:
        assert "OmniPilot" in (await c.get("/")).text
        assert "OmniPilot" in (await c.get("/some/page")).text  # single-page app routes
        assert (await c.get("/assets/app.js")).text == "console.log(1)"
        assert "OmniPilot" in (await c.get("/../../etc/passwd")).text  # never a file outside web/dist


# Finding 1: the Host header is not proof that a client is local.
import httpx
from dataclasses import replace

from omnipilot_engine import config
from omnipilot_engine.app import create_app


def remote_client(node, tmp_path, **overrides):
    settings = replace(config.load(), internal_token="internal-secret", api_token=None, web_dist=tmp_path, allowed_origins=(), allow_any_host=False)
    app = create_app(replace(settings, **overrides), transport=httpx.MockTransport(node))
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("192.168.1.50", 5000)), base_url="http://localhost:8899")


async def test_another_device_claiming_to_be_localhost_is_rejected(node, tmp_path):
    async with remote_client(node, tmp_path) as c:
        r = await c.get("/api/connectors", headers={"host": "localhost:8899"})
    assert r.status_code == 401 and r.json()["error"] == "token_required"
    assert node.requests == []  # never reached the engine


async def test_allow_any_host_never_bypasses_authentication(node, tmp_path):
    async with remote_client(node, tmp_path, allow_any_host=True) as c:
        assert (await c.post("/api/watcher/events", headers={"host": "omnipilot.lan"}, json={})).status_code == 401


async def test_proxied_requests_count_as_remote(make_client, node):
    async with make_client() as c:
        for h in ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host"]:
            assert (await c.get("/api/status", headers={h: "203.0.113.9"})).status_code == 401
    assert node.requests == []


async def test_the_engine_gets_our_verdict_never_the_clients(make_client, node, tmp_path):
    async with make_client() as c:
        await c.get("/api/status")
    assert node.requests[-1].headers["x-omnipilot-client-local"] == "1"
    # A remote SDK client can't pass itself off as local by sending the header.
    async with remote_client(node, tmp_path, api_token=TOKEN) as c:
        r = await c.get("/api/status", headers={"host": "192.168.1.20:8899", "authorization": f"Bearer {TOKEN}", "x-omnipilot-client-local": "1"})
    assert r.status_code == 200
    assert "x-omnipilot-client-local" not in node.requests[-1].headers


async def test_forwards_the_path_exactly_as_sent(make_client, node):
    # Finding 4 (front door side): an encoded "/" must stay encoded, and malformed encodings reach
    # the engine unchanged (it answers them with 400).
    async with make_client() as c:
        await c.get("/api/runs/a%2F..%2Fconnectors")
        await c.get("/api/runs/%E0%A4%A?x=1")
    assert node.requests[-2].url.raw_path == b"/api/runs/a%2F..%2Fconnectors"
    assert node.requests[-1].url.raw_path == b"/api/runs/%E0%A4%A?x=1"


async def test_a_stream_the_engine_cuts_off_just_ends(tmp_path):
    """The engine closing an event stream partway must not crash the front door."""
    from dataclasses import replace
    import httpx
    from omnipilot_engine import config
    from omnipilot_engine.app import create_app

    class CutOff(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"type":"run_started"}\n\n'
            raise httpx.RemoteProtocolError("peer closed connection without sending complete message body")

    def node(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=CutOff())

    settings = replace(config.load(), internal_token="internal-secret", api_token=None, web_dist=tmp_path, allowed_origins=(), allow_any_host=False)
    app = create_app(settings, transport=httpx.MockTransport(node))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost:8899") as c:
        r = await c.get("/api/runs/r1/events")
    assert r.status_code == 200
    assert r.text == 'data: {"type":"run_started"}\n\n'


async def test_previews_keep_the_engines_sandbox_policy(make_client, node):
    """The front door must not replace the preview's sandboxing CSP with the app's own."""
    async with make_client() as c:
        page = await c.get("/api/runs/r1/preview/0")
        normal = await c.get("/api/runs/r1")
    assert "x-frame-options" not in page.headers or page.headers["x-frame-options"] != "DENY"
    assert "script-src 'self'" not in page.headers.get("content-security-policy", "")
    assert normal.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in normal.headers["content-security-policy"]


async def test_a_cloudflare_tunnel_visitor_is_not_local(make_client, node):
    """A tunnel connects from this computer; its visitors are on the internet."""
    async with make_client() as c:
        r = await c.get("/api/skills", headers={"CF-Connecting-IP": "203.0.113.5"})
    assert r.status_code == 401 and r.json()["error"] == "token_required"


async def test_with_a_password_internet_visitors_reach_the_engine_unmarked(make_client, node):
    """With OMNIPILOT_PASSWORD set, the TypeScript engine asks them to sign in; never marked local."""
    async with make_client(owner_password_set=True) as c:
        r = await c.get("/api/runs/r1", headers={"CF-Connecting-IP": "203.0.113.5", "Host": "abc.trycloudflare.com", "X-OmniPilot-Client-Local": "1"})
        python_served = await c.get("/api/skills", headers={"CF-Connecting-IP": "203.0.113.5", "Host": "abc.trycloudflare.com"})
    assert r.status_code == 200
    forwarded = node.requests[-1]
    assert forwarded.headers.get("x-omnipilot-client-local") is None
    # Routes Python answers itself ask a visitor who isn't signed in to sign in.
    assert python_served.status_code == 401 and python_served.json()["error"] == "login_required"


def test_fake_addresses_cannot_get_unlimited_password_guesses():
    """Found in the security review: the per-address limit used headers a visitor can fake; an overall cap now applies."""
    from omnipilot_engine import auth

    auth._attempts.clear()
    auth._all_failures.clear()
    for i in range(auth.OVERALL):
        assert auth.login_allowed(f"10.0.0.{i}")
        auth.note_failed_login(f"10.0.0.{i}")
    assert not auth.login_allowed("203.0.113.7")  # a brand-new "address" is still refused
    auth._attempts.clear()
    auth._all_failures.clear()
