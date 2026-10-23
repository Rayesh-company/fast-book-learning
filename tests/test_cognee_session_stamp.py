"""The Cognee session leg (spec 0025 §4, plan Task 2): stamp the read,
write the answer.

Stamping request_id as Cognee's session_id joins the retrieval call and
the completed Q&A exchange into Cognee's session store under the same
identity the ledger and chat stores carry. Cognee's only_context=True
retrieval does not write to the session, so the completed exchange lands
via POST /api/v1/remember/entry. Telemetry failures never break an answer,
and /agent/recall carries session_id without metering (ADR-0018)."""

import json
import os
import re
import socket
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from tests.conftest import REPO_ROOT
from tests.helpers import (
    FakeResponse,
    account_email_for_phone,
    cookie_for,
    ensure_account,
    post,
    stop_gate,
    with_gate,
)
from tests.test_agent_chat import (
    StreamResponse,
    agent_stream_ok,
    finish_frame,
    sse_lines,
    start_frame,
    text_delta,
)
from tests.test_agent_recall import agent_post
from tests.test_ask import (
    _Reply,
    only_context_reply,
    sample_document,
)

sys.path.insert(0, str(REPO_ROOT))

from ui import ask, chat_store, ledger, question_window, serve, telemetry  # noqa: E402

PHONE = "09120000000"
HEX32 = re.compile(r"^[0-9a-f]{32}$")


class CogneeSessionUpstream:
    """Scripted upstream combining Cognee recall, remember, and agent streaming."""

    def __init__(self, agent_replies=None, documents=None, remember_error=None):
        self.agent_replies = [
            reply.encode("utf-8") if isinstance(reply, str) else reply
            for reply in (agent_replies or [])
        ]
        self.documents = list(
            documents or [sample_document("Page 10:"), sample_document("Page 30:")]
        )
        self.remember_error = remember_error
        self.recall_bodies = []
        self.remember_bodies = []
        self.agent_payloads = []

    def __call__(self, request, timeout=None):
        url = request.full_url
        data = request.data.decode("utf-8") if request.data else "{}"
        if "/api/v1/recall" in url:
            payload = json.loads(data)
            self.recall_bodies.append(payload)
            doc = self.documents.pop(0) if self.documents else ""
            return _Reply(only_context_reply(doc))
        if "/api/v1/remember/entry" in url:
            payload = json.loads(data)
            self.remember_bodies.append(payload)
            if self.remember_error:
                raise self.remember_error
            return _Reply(b'{"status": "ok"}')
        if "/stream" in url or "/agent" in url:
            payload = json.loads(data)
            self.agent_payloads.append(payload)
            item = self.agent_replies.pop(0)
            if isinstance(item, Exception):
                raise item
            if isinstance(item, list):
                return StreamResponse(item)
            return FakeResponse(item)
        raise AssertionError(f"unexpected upstream call: {url}")


def with_cognee(tmp_path, upstream):
    """Run gate with CogneeSessionUpstream handling both the gate's upstreams
    and telemetry.urlopen."""
    question_window.WINDOW_DB = tmp_path / "window.sqlite3"
    orig_telemetry = telemetry.urlopen
    telemetry.urlopen = upstream
    base, server, original = with_gate(tmp_path, upstream)
    return base, server, original, orig_telemetry


def stop_cognee(server, original, orig_telemetry):
    try:
        stop_gate(server, original)
    finally:
        telemetry.urlopen = orig_telemetry


def ask_agent(base, payload, phone=PHONE):
    """POST /agent/chat helper for streaming response frames."""
    ensure_account(phone)
    cookie = cookie_for(base, account_email_for_phone(phone))
    request = urllib.request.Request(
        base + "/agent/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Cookie": cookie},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            status = response.status
            ctype = response.headers.get("Content-Type", "")
            body = response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get("Content-Type", ""), json.load(exc)
    frames = []
    if "text/event-stream" in ctype:
        for event in body.split(b"\n\n"):
            if not event.startswith(b"data: "):
                continue
            try:
                frames.append(json.loads(event[len(b"data: ") :]))
            except ValueError:
                pass
    return status, ctype, frames


def test_the_recall_post_carries_the_session_id(tmp_path):
    # 1. Unit seam: only_context_request includes session_id if provided
    req = ask.only_context_request("tarhe-kolli", "پرسش؟", session_id="abc123def456")
    body = json.loads(req.data.decode("utf-8"))
    assert body["session_id"] == "abc123def456"
    assert body["datasets"] == ["tarhe-kolli"]
    assert body["only_context"] is True

    # When session_id is None, it is not present
    req_no_session = ask.only_context_request("tarhe-kolli", "پرسش؟", session_id=None)
    body_no_session = json.loads(req_no_session.data.decode("utf-8"))
    assert "session_id" not in body_no_session

    # 2. End-to-end /ask route: recall POST carries the minted request_id
    upstream = CogneeSessionUpstream()
    base, server, original, orig_telem = with_cognee(tmp_path, upstream)
    try:
        ensure_account(PHONE)
        status, payload = post(
            base,
            "/ask",
            {"query": "پرسش برای بازیابی؟", "datasets": ["tarhe-kolli"]},
            phone=PHONE,
        )
    finally:
        stop_cognee(server, original, orig_telem)

    assert status == 200
    request_id = payload.get("request_id")
    assert request_id and HEX32.match(request_id)
    assert len(upstream.recall_bodies) == 1
    assert upstream.recall_bodies[0]["session_id"] == request_id
    assert upstream.recall_bodies[0]["query"] == "پرسش برای بازیابی؟"
    assert upstream.recall_bodies[0]["datasets"] == ["tarhe-kolli"]

    # Also verify the ask completed answer write
    assert len(upstream.remember_bodies) == 1
    remember = upstream.remember_bodies[0]
    assert remember["session_id"] == request_id
    assert remember["entry"]["question"] == "پرسش برای بازیابی؟"
    assert remember["entry"]["answer"] == ""
    assert remember["dataset_name"] == "tarhe-kolli"


def test_the_completed_answer_lands_as_a_cognee_qa_entry(tmp_path):
    upstream = CogneeSessionUpstream(
        agent_replies=[agent_stream_ok("پاسخ کامل عامل به پرسش")]
    )
    base, server, original, orig_telem = with_cognee(tmp_path, upstream)
    try:
        status, _, frames = ask_agent(
            base,
            {"query": "پرسش اصلی؟", "datasets": ["tarhe-kolli"]},
            phone=PHONE,
        )
    finally:
        stop_cognee(server, original, orig_telem)

    assert status == 200
    finalized = [f for f in frames if f.get("type") == "chat-answer-finalized"]
    assert len(finalized) == 1
    assert finalized[0]["answer"] == "پاسخ کامل عامل به پرسش"

    # Verify Cognee QA entry write
    assert len(upstream.remember_bodies) == 1
    remember = upstream.remember_bodies[0]
    assert remember["entry"] == {
        "type": "qa",
        "question": "پرسش اصلی؟",
        "answer": "پاسخ کامل عامل به پرسش",
    }
    assert HEX32.match(remember["session_id"])
    assert remember["dataset_name"] == "tarhe-kolli"

    # Verify session_id matches the traceId sent to Mastra
    trace_id = upstream.agent_payloads[0]["tracingOptions"]["traceId"]
    assert remember["session_id"] == trace_id


def test_a_failed_cognee_write_never_breaks_the_answer(tmp_path):
    http_error = urllib.error.HTTPError(
        "http://127.0.0.1:8000/api/v1/remember/entry",
        500,
        "Internal Server Error",
        {},
        None,
    )
    upstream = CogneeSessionUpstream(
        agent_replies=[agent_stream_ok("پاسخ با وجود خطای تله‌متری")],
        remember_error=http_error,
    )
    base, server, original, orig_telem = with_cognee(tmp_path, upstream)
    try:
        status, _, frames = ask_agent(
            base,
            {"query": "پرسش با شکست تله‌متری؟", "datasets": ["tarhe-kolli"]},
            phone=PHONE,
        )
    finally:
        stop_cognee(server, original, orig_telem)

    # The failure in telemetry must not break the answer
    assert status == 200
    finalized = [f for f in frames if f.get("type") == "chat-answer-finalized"]
    assert len(finalized) == 1
    assert finalized[0]["answer"] == "پاسخ با وجود خطای تله‌متری"

    # The exchange is still recorded in the database
    history = chat_store.agent_conversation(PHONE)
    assert len(history) == 1
    assert history[0]["question"] == "پرسش با شکست تله‌متری؟"
    assert history[0]["answer"] == "پاسخ با وجود خطای تله‌متری"


def test_the_agent_seam_carries_the_session_id_without_metering(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_SERVICE_TOKEN", "agent-secret")
    upstream = CogneeSessionUpstream()
    base, server, original, orig_telem = with_cognee(tmp_path, upstream)
    try:
        session_id = "0123456789abcdef0123456789abcdef"
        status, payload = agent_post(
            base,
            {
                "query": "پرسش از ابزار؟",
                "datasets": ["tarhe-kolli"],
                "session_id": session_id,
            },
            token="agent-secret",
        )
    finally:
        stop_cognee(server, original, orig_telem)

    assert status == 200
    assert "passages" in payload
    assert len(payload["passages"]) > 0

    # The recall POST carried the session_id
    assert len(upstream.recall_bodies) == 1
    assert upstream.recall_bodies[0]["session_id"] == session_id
    assert upstream.recall_bodies[0]["query"] == "پرسش از ابزار؟"

    # ADR-0018: no ledger entry, no chat row, no metering
    assert serve.chats_today(PHONE) == 0
    con = ledger._connect()
    try:
        ledger_count = con.execute("SELECT count(*) FROM usage_entries").fetchone()[0]
    finally:
        con.close()
    assert ledger_count == 0

    con_chat = chat_store._connect()
    try:
        chats_count = con_chat.execute("SELECT count(*) FROM chats").fetchone()[0]
        agent_chats_count = con_chat.execute("SELECT count(*) FROM agent_chats").fetchone()[0]
    finally:
        con_chat.close()
    assert chats_count == 0
    assert agent_chats_count == 0


def test_an_abandoned_agent_chat_stream_writes_zero_remember_entries(tmp_path):
    """Completion-anchoring (spec 0025 §4, ADR-0018): an abandoned mid-stream
    (client disconnect or stream error) never produces a Cognee remember entry call."""
    # 1. Mid-stream upstream error (stream error): the upstream dies mid-read
    lines = (
        sse_lines([start_frame(), text_delta("نیمه‌کار")])[:-2]
        + [OSError("connection reset mid-stream")]
    )
    upstream = CogneeSessionUpstream(agent_replies=[lines])
    base, server, original, orig_telem = with_cognee(tmp_path, upstream)
    try:
        status, _, frames = ask_agent(
            base,
            {"query": "پرسش ناتمام با خطای سرور؟", "datasets": ["tarhe-kolli"]},
            phone=PHONE,
        )
        assert status == 200
        assert "chat-answer-error" in [f.get("type") for f in frames]
        assert "chat-answer-finalized" not in [f.get("type") for f in frames]
        assert len(upstream.remember_bodies) == 0
        assert len(chat_store.agent_conversation(PHONE)) == 0

        # 2. Client disconnect: the client drops connection mid-stream (ABANDONED)
        upstream.agent_replies = [
            agent_stream_ok("پاسخی که ناتمام می‌ماند چون کاربر قطع می‌کند")
        ]
        host, port = base.replace("http://", "").split(":")
        cookie = cookie_for(base, account_email_for_phone(PHONE))
        body = json.dumps(
            {"query": "پرسش با قطعی کاربر؟", "datasets": ["tarhe-kolli"]}
        ).encode("utf-8")
        req_bytes = (
            f"POST /agent/chat HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Cookie: {cookie}\r\n\r\n"
        ).encode("utf-8") + body

        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.connect((host, int(port)))
            s.sendall(req_bytes)
            # Read initial chunk so server has started streaming
            s.recv(128)
            # Abruptly reset TCP connection
            s.setsockopt(
                socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0)
            )
        finally:
            s.close()

        # Give server thread a moment to handle disconnect
        time.sleep(0.2)

        # Still 0 remember entries (completion-anchored)
        assert len(upstream.remember_bodies) == 0
        assert len(chat_store.agent_conversation(PHONE)) == 0
    finally:
        stop_cognee(server, original, orig_telem)

