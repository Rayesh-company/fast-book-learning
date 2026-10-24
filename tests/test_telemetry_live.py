"""End-to-end verification against the live stack (spec 0025 Task 7).

Opt-in test: skipped unless TELEMETRY_LIVE=1 in environment.
Exercises the full live loop against real Cognee and real Mastra containers,
verifying that ONE request_id is stamped everywhere:
1. Mastra trace store
2. Cognee session cache
3. SQLite usage_entries
4. SQLite agent_chats
5. /admin/requests/<id> joined view
6. /admin/requests/<id>/trace.json
"""

from __future__ import annotations

import json
import os
import sqlite3
import urllib.request
import urllib.parse
import pytest

from tests.helpers import ADMIN_EMAIL, TEST_PASSWORD

LIVE_SESSION_URL = os.environ.get("LIVE_SESSION_URL", "http://127.0.0.1:8765").rstrip("/")
LIVE_AGENT_URL = os.environ.get("AGENT_URL", "http://127.0.0.1:4111").rstrip("/")
LIVE_COGNEE_URL = os.environ.get("COGNEE_URL", "http://127.0.0.1:8000").rstrip("/")
TEST_PHONE = os.environ.get("TELEMETRY_TEST_PHONE", "09120000001")


@pytest.mark.skipif(
    os.environ.get("TELEMETRY_LIVE") != "1",
    reason="Live stack test only; opt-in with TELEMETRY_LIVE=1",
)
def test_one_request_is_one_id_everywhere():
    """Verify that a live request carries one request_id into all five legs."""
    # 1. Login as test user
    login_req = urllib.request.Request(
        f"{LIVE_SESSION_URL}/auth/login",
        data=json.dumps({"phone": TEST_PHONE}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(login_req, timeout=10) as resp:
        cookie = resp.headers.get("Set-Cookie")
        assert cookie, "Login failed to set session cookie"

    # 2. Fire live /agent/chat
    chat_payload = {
        "query": "توحید در قرآن چیست؟",
        "datasets": ["tarhe-kolli"],
    }
    chat_req = urllib.request.Request(
        f"{LIVE_SESSION_URL}/agent/chat",
        data=json.dumps(chat_payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Cookie": cookie},
        method="POST",
    )
    with urllib.request.urlopen(chat_req, timeout=60) as resp:
        assert resp.status == 200
        raw_stream = resp.read().decode("utf-8")
        assert "chat-answer-finalized" in raw_stream

    # Extract minted request_id from local chat_store or trace
    from ui import chat_store, ledger
    con = chat_store._connect()
    row = con.execute(
        "SELECT request_id, answer FROM agent_chats WHERE phone = ? ORDER BY rowid DESC LIMIT 1",
        (TEST_PHONE,),
    ).fetchone()
    assert row, "agent_chats row not found"
    request_id, answer = row[0], row[1]
    assert request_id, "request_id must not be empty"
    assert len(request_id) == 32, "request_id must be 32 hex chars"

    # 3. Verify ledger carries the same request_id
    with ledger._connect() as lcon:
        lrows = lcon.execute(
            "SELECT request_id, cost_toman FROM usage_entries WHERE request_id = ?",
            (request_id,),
        ).fetchall()
        assert len(lrows) >= 1, "ledger must record row with request_id"
        assert lrows[0][0] == request_id

    # 4. Verify Mastra trace exists
    mastra_url = f"{LIVE_AGENT_URL}/api/observability/traces/{request_id}"
    req = urllib.request.Request(mastra_url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        assert resp.status == 200
        trace_json = json.loads(resp.read().decode("utf-8"))
        assert trace_json.get("traceId") == request_id
        assert "spans" in trace_json

    # 5. Verify Cognee session exists
    cognee_url = f"{LIVE_COGNEE_URL}/api/v1/sessions/{request_id}"
    req = urllib.request.Request(cognee_url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        assert resp.status == 200
        session_json = json.loads(resp.read().decode("utf-8"))
        assert session_json is not None

    # 6. Login as Admin and verify /admin/requests/<id>
    admin_login_req = urllib.request.Request(
        f"{LIVE_SESSION_URL}/auth/login",
        data=json.dumps({"email": ADMIN_EMAIL, "password": TEST_PASSWORD}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(admin_login_req, timeout=10) as resp:
        admin_cookie = resp.headers.get("Set-Cookie")
        assert admin_cookie, "Admin login failed"

    # Admin detail HTML
    req = urllib.request.Request(
        f"{LIVE_SESSION_URL}/admin/requests/{request_id}",
        headers={"Cookie": admin_cookie},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        assert resp.status == 200
        html = resp.read().decode("utf-8")
        assert request_id in html
        assert "توحید در قرآن چیست؟" in html

    # Admin JSON trace download
    req = urllib.request.Request(
        f"{LIVE_SESSION_URL}/admin/requests/{request_id}/trace.json",
        headers={"Cookie": admin_cookie},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        assert resp.status == 200
        trace_doc = json.loads(resp.read().decode("utf-8"))
        assert trace_doc["request_id"] == request_id
        assert "ledger" in trace_doc
        assert "chat" in trace_doc
        assert "cognee" in trace_doc
        assert "mastra" in trace_doc
        assert "window" in trace_doc
