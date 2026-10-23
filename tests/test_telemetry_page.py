"""Tests for Spec 0025 §5: Admin-gated Request Telemetry Dashboard (/admin/requests).

Verifies:
- test_the_page_is_admin_only: 401 unauthenticated, 403 non-admin, 200 admin.
- test_the_list_shows_the_request_by_its_id: after /agent/chat or /ask, list shows request_id and data.
- test_the_detail_joins_all_five_legs: canned ledger, chat, Cognee, Mastra upstreams; page displays question, cost, Cognee session, span tree, window state.
- test_the_real_tokens_are_the_models_not_the_estimate: canned Mastra trace with promptTokens 2400 displays 2400.
- test_the_filters_survive_the_url: ?day=...&phone=... filters the list and renders back in the form.
- test_the_trace_downloads_as_json: GET /admin/requests/<id>/trace.json returns the joined dict as JSON.
- test_a_missing_leg_says_so: Cognee/Mastra unreachable renders explicit absence note.
- test_the_page_never_breaks_the_answer: errors reading telemetry never break user answers.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

from tests.conftest import REPO_ROOT
from tests.helpers import (
    ADMIN_EMAIL,
    TEST_PASSWORD,
    FakeResponse,
    account_email_for_phone,
    cookie_for,
    ensure_account,
    stop_gate,
    with_gate,
)
from tests.test_agent_chat import (
    StreamResponse,
    finish_frame,
    sse_lines,
    start_frame,
    text_delta,
)
from tests.test_ask import (
    _Reply,
    only_context_reply,
    sample_document,
)

sys.path.insert(0, str(REPO_ROOT))

from ui import (  # noqa: E402
    accounts,
    agent_client,
    ask,
    chat_store,
    ledger,
    question_window,
    serve,
    telemetry,
)

PHONE = "09120000000"
OPERATOR_PHONE = "09121111111"
SAMPLE_REQ_ID = "0123456789abcdef0123456789abcdef"


class TelemetryUpstream:
    """Upstream mock handling Cognee sessions, Mastra traces, recall, remember, and agent streams."""

    def __init__(
        self,
        agent_replies=None,
        documents=None,
        cognee_session=None,
        mastra_trace=None,
        cognee_error=None,
        mastra_error=None,
    ):
        self.agent_replies = [
            reply.encode("utf-8") if isinstance(reply, str) else reply
            for reply in (agent_replies or [])
        ]
        self.documents = list(
            documents or [sample_document("Page 10:"), sample_document("Page 30:")]
        )
        self.cognee_session = cognee_session
        self.mastra_trace = mastra_trace
        self.cognee_error = cognee_error
        self.mastra_error = mastra_error
        self.calls = []

    def __call__(self, request, timeout=None):
        url = request.full_url
        self.calls.append(url)
        data = request.data.decode("utf-8") if request.data else "{}"

        # Cognee session read
        if "/api/v1/sessions/" in url:
            if self.cognee_error:
                raise self.cognee_error
            payload = self.cognee_session or {
                "session_id": SAMPLE_REQ_ID,
                "label": "درباره توحید",
                "status": "completed",
                "tokens_in": 120,
                "tokens_out": 45,
                "tool_calls": 1,
                "msg_count": 2,
                "qas": [
                    {
                        "time": "2026-10-23T10:00:00",
                        "question": "توحید در قرآن چیست؟",
                        "context": "شاهد از طرح کلی اندیشه اسلامی",
                        "answer": "توحید اصل دین است.",
                    }
                ],
            }
            return _Reply(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

        # Mastra trace read
        if "/api/observability/traces/" in url:
            if self.mastra_error:
                raise self.mastra_error
            payload = self.mastra_trace or {
                "traceId": SAMPLE_REQ_ID,
                "spans": [
                    {
                        "id": "span-root-1",
                        "name": "agent.run",
                        "spanType": "agent_run",
                        "status": "success",
                        "attributes": {},
                    },
                    {
                        "id": "span-model-1",
                        "name": "model.generate",
                        "spanType": "model_call",
                        "status": "success",
                        "promptTokens": 2400,
                        "completionTokens": 350,
                        "attributes": {
                            "promptTokens": 2400,
                            "completionTokens": 350,
                        },
                    },
                    {
                        "id": "span-tool-1",
                        "name": "searchBooksTool",
                        "spanType": "tool_call",
                        "status": "success",
                        "attributes": {"passage_count": 2},
                    },
                ],
            }
            return _Reply(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

        # Cognee remember write
        if "/api/v1/remember/entry" in url:
            return _Reply(b'{"status": "ok"}')

        # Cognee recall
        if "/api/v1/recall" in url:
            doc = self.documents.pop(0) if self.documents else ""
            return _Reply(only_context_reply(doc))

        # Agent streaming
        if "/stream" in url or "/agent" in url:
            item = self.agent_replies.pop(0) if self.agent_replies else []
            if isinstance(item, Exception):
                raise item
            if isinstance(item, list):
                return StreamResponse(item)
            return FakeResponse(item)

        raise AssertionError(f"unexpected upstream call: {url}")


def with_telemetry(tmp_path, upstream):
    """Sets up GateServer with patched DBs and telemtry.urlopen."""
    question_window.WINDOW_DB = tmp_path / "window.sqlite3"
    ledger.LEDGER_DB = str(tmp_path / "ledger.sqlite3")
    chat_store.CHAT_DB = tmp_path / "chats.sqlite3"

    orig_telemetry = telemetry.urlopen
    telemetry.urlopen = upstream
    base, server, original = with_gate(tmp_path, upstream)
    return base, server, original, orig_telemetry


def stop_telemetry(server, original, orig_telemetry):
    try:
        stop_gate(server, original)
    finally:
        telemetry.urlopen = orig_telemetry


def get_req(base, path, cookie=None):
    """Make a GET request returning (status, content_type, body_str)."""
    headers = {"Cookie": cookie} if cookie is not None else {}
    req = urllib.request.Request(base + path, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return (
                resp.status,
                resp.headers.get("Content-Type", ""),
                resp.read().decode("utf-8"),
            )
    except urllib.error.HTTPError as exc:
        return (
            exc.code,
            exc.headers.get("Content-Type", ""),
            exc.read().decode("utf-8"),
        )


def post_agent_chat(base, payload, phone=PHONE):
    """POST /agent/chat helper."""
    ensure_account(phone)
    cookie = cookie_for(base, account_email_for_phone(phone))
    req = urllib.request.Request(
        base + "/agent/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Cookie": cookie},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status, resp.read().decode("utf-8")


def test_the_page_is_admin_only(tmp_path):
    """401 for unauth, 403 for non-admin, 200 for admin across the 3 endpoints."""
    upstream = TelemetryUpstream()
    base, server, original, orig_tel = with_telemetry(tmp_path, upstream)
    try:
        ensure_account(OPERATOR_PHONE)
        operator_cookie = cookie_for(base, account_email_for_phone(OPERATOR_PHONE))
        admin_cookie = cookie_for(base, ADMIN_EMAIL)

        endpoints = [
            "/admin/requests",
            f"/admin/requests/{SAMPLE_REQ_ID}",
            f"/admin/requests/{SAMPLE_REQ_ID}/trace.json",
        ]

        for ep in endpoints:
            # 1. Unauthenticated -> 401
            st, ct, body = get_req(base, ep, cookie=None)
            assert st == 401, f"Expected 401 for {ep}, got {st}"
            assert "application/json" in ct
            assert json.loads(body)["detail"] == serve.AUTH_LOGIN_401_DETAIL

            # 2. Non-admin operator -> 403
            st, ct, body = get_req(base, ep, cookie=operator_cookie)
            assert st == 403, f"Expected 403 for {ep}, got {st}"
            assert "application/json" in ct
            assert json.loads(body)["detail"] == serve.ADMIN_CONSOLE_403_DETAIL

            # 3. Admin -> 200
            st, ct, body = get_req(base, ep, cookie=admin_cookie)
            assert st == 200, f"Expected 200 for {ep}, got {st}"
            if ep.endswith(".json"):
                assert "application/json" in ct
            else:
                assert "text/html" in ct
    finally:
        stop_telemetry(server, original, orig_tel)


def test_the_list_shows_the_request_by_its_id(tmp_path):
    """After /agent/chat or /ask, list shows the request_id and data."""
    upstream = TelemetryUpstream(
        agent_replies=[
            sse_lines(
                [
                    start_frame(),
                    text_delta("پاسخ به پرسش درباره عدل"),
                    finish_frame(),
                ]
            )
        ]
    )
    base, server, original, orig_tel = with_telemetry(tmp_path, upstream)
    try:
        # 1. Run an agent chat
        st, _ = post_agent_chat(base, {"query": "عدل چیست؟"})
        assert st == 200

        # Retrieve request_id from chat_store
        agent_rows = chat_store._connect().execute(
            "SELECT request_id FROM agent_chats"
        ).fetchall()
        assert len(agent_rows) >= 1
        minted_id = agent_rows[-1][0]
        assert minted_id

        # 2. Query /admin/requests as admin
        admin_cookie = cookie_for(base, ADMIN_EMAIL)
        st, ct, html = get_req(base, "/admin/requests", cookie=admin_cookie)
        assert st == 200
        assert "text/html" in ct
        assert minted_id in html
        assert "عدل چیست؟" in html
        assert f"/admin/requests/{minted_id}" in html
    finally:
        stop_telemetry(server, original, orig_tel)


def test_the_detail_joins_all_five_legs(tmp_path):
    """Canned ledger, chat, Cognee, Mastra upstreams; page displays all 5 legs."""
    upstream = TelemetryUpstream()
    base, server, original, orig_tel = with_telemetry(tmp_path, upstream)
    try:
        # Seed chat row
        chat_store.record_agent_exchange(
            PHONE,
            f"learner-{PHONE}",
            "توحید چیست؟",
            "پاسخ توحید این است.",
            web_sourced=False,
            sources=[],
            request_id=SAMPLE_REQ_ID,
        )

        # Seed ledger row
        ledger.record(
            account_email_for_phone(PHONE),
            "agent",
            input_tokens=1500,
            output_tokens=300,
            metered=True,
            request_id=SAMPLE_REQ_ID,
        )

        # Seed question window
        question_window.record_question(PHONE)

        admin_cookie = cookie_for(base, ADMIN_EMAIL)
        st, ct, html = get_req(
            base, f"/admin/requests/{SAMPLE_REQ_ID}", cookie=admin_cookie
        )
        assert st == 200
        assert "text/html" in ct
        # 1) chat
        assert "توحید چیست؟" in html
        assert "پاسخ توحید این است." in html
        # 2) ledger
        assert str(SAMPLE_REQ_ID) in html
        assert "تومان" in html
        # 3) Cognee session
        assert "درباره توحید" in html or "توحید اصل دین است" in html
        # 4) Mastra trace
        assert "searchBooksTool" in html
        # 5) window state
        assert "پنجره" in html or "29" in html or "باقی‌مانده" in html
        # Links
        assert f"/admin/requests/{SAMPLE_REQ_ID}/trace.json" in html
        assert "/admin/requests" in html
    finally:
        stop_telemetry(server, original, orig_tel)


def test_the_real_tokens_are_the_models_not_the_estimate(tmp_path):
    """Canned Mastra trace with promptTokens 2400 displays 2400."""
    trace_data = {
        "traceId": SAMPLE_REQ_ID,
        "spans": [
            {
                "id": "model-span-1",
                "name": "model.generate",
                "spanType": "model_call",
                "status": "success",
                "promptTokens": 2400,
                "completionTokens": 180,
                "attributes": {
                    "promptTokens": 2400,
                    "completionTokens": 180,
                },
            }
        ],
    }
    upstream = TelemetryUpstream(mastra_trace=trace_data)
    base, server, original, orig_tel = with_telemetry(tmp_path, upstream)
    try:
        chat_store.record_agent_exchange(
            PHONE,
            f"learner-{PHONE}",
            "پرسش توکن؟",
            "پاسخ توکن.",
            request_id=SAMPLE_REQ_ID,
        )

        admin_cookie = cookie_for(base, ADMIN_EMAIL)
        st, ct, html = get_req(
            base, f"/admin/requests/{SAMPLE_REQ_ID}", cookie=admin_cookie
        )
        assert st == 200
        # Mastra model real token count 2400 is displayed
        assert "2400" in html
    finally:
        stop_telemetry(server, original, orig_tel)


def test_the_filters_survive_the_url(tmp_path):
    """?day=...&phone=... filters the list and renders back in the form."""
    upstream = TelemetryUpstream()
    base, server, original, orig_tel = with_telemetry(tmp_path, upstream)
    try:
        # Seed two requests
        req_id_1 = "1" * 32
        req_id_2 = "2" * 32
        phone_1 = "09121111111"
        phone_2 = "09122222222"

        chat_store.record_agent_exchange(
            phone_1, f"learner-{phone_1}", "پرسش اول", "پاسخ اول", request_id=req_id_1
        )
        chat_store.record_agent_exchange(
            phone_2, f"learner-{phone_2}", "پرسش دوم", "پاسخ دوم", request_id=req_id_2
        )

        admin_cookie = cookie_for(base, ADMIN_EMAIL)
        query = f"?day=2026-10-23&phone={phone_1}&dataset=tarhe-kolli&status=ok"
        st, ct, html = get_req(base, f"/admin/requests{query}", cookie=admin_cookie)
        assert st == 200

        # Verify filter inputs maintain their values in the form
        assert 'name="day" value="2026-10-23"' in html
        assert f'name="phone" value="{phone_1}"' in html
        assert 'name="dataset" value="tarhe-kolli"' in html
        assert 'name="status" value="ok"' in html

        # Verify filtering worked: req_id_1 present, req_id_2 excluded
        assert req_id_1 in html
        assert req_id_2 not in html
    finally:
        stop_telemetry(server, original, orig_tel)


def test_the_trace_downloads_as_json(tmp_path):
    """GET /admin/requests/<id>/trace.json returns the joined dict as JSON."""
    upstream = TelemetryUpstream()
    base, server, original, orig_tel = with_telemetry(tmp_path, upstream)
    try:
        chat_store.record_agent_exchange(
            PHONE, f"learner-{PHONE}", "پرسش جی‌سان", "پاسخ جی‌سان", request_id=SAMPLE_REQ_ID
        )
        ledger.record(
            account_email_for_phone(PHONE),
            "agent",
            input_tokens=100,
            output_tokens=50,
            metered=True,
            request_id=SAMPLE_REQ_ID,
        )

        admin_cookie = cookie_for(base, ADMIN_EMAIL)
        st, ct, body = get_req(
            base, f"/admin/requests/{SAMPLE_REQ_ID}/trace.json", cookie=admin_cookie
        )
        assert st == 200
        assert "application/json" in ct
        data = json.loads(body)
        assert data["request_id"] == SAMPLE_REQ_ID
        assert "ledger" in data
        assert "chat" in data
        assert "cognee" in data
        assert "mastra" in data
        assert "window" in data
    finally:
        stop_telemetry(server, original, orig_tel)


def test_a_missing_leg_says_so(tmp_path):
    """Cognee/Mastra unreachable renders explicit absence note."""
    upstream = TelemetryUpstream(
        cognee_error=urllib.error.URLError("Connection refused to Cognee"),
        mastra_error=urllib.error.HTTPError(
            "http://127.0.0.1:4111", 503, "Service Unavailable", {}, None
        ),
    )
    base, server, original, orig_tel = with_telemetry(tmp_path, upstream)
    try:
        chat_store.record_agent_exchange(
            PHONE, f"learner-{PHONE}", "پرسش تست فقدان", "پاسخ تست فقدان", request_id=SAMPLE_REQ_ID
        )

        admin_cookie = cookie_for(base, ADMIN_EMAIL)
        st, ct, html = get_req(
            base, f"/admin/requests/{SAMPLE_REQ_ID}", cookie=admin_cookie
        )
        assert st == 200
        # The page does not crash and renders honest absence
        assert "در دسترس نیست" in html or "یافت نشد" in html
        assert "پرسش تست فقدان" in html
    finally:
        stop_telemetry(server, original, orig_tel)


def test_the_page_never_breaks_the_answer(tmp_path):
    """Errors reading telemetry never break user answers."""
    upstream = TelemetryUpstream(
        agent_replies=[
            sse_lines(
                [
                    start_frame(),
                    text_delta("پاسخ سالم حتی در خرابی تله‌متری"),
                    finish_frame(),
                ]
            )
        ],
        cognee_error=urllib.error.URLError("Cognee completely dead"),
        mastra_error=urllib.error.URLError("Mastra completely dead"),
    )
    base, server, original, orig_tel = with_telemetry(tmp_path, upstream)
    try:
        # User answer completes successfully
        st, body = post_agent_chat(base, {"query": "آیا پاسخ داده می‌شود؟"})
        assert st == 200
        assert "پاسخ سالم حتی در خرابی تله‌متری" in body
    finally:
        stop_telemetry(server, original, orig_tel)


def test_db_connections_are_always_closed(tmp_path, monkeypatch):
    """Verify no connection descriptor leaks: every con is closed in finally."""
    chat_store.CHAT_DB = tmp_path / "chats.sqlite3"
    ledger.LEDGER_DB = str(tmp_path / "ledger.sqlite3")

    connections_closed = []

    class ConnectionWrapper:
        def __init__(self, real_conn, record):
            self.__dict__["_real"] = real_conn
            self.__dict__["_record"] = record

        def close(self):
            self._record["closed"] = True
            self._real.close()

        def __getattr__(self, name):
            return getattr(self._real, name)

        def __setattr__(self, name, val):
            setattr(self._real, name, val)

    orig_chat_connect = chat_store._connect
    orig_ledger_connect = ledger._connect

    def spy_chat_connect():
        record = {"closed": False}
        connections_closed.append(record)
        return ConnectionWrapper(orig_chat_connect(), record)

    def spy_ledger_connect():
        record = {"closed": False}
        connections_closed.append(record)
        return ConnectionWrapper(orig_ledger_connect(), record)

    monkeypatch.setattr(chat_store, "_connect", spy_chat_connect)
    monkeypatch.setattr(ledger, "_connect", spy_ledger_connect)

    # 1. chat_store.get_chat_by_request_id strictly closes its connection
    connections_closed.clear()
    chat_store.get_chat_by_request_id("any-request-id")
    assert len(connections_closed) == 1
    assert connections_closed[0]["closed"], "chat_store.get_chat_by_request_id left connection unclosed!"

    # 2. chat_store.list_recent_chats_by_request strictly closes its connection
    connections_closed.clear()
    chat_store.list_recent_chats_by_request(limit=10)
    assert len(connections_closed) == 1
    assert connections_closed[0]["closed"], "chat_store.list_recent_chats_by_request left connection unclosed!"

    # 3. ledger.get_entries_by_request_id strictly closes its connection
    connections_closed.clear()
    ledger.get_entries_by_request_id("any-request-id")
    assert len(connections_closed) == 1
    assert connections_closed[0]["closed"], "ledger.get_entries_by_request_id left connection unclosed!"

    # 4. ledger.get_request_usage_summary strictly closes its connection
    connections_closed.clear()
    ledger.get_request_usage_summary()
    assert len(connections_closed) == 1
    assert connections_closed[0]["closed"], "ledger.get_request_usage_summary left connection unclosed!"

    # 5. recent_requests closes all connections (chat_store and ledger)
    connections_closed.clear()
    telemetry.recent_requests()
    assert len(connections_closed) >= 2
    assert all(c["closed"] for c in connections_closed), "A connection was left unclosed in recent_requests!"

    # 6. request_view closes all connections (ledger, chat)
    connections_closed.clear()
    # Mock urlopen so network calls don't hang or fail
    monkeypatch.setattr(telemetry, "urlopen", lambda req, timeout=None: _Reply(b"{}"))
    telemetry.request_view("any-request-id")
    assert len(connections_closed) == 2
    assert all(c["closed"] for c in connections_closed), "A connection was left unclosed in request_view!"


def test_fetch_mastra_trace_query_fallback(monkeypatch):
    """Verify _fetch_mastra_trace falls back from GET to POST query gracefully."""
    calls = []

    def mock_urlopen(request, timeout=None):
        url = request.full_url
        method = request.get_method()
        calls.append((method, url))
        if method == "GET":
            # Simulate 404 or failure on GET
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
        elif method == "POST" and "/api/observability/traces/query" in url:
            body = json.loads(request.data.decode("utf-8"))
            if body.get("traceId") == SAMPLE_REQ_ID:
                return _Reply(
                    json.dumps({
                        "traces": [{
                            "traceId": SAMPLE_REQ_ID,
                            "spans": [{"id": "s1", "name": "root"}],
                        }]
                    }).encode("utf-8")
                )
        raise urllib.error.HTTPError(url, 500, "Unexpected", {}, None)

    monkeypatch.setattr(telemetry, "urlopen", mock_urlopen)

    data = telemetry._fetch_mastra_trace(SAMPLE_REQ_ID)
    assert data.get("traceId") == SAMPLE_REQ_ID
    assert len(data.get("spans", [])) == 1
    # Check that both GET and POST were called
    assert ("GET", f"{telemetry._mastra_url()}/api/observability/traces/{SAMPLE_REQ_ID}") in calls
    assert ("POST", f"{telemetry._mastra_url()}/api/observability/traces/query") in calls


def test_telemetry_list_shows_duration_and_tokens():
    """Verify telemetry_list_html displays Duration and Tokens columns."""
    sample_items = [
        {
            "request_id": "req-1",
            "ts": "2026-10-23T12:00:00",
            "phone": "09120000000",
            "question": "پرسش مدت و توکن",
            "datasets": ["tarhe-kolli"],
            "duration": "1.8s",
            "tokens": 4200,
            "cost_toman": 150,
            "has_answer": True,
        }
    ]
    page_html = telemetry.telemetry_list_html(sample_items)
    # Check table headers
    assert "مدت زمان" in page_html
    assert "توکن‌ها" in page_html
    # Check row data
    assert "1.8s" in page_html
    assert "4,200" in page_html
    assert "150 تومان" in page_html


def test_telemetry_detail_links_to_mastra_studio():
    """Verify telemetry_detail_html includes link to Mastra Studio."""
    view_data = {
        "request_id": SAMPLE_REQ_ID,
        "phone": PHONE,
        "ledger": [],
        "chat": {"question": "پرسش استودیو", "answer": "پاسخ استودیو"},
        "cognee": None,
        "mastra": {"spans": [{"name": "agent.run", "id": "sp-1"}]},
        "window": {},
    }
    html = telemetry.telemetry_detail_html(view_data)
    mastra_url = telemetry._mastra_url()
    assert mastra_url in html
    assert "استودیو Mastra" in html


def test_storage_deepening_domain_queries(tmp_path):
    """Verify high-level domain query methods on chat_store and ledger."""
    chat_store.CHAT_DB = tmp_path / "chats.sqlite3"
    ledger.LEDGER_DB = str(tmp_path / "ledger.sqlite3")

    req_agent = "agent-req-001"
    req_ask = "ask-req-002"

    # 1. Seed agent chat
    chat_store.record_agent_exchange(
        phone="09121111111",
        thread_id="th-1",
        question="پرسش عامل",
        answer="پاسخ عامل",
        web_sourced=True,
        sources=[{"title": "منبع ۱", "url": "http://example.com/1"}],
        request_id=req_agent,
    )

    # 2. Seed ask chat
    chat_store.create_chat(
        chat_id="chat-ask-1",
        phone="09122222222",
        question="پرسش سنتی",
        datasets=["tarhe-kolli", "velayat"],
        sources=[{"title": "منبع ۲", "passage": "متن"}],
        request_id=req_ask,
    )

    # 3. Test get_chat_by_request_id for agent chat
    res_agent = chat_store.get_chat_by_request_id(req_agent)
    assert res_agent is not None
    assert res_agent["request_id"] == req_agent
    assert res_agent["phone"] == "09121111111"
    assert res_agent["account"] == "09121111111"
    assert res_agent["question"] == "پرسش عامل"
    assert res_agent["answer"] == "پاسخ عامل"
    assert res_agent["is_agent"] is True
    assert isinstance(res_agent["sources"], list)
    assert len(res_agent["sources"]) == 1
    assert res_agent["sources"][0]["title"] == "منبع ۱"
    assert res_agent["duration"] is None

    # 4. Test get_chat_by_request_id for ask chat
    res_ask = chat_store.get_chat_by_request_id(req_ask)
    assert res_ask is not None
    assert res_ask["request_id"] == req_ask
    assert res_ask["phone"] == "09122222222"
    assert res_ask["question"] == "پرسش سنتی"
    assert res_ask["answer"] == ""
    assert res_ask["is_agent"] is False
    assert res_ask["datasets"] == ["tarhe-kolli", "velayat"]
    assert isinstance(res_ask["sources"], list)
    assert res_ask["created_at"] is not None

    # 5. Test get_chat_by_request_id missing
    assert chat_store.get_chat_by_request_id("non-existent-id") is None
    assert chat_store.get_chat_by_request_id("") is None

    # 6. Test list_recent_chats_by_request
    recent = chat_store.list_recent_chats_by_request(limit=10)
    assert len(recent) == 2
    req_ids = [r["request_id"] for r in recent]
    assert req_agent in req_ids
    assert req_ask in req_ids

    # 7. Seed ledger entries for req_agent
    ledger.record("09121111111", "agent", input_tokens=100, output_tokens=50, metered=True, request_id=req_agent)
    ledger.record("09121111111", "agent", input_tokens=200, output_tokens=100, metered=False, request_id=req_agent)

    # 8. Test ledger.get_entries_by_request_id
    entries = ledger.get_entries_by_request_id(req_agent)
    assert len(entries) == 2
    assert entries[0]["input_tokens"] == 100
    assert entries[0]["output_tokens"] == 50
    assert entries[0]["metered"] is True
    assert entries[0]["is_metered"] is True
    assert "amount_toman" in entries[0]
    assert "cost_toman" in entries[0]
    assert entries[0]["phone"] == "09121111111"
    assert entries[0]["raw_json"] is None
    assert entries[1]["metered"] is False

    assert ledger.get_entries_by_request_id("non-existent-id") == []
    assert ledger.get_entries_by_request_id("") == []

    # 9. Test ledger.get_request_usage_summary
    summary = ledger.get_request_usage_summary()
    assert req_agent in summary
    agent_summary = summary[req_agent]
    assert agent_summary["input_tokens"] == 300
    assert agent_summary["output_tokens"] == 150
    assert agent_summary["tokens"] == 450
    assert agent_summary["cost_toman"] == entries[0]["cost_toman"] + entries[1]["cost_toman"]
    assert agent_summary["metered"] is True
    assert agent_summary["phone"] == "09121111111"
    assert agent_summary["account"] == "09121111111"
    assert agent_summary["ts"] is not None
