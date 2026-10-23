"""The request id (spec 0025 §1): ONE identity minted at the session
service's request boundary, before any downstream call, and stamped on
every store the request touches. Today a learner request has three
separate identities — the chat row's id, the agent thread, Cognee's own
session key — and answering "what happened in this one request" means
reading three stores by hand. This module pins the join key at the seams
the spec names as the test surface: the Mastra body's
`tracingOptions.traceId` (32 lowercase hex, the shape Mastra accepts),
the `usage_entries` row, and the `agent_chats` / `chats` rows all carry
the SAME minted id, the stores gain their columns through the guarded
ALTER the chat store already uses (a rebuild keeps existing rows), and
the issue #26 rule holds: an abandoned stream stamps nothing.

The Mastra upstream is the canned `AgentUpstream` from
tests/test_agent_chat.py (payloads captured at ui.agent_client's urlopen
seam, scripted Farsi replies), and the Cognee upstream is the canned
`AskUpstream` from tests/test_ask.py — the repo's existing seams, not a
new scaffolding."""

import json
import os
import re
import socket
import sqlite3
import sys
import threading
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
    AgentUpstream,
    agent_stream_ok,
    finish_frame,
    sse_lines,
    start_frame,
    text_delta,
)
from tests.test_ask import AskUpstream, sample_document

sys.path.insert(0, str(REPO_ROOT))

from ui import agent_client, chat_store, ledger, question_window  # noqa: E402

PHONE = "09120000000"

# The join key's shape: 32 lowercase hex, exactly what Mastra accepts as
# tracingOptions.traceId (1-32 hex).
HEX32 = re.compile(r"^[0-9a-f]{32}$")


def with_agent(tmp_path, replies):
    """The gate + the canned agent, with the Question window in the
    test's own file (the tests/test_agent_chat.py pattern)."""
    question_window.WINDOW_DB = tmp_path / "window.sqlite3"
    upstream = AgentUpstream(replies)
    return (upstream,) + with_gate(tmp_path, upstream)


def ask_agent(base, payload, phone=PHONE):
    """One POST /agent/chat read to the stream's close-delimited end;
    (status, content type, frames) — the tests/test_agent_chat.py client."""
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


class OneFrameThenStall(FakeResponse):
    """The upstream opens the stream, says one word, and goes silent:
    the relay writes what it has, the gone Learner makes the next write
    fail, and the leash ends the stream with the honest error frame —
    the abandoned shape, with no terminator so no answer ever completes."""

    def __init__(self):
        super().__init__(b"")
        self._lines = sse_lines([start_frame(), text_delta("نیمه‌کار")])[:-2]
        self._closed = threading.Event()

    def readline(self):
        if self._lines:
            return self._lines.pop(0)
        self._closed.wait(timeout=30)
        return b""

    def close(self):
        self._closed.set()


def abandon_stream(base, payload, phone=PHONE):
    """POST /agent/chat over a raw socket, read what the wire gives up to
    the first frame, then close the connection — the Learner walked away
    mid-stream. Returns the bytes the Learner saw before leaving."""
    ensure_account(phone)
    cookie = cookie_for(base, account_email_for_phone(phone))
    host, port = urllib.parse.urlparse(base).hostname, urllib.parse.urlparse(base).port
    body = json.dumps(payload).encode("utf-8")
    sock = socket.create_connection((host, port), timeout=15)
    head = (
        f"POST /agent/chat HTTP/1.1\r\nHost: {host}\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Cookie: {cookie}\r\n"
        "Connection: close\r\n\r\n"
    ).encode("utf-8")
    sock.sendall(head + body)
    seen = b""
    while b"data: " not in seen:
        chunk = sock.recv(4096)
        if not chunk:
            break
        seen += chunk
    sock.close()
    return seen


def ledger_rows():
    """The usage_entries rows in write order, the minted id read off each."""
    con = ledger._connect()
    try:
        rows = con.execute(
            "SELECT kind, account, request_id FROM usage_entries ORDER BY id"
        ).fetchall()
    finally:
        con.close()
    return [{"kind": r[0], "account": r[1], "request_id": r[2]} for r in rows]


def chat_rows():
    """The ask rows in write order, the minted id read off each."""
    con = chat_store._connect()
    try:
        rows = con.execute(
            "SELECT id, phone, question, request_id FROM chats ORDER BY rowid"
        ).fetchall()
    finally:
        con.close()
    return [{"id": r[0], "phone": r[1], "question": r[2], "request_id": r[3]} for r in rows]


def agent_chat_rows():
    """The agent exchange rows in write order, the minted id read off each."""
    con = chat_store._connect()
    try:
        rows = con.execute(
            "SELECT phone, thread_id, question, request_id FROM agent_chats ORDER BY rowid"
        ).fetchall()
    finally:
        con.close()
    return [
        {"phone": r[0], "thread_id": r[1], "question": r[2], "request_id": r[3]}
        for r in rows
    ]


# --- the agent path: one id, minted before any downstream call ----------


def test_the_agent_body_carries_a_32_hex_trace_id(tmp_path):
    # The request id rides the ONE body both routes carry, as the trace
    # id Mastra nests its root span under — 32 lowercase hex, the shape
    # reference-agents-generate.md pins, and the same value the
    # requestContext names so the tool can read it.
    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("پاسخ عامل با استناد")]
    )
    try:
        status, _, frames = ask_agent(
            base, {"query": "پرسش؟", "datasets": ["tarhe-kolli"]}
        )
    finally:
        stop_gate(server, original)
    assert status == 200
    assert frames[-1]["type"] == "chat-answer-finalized"
    payload = upstream.payloads[0]
    trace_id = payload["tracingOptions"]["traceId"]
    assert HEX32.match(trace_id), f"the trace id is not 32 lowercase hex: {trace_id!r}"
    assert payload["requestContext"]["requestId"] == trace_id
    # The trace metadata names the thread the memory write lands on, so
    # Studio's row points back at the conversation the request joined.
    assert payload["tracingOptions"]["metadata"] == {
        "thread": payload["memory"]["thread"],
        "resource": payload["memory"]["resource"],
    }
    assert payload["tracingOptions"]["requestContextKeys"] == [
        "datasets",
        "userProfile",
        "pageContext",
        "selectionText",
    ]


def test_the_ledger_row_carries_the_same_request_id(tmp_path):
    # The gate records the Question's size estimate BEFORE the stream
    # runs, so the minted id must exist before that write — the ledger
    # row is the request's own spend, keyed by the same id the body
    # carries.
    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("پاسخ عامل")]
    )
    try:
        status, _, frames = ask_agent(base, {"query": "پرسش؟"})
        rows = ledger_rows()
    finally:
        stop_gate(server, original)
    assert status == 200
    trace_id = upstream.payloads[0]["tracingOptions"]["traceId"]
    agent_rows = [r for r in rows if r["kind"] == "agent"]
    assert len(agent_rows) == 1, "one request, one ledger row"
    assert agent_rows[0]["request_id"] == trace_id
    assert agent_rows[0]["account"] == account_email_for_phone(PHONE)


def test_the_agent_chat_row_carries_the_same_request_id(tmp_path):
    # The persisted exchange — the reload's restore record — carries the
    # same id, so the join page reads the answer text by the request's
    # own key.
    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("پاسخ عامل")]
    )
    try:
        status, _, frames = ask_agent(base, {"query": "پرسش؟"})
        rows = agent_chat_rows()
    finally:
        stop_gate(server, original)
    assert status == 200
    trace_id = upstream.payloads[0]["tracingOptions"]["traceId"]
    assert len(rows) == 1, "one answered message, one exchange"
    assert rows[0]["request_id"] == trace_id
    assert rows[0]["thread_id"] == f"learner-{PHONE}"
    assert rows[0]["question"] == "پرسش؟"


# --- the ask path: the same minting ---------------------------------------


def test_the_ask_ledger_row_carries_the_request_id(tmp_path):
    # The ask path mints the same shape and stamps it on the gate's size
    # estimate, the chat row, and the reply the sheet gets back.
    upstream = AskUpstream([sample_document("Page 10:")])
    base, server, original = with_gate(tmp_path, upstream)
    try:
        status, payload = post(
            base, "/ask", {"query": "پرسش؟", "datasets": ["tarhe-kolli"]}, phone=PHONE
        )
        rows = ledger_rows()
        chats = chat_rows()
    finally:
        stop_gate(server, original)
    assert status == 200
    request_id = payload["request_id"]
    assert HEX32.match(request_id), f"the ask id is not 32 lowercase hex: {request_id!r}"
    ask_rows = [r for r in rows if r["kind"] == "ask"]
    assert len(ask_rows) == 1, "one ask, one size estimate"
    assert ask_rows[0]["request_id"] == request_id
    assert len(chats) == 1
    assert chats[0]["request_id"] == request_id
    assert chats[0]["id"] == payload["chat_id"]


# --- the issue #26 rule: an abandoned stream stamps nothing --------------


def test_an_abandoned_stream_stamps_nothing(tmp_path):
    # The Learner goes away mid-stream: the handler aborts the upstream
    # and answers nothing. Completion-anchored persistence holds — no
    # Question, no exchange, no Cognee round. The ONLY ledger row is the
    # gate's own size estimate, recorded before the handler ran, and it
    # carries the minted id: the request is addressable by its key even
    # though it never completed.
    original_timeout = os.environ.get("AGENT_TIMEOUT")
    os.environ["AGENT_TIMEOUT"] = "0.3"
    try:
        upstream, base, server, original = with_agent(tmp_path, [OneFrameThenStall()])
        try:
            seen = abandon_stream(base, {"query": "پرسش؟"})
            rows = ledger_rows()
            chats = agent_chat_rows()
        finally:
            stop_gate(server, original)
    finally:
        if original_timeout is None:
            os.environ.pop("AGENT_TIMEOUT", None)
        else:
            os.environ["AGENT_TIMEOUT"] = original_timeout
    assert b"data: " in seen, "the Learner never saw the stream open"
    assert chats == [], "an abandoned stream persists no exchange"
    assert question_window.questions_in_window(PHONE) == 0
    # The gate's size estimate is the only row the request left.
    assert len(rows) == 1
    assert rows[0]["kind"] == "agent"
    assert HEX32.match(rows[0]["request_id"])
    # The abandoned request never reached Cognee's seam.
    assert len(upstream.urls) == 1
    assert not [url for url in upstream.urls if "/api/v1/recall" in url]


# --- the guarded migration: a rebuild keeps existing rows ----------------


def test_the_stores_migrate_the_request_id_column_and_keep_existing_rows(tmp_path):
    # A deployed DB predates the join key. Each store's own connect
    # migrates it — the guarded ALTER per missing column the chat store
    # already runs for the marking columns — so old rows read with the
    # honest absence and new writes carry the minted id, with no manual
    # step.
    original_chat_db = chat_store.CHAT_DB
    original_ledger_db = ledger.LEDGER_DB
    chat_db = tmp_path / "deployed_chats.sqlite3"
    ledger_db = tmp_path / "deployed_ledger.sqlite3"
    chat_store.CHAT_DB = chat_db
    ledger.LEDGER_DB = str(ledger_db)
    try:
        con = sqlite3.connect(str(chat_db))
        con.execute(
            "CREATE TABLE chats (id TEXT PRIMARY KEY, phone TEXT NOT NULL,"
            " question TEXT NOT NULL, datasets_json TEXT NOT NULL,"
            " sources_json TEXT NOT NULL, selections_json TEXT NOT NULL,"
            " blocks_json TEXT NOT NULL, truncated INTEGER NOT NULL DEFAULT 0,"
            " created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
        )
        con.execute(
            "CREATE TABLE agent_chats (id TEXT PRIMARY KEY, phone TEXT NOT NULL,"
            " thread_id TEXT NOT NULL, question TEXT NOT NULL,"
            " answer TEXT NOT NULL, web_sourced INTEGER NOT NULL DEFAULT 0,"
            " sources TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)"
        )
        con.execute(
            "INSERT INTO chats (id, phone, question, datasets_json, sources_json,"
            " selections_json, blocks_json, created_at, updated_at)"
            " VALUES ('old', ?, 'پرسش قدیمی', '[]', '[]', '[]', '[]',"
            " '2026-01-01T00:00:00', '2026-01-01T00:00:00')",
            (PHONE,),
        )
        con.execute(
            "INSERT INTO agent_chats (id, phone, thread_id, question, answer,"
            " web_sourced, sources, created_at) VALUES ('old-a', ?,"
            " 'learner-old', 'پرسش قدیمی', 'پاسخ قدیمی', 0, '[]',"
            " '2026-01-01T00:00:00')",
            (PHONE,),
        )
        con.commit()
        con.close()
        con = sqlite3.connect(str(ledger_db))
        con.execute(
            "CREATE TABLE usage_entries (id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " account TEXT NOT NULL, ts TEXT NOT NULL, day TEXT NOT NULL,"
            " kind TEXT NOT NULL, metered INTEGER NOT NULL,"
            " input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,"
            " cost_toman INTEGER NOT NULL)"
        )
        con.execute(
            "INSERT INTO usage_entries (account, ts, day, kind, metered,"
            " input_tokens, output_tokens, cost_toman)"
            " VALUES (?, '2026-01-01 00:00:00', '2026-01-01', 'ask', 0, 300, 0, 1)",
            (account_email_for_phone(PHONE),),
        )
        con.commit()
        con.close()

        # The old rows read with the honest absence...
        assert chat_store.latest_chat(PHONE)["id"] == "old"
        assert chat_store.agent_conversation(PHONE)[0]["answer"] == "پاسخ قدیمی"
        assert ledger_rows()[0]["request_id"] is None

        # ...and new writes carry the minted id through the migrated columns.
        minted = "a" * 32
        chat_store.create_chat(
            "new", PHONE, "پرسش جدید", ["tarhe-kolli"], [], request_id=minted
        )
        chat_store.record_agent_exchange(
            PHONE, "learner-new", "پرسش نو", "پاسخ نو", False, [], request_id=minted
        )
        ledger.record_size_estimate(
            account_email_for_phone(PHONE), "ask", 900, request_id=minted
        )
        assert chat_rows()[-1]["request_id"] == minted
        assert agent_chat_rows()[-1]["request_id"] == minted
        assert ledger_rows()[-1]["request_id"] == minted
        # The pre-migration row is untouched by the rebuild.
        assert ledger_rows()[0]["request_id"] is None
    finally:
        chat_store.CHAT_DB = original_chat_db
        ledger.LEDGER_DB = original_ledger_db


# --- the seam's own contract: the id rides the body only when minted -----


def test_the_body_carries_tracing_options_only_when_the_id_is_minted():
    # No minted id, no tracingOptions: the body stays exactly the shape
    # the existing pins read, so a caller that never minted (the module's
    # documented non-stream path) is unchanged.
    plain = agent_client.LearnerTurnContext(query="پرسش", thread_id="learner-x")
    body = plain.to_request_body()
    assert "tracingOptions" not in body
    assert "requestId" not in body["requestContext"]

    minted = agent_client.LearnerTurnContext(
        query="پرسش", thread_id="learner-x", request_id="a" * 32
    )
    body = minted.to_request_body()
    assert body["requestContext"]["requestId"] == "a" * 32
    assert body["tracingOptions"]["traceId"] == "a" * 32
    assert body["tracingOptions"]["metadata"] == {
        "thread": "learner-x",
        "resource": "learner-x",
    }


def test_from_request_carries_the_minted_id_into_the_stream_body():
    # The handler mints at the gate and hands the id to the factory; the
    # streamed body carries it, because AgentStream answers through the
    # SAME to_request_body the generate route uses.
    turn = agent_client.LearnerTurnContext.from_request(
        PHONE, None, {"query": "پرسش؟"}, request_id="f" * 32
    )
    assert turn.request_id == "f" * 32
    body = agent_client.AgentStream(turn).to_request_body()
    assert body["tracingOptions"]["traceId"] == "f" * 32
    assert body["requestContext"]["requestId"] == "f" * 32
