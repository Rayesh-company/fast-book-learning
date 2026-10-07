"""The Learner-facing seam (ADR-0018): the sheet's chat surface goes
through the Mastra agent — each Learner message that RECEIVES an agent
answer is one Question inside the 30-per-5-hours window, the exchange
persists for the reload's no-rebilling restore (ADR-0014's leg), and the
sheet's Book selection rides the seam's requestContext to the agent's
search-books tool. The Mastra upstream is canned (scripted replies at
ui.agent_client's urlopen seam — the tests.helpers rule); the window's
own arithmetic is pinned in test_question_window.py.

The answer STREAMS (issue #26): the seam relays the agent's SSE route
unbuffered and appends its OWN terminal frame — chat-answer-finalized on
completion (metering and persistence are completion-anchored: one
Question, one exchange) or chat-answer-error on a failed/stalled stream
(nothing metered, nothing persisted). The relayed frames' shapes are the
REAL dialect probed against the agent
(agent/src/mastra/stream-shape.test.ts pins it on the TS side):
text-delta frames carry the growing answer, tool-result frames carry an
EXECUTED tool's record — the «بیرون از کتاب» guarantee (issue #24)
survives onto the streamed path through the seam's one derivation. The
gates before the stream (identity, Balance, window) keep today's JSON
error shapes."""

import json
import os
import sys
import threading
import time
import sqlite3
import urllib.error
import urllib.request

from tests.conftest import REPO_ROOT
from tests.helpers import (
    FakeResponse,
    account_email_for_phone,
    cookie_for,
    ensure_account,
    get,
    post,
    stop_gate,
    with_gate,
)

sys.path.insert(0, str(REPO_ROOT))

from ui import agent_client, question_window  # noqa: E402

PHONE = "09120000000"

# The honest Farsi failures the JSON path used to carry — the streamed
# error frames keep the same texts.
AGENT_FAILED_DETAIL = "عامل گفت‌وگو پاسخ نداد؛ دوباره بپرسید."
AGENT_UNREACHABLE_DETAIL = "ارتباط با عامل گفت‌وگو قطع شد؛ دوباره بپرسید."


class AgentUpstream:
    """The canned Mastra service: each call answers the next scripted
    reply (an Exception stands for a failed call; a list of lines is a
    STREAMED reply the StreamResponse relays one readline at a time); the
    payloads and URLs are captured for the seam's assertions."""

    def __init__(self, replies=()):
        self.replies = [
            reply.encode("utf-8") if isinstance(reply, str) else reply
            for reply in replies
        ]
        self.payloads = []
        self.urls = []

    def __call__(self, request, timeout=None):
        self.urls.append(request.full_url)
        self.payloads.append(json.loads(request.data.decode("utf-8")))
        item = self.replies.pop(0)
        if isinstance(item, Exception):
            raise item
        if isinstance(item, list):
            return StreamResponse(item)
        if isinstance(item, FakeResponse):
            return item
        return FakeResponse(item)


class StreamResponse(FakeResponse):
    """The canned SSE upstream (the tests.helpers FakeResponse pattern,
    extended for the readline relay): readline hands over the scripted
    lines one at a time — an Exception line stands for a mid-stream read
    failure — and b"" once the script runs dry (the upstream's EOF)."""

    def __init__(self, lines):
        super().__init__(b"")
        self._lines = list(lines)

    def readline(self):
        if not self._lines:
            return b""
        item = self._lines.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def close(self):
        # The seam's abort() closes the upstream; a closed script reads
        # as EOF so a blocked reader never hangs the fake.
        self._lines.clear()


class StallingStream(FakeResponse):
    """An upstream that accepts the connection and then never speaks:
    readline blocks until close() — past any leash the test pins."""

    def __init__(self):
        super().__init__(b"")
        self._closed = threading.Event()

    def readline(self):
        self._closed.wait(timeout=30)
        return b""

    def close(self):
        self._closed.set()


def sse_lines(events):
    """The upstream's SSE bytes for the relayed frames: each event lands
    as one `data: <json>` line plus the blank separator line, and the
    script ends with the upstream's [DONE] terminator — the wire shape
    the Mastra server writes (stream-shape.test.ts's pins)."""
    lines = []
    for event in events:
        lines.append(
            b"data: " + json.dumps(event, ensure_ascii=False).encode("utf-8") + b"\n"
        )
        lines.append(b"\n")
    lines.append(b"data: [DONE]\n")
    lines.append(b"\n")
    return lines


def start_frame():
    return {"type": "start", "payload": {"id": "chat-agent"}}


def finish_frame():
    return {
        "type": "finish",
        "payload": {"stepResult": {"reason": "stop", "isContinued": False}},
    }


def text_delta(text):
    return {"type": "text-delta", "payload": {"id": "txt-0", "text": text}}


def tool_result_frame(tool_name, results):
    """The executed tool's streamed record — the REAL shape
    stream-shape.test.ts probed: a tool-result chunk whose payload is
    the generate() reply's toolResults[] entry payload (toolCallId,
    toolName, args, result)."""
    return {
        "type": "tool-result",
        "payload": {
            "toolCallId": "call_web_1",
            "toolName": tool_name,
            "args": {"query": "رویداد روز", "maxResults": 3},
            "result": {"results": results},
        },
    }


def agent_stream_ok(text):
    """A clean streamed answer: the relayed Mastra frames — the run's
    start, the delta pair composing the text, the finish — then the
    upstream's terminator."""
    words = text.split(" ")
    middle = len(words) // 2
    if middle:
        deltas = [" ".join(words[:middle]) + " ", " ".join(words[middle:])]
    else:
        deltas = [text]
    return sse_lines(
        [start_frame()] + [text_delta(delta) for delta in deltas] + [finish_frame()]
    )


def agent_stream_with_tool(text, tool_name, results):
    return sse_lines(
        [
            start_frame(),
            tool_result_frame(tool_name, results),
            text_delta(text),
            finish_frame(),
        ]
    )


WEB_RESULTS = [
    {"title": "منبع اول", "url": "https://example.ir/one", "snippet": "خلاصهٔ اول"},
    {"title": "منبع دوم", "url": "https://example.ir/two", "snippet": "خلاصهٔ دوم"},
]

CLEAN_WEB_SOURCES = [
    {"title": "منبع اول", "url": "https://example.ir/one"},
    {"title": "منبع دوم", "url": "https://example.ir/two"},
]


def agent_tool_reply(text, tool_name, results):
    """The canned Mastra generate() reply (the non-stream path's canned
    shape, #24's probe): the reply's top-level toolResults[] entries hold
    payload {toolCallId, toolName, args, result}."""
    return json.dumps(
        {
            "text": text,
            "toolResults": [
                {
                    "type": "tool-result",
                    "from": "AGENT",
                    "payload": {
                        "toolCallId": "call_web_1",
                        "toolName": tool_name,
                        "args": {"query": "رویداد روز", "maxResults": 3},
                        "result": {"results": results},
                    },
                }
            ],
        },
        ensure_ascii=False,
    ).encode("utf-8")


def with_agent(tmp_path, replies):
    question_window.WINDOW_DB = tmp_path / "window.sqlite3"
    upstream = AgentUpstream(replies)
    return (upstream,) + with_gate(tmp_path, upstream)


def ask_agent(base, payload, phone=PHONE):
    return post_stream(base, payload, phone=phone)


def post_stream(base, payload, phone=PHONE):
    """One POST reading the seam's SSE body to its close-delimited end;
    (status, content type, frames) with frames the parsed data payloads —
    the relayed Mastra frames plus the seam's own terminal frame. The
    gates' JSON errors (401/402/429) come back as (status, type,
    payload-dict) instead, exactly the shape the sheet's non-OK branch
    reads."""
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


def test_the_answer_streams_and_finalizes_with_one_question_and_one_exchange(
    tmp_path,
):
    # AC-1/AC-2 in one: the relayed frames arrive (the delta frames the
    # sheet renders progressively), the seam's OWN finalize frame ends
    # the stream carrying the full answer plus the window, and exactly
    # one Question + one persisted exchange landed — identical in shape
    # to the non-streamed persistence, so the reload restores.
    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("پاسخ عامل با استناد")]
    )
    try:
        status, ctype, frames = ask_agent(
            base, {"query": "پرسش؟", "datasets": ["tarhe-kolli"]}
        )
        history_status, history = get(base, "/agent/chat/history", phone=PHONE)
    finally:
        stop_gate(server, original)
    assert status == 200
    assert "text/event-stream" in ctype
    # The relay: the upstream's frames passed through unbuffered — the
    # two deltas, in order — and the seam appended its finalize frame.
    deltas = [f for f in frames if f.get("type") == "text-delta"]
    assert [d["payload"]["text"] for d in deltas] == ["پاسخ عامل ", "با استناد"]
    assert frames[-1]["type"] == "chat-answer-finalized"
    assert frames[-1]["answer"] == "پاسخ عامل با استناد"
    # The window rides the finalize frame, computed AFTER the Question
    # landed (issue #23's counter contract on the streamed path).
    assert frames[-1]["window"]["remaining"] == (
        question_window.QUESTION_WINDOW_LIMIT - 1
    )
    assert isinstance(frames[-1]["window"]["reopens_at"], float)
    # Completion-anchored metering: one Question, one exchange — and the
    # reload restores the same transcript.
    assert question_window.questions_in_window(PHONE) == 1
    assert history_status == 200
    assert history["thread_id"] == f"learner-{PHONE}"
    assert len(history["messages"]) == 1
    assert history["messages"][0]["question"] == "پرسش؟"
    assert history["messages"][0]["answer"] == "پاسخ عامل با استناد"
    assert len(upstream.urls) == 1
    assert upstream.urls[0].endswith("/api/agents/chat-agent/stream")


def test_the_full_window_refuses_the_next_message_without_calling_the_agent(
    tmp_path,
):
    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("نباید صدا شود")]
    )
    try:
        for _ in range(question_window.QUESTION_WINDOW_LIMIT):
            question_window.record_question(PHONE)
        status, _, payload = ask_agent(base, {"query": "پرسش؟"})
    finally:
        stop_gate(server, original)
    assert status == 429
    assert "پنجرهٔ پرسش" in payload["detail"]
    # The refusal never reached the agent and never metered.
    assert upstream.urls == []
    assert (
        question_window.questions_in_window(PHONE)
        == question_window.QUESTION_WINDOW_LIMIT
    )


def test_an_upstream_failure_answers_the_error_frame_and_meters_nothing(tmp_path):
    # AC-3: a reachable-but-failing agent (HTTPError at the stream's
    # connect) answers the honest error frame — the 502's own text — and
    # records no Question, persists no exchange.
    from urllib.error import HTTPError
    from io import BytesIO

    upstream, base, server, original = with_agent(
        tmp_path,
        [HTTPError("http://agent", 500, "upstream refused", {}, BytesIO(b"{}"))],
    )
    try:
        status, ctype, frames = ask_agent(base, {"query": "پرسش؟"})
        history_status, history = get(base, "/agent/chat/history", phone=PHONE)
    finally:
        stop_gate(server, original)
    assert status == 200
    assert "text/event-stream" in ctype
    assert frames == [{"type": "chat-answer-error", "detail": AGENT_FAILED_DETAIL}]
    assert question_window.questions_in_window(PHONE) == 0
    assert history_status == 200
    assert history["messages"] == []


def test_an_unreachable_upstream_answers_the_error_frame_and_meters_nothing(
    tmp_path,
):
    from urllib.error import URLError

    upstream, base, server, original = with_agent(
        tmp_path, [URLError("agent service down")]
    )
    try:
        status, ctype, frames = ask_agent(base, {"query": "پرسش؟"})
        history_status, history = get(base, "/agent/chat/history", phone=PHONE)
    finally:
        stop_gate(server, original)
    assert status == 200
    assert "text/event-stream" in ctype
    assert frames == [{"type": "chat-answer-error", "detail": AGENT_UNREACHABLE_DETAIL}]
    assert question_window.questions_in_window(PHONE) == 0
    assert history_status == 200
    assert history["messages"] == []


def test_a_stream_that_dies_mid_read_meters_nothing(tmp_path):
    # AC-3's mid-stream shape: the upstream connected and streamed some
    # answer text, then the read failed (OSError past the relay's
    # readline) — partial text is NOT an answer: the error frame, no
    # Question, no exchange.
    upstream, base, server, original = with_agent(
        tmp_path,
        [
            sse_lines([start_frame(), text_delta("نیمه‌کار")])[:-2]
            + [OSError("connection reset mid-stream")]
        ],
    )
    try:
        status, ctype, frames = ask_agent(base, {"query": "پرسش؟"})
        history_status, history = get(base, "/agent/chat/history", phone=PHONE)
    finally:
        stop_gate(server, original)
    assert status == 200
    assert "text/event-stream" in ctype
    assert frames[-1] == {"type": "chat-answer-error", "detail": AGENT_UNREACHABLE_DETAIL}
    assert "chat-answer-finalized" not in [f.get("type") for f in frames]
    assert question_window.questions_in_window(PHONE) == 0
    assert history["messages"] == []


def test_a_stalled_stream_past_the_leash_meters_nothing(tmp_path):
    # AC-3's leash: an upstream that never speaks again — no line within
    # AGENT_TIMEOUT (pinned at a fraction here, read at call time) — is
    # aborted with the honest error frame; nothing metered, nothing
    # persisted.
    original_timeout = os.environ.get("AGENT_TIMEOUT")
    os.environ["AGENT_TIMEOUT"] = "0.2"
    try:
        upstream, base, server, original = with_agent(
            tmp_path, [StallingStream()]
        )
        try:
            started = time.monotonic()
            status, ctype, frames = ask_agent(base, {"query": "پرسش؟"})
            elapsed = time.monotonic() - started
            history_status, history = get(
                base, "/agent/chat/history", phone=PHONE
            )
        finally:
            stop_gate(server, original)
    finally:
        if original_timeout is None:
            os.environ.pop("AGENT_TIMEOUT", None)
        else:
            os.environ["AGENT_TIMEOUT"] = original_timeout
    assert status == 200
    assert "text/event-stream" in ctype
    assert frames == [{"type": "chat-answer-error", "detail": AGENT_UNREACHABLE_DETAIL}]
    # The leash actually leashed (the stall aborts near the pin, not at
    # the fake's own 30s block).
    assert elapsed < 10
    assert question_window.questions_in_window(PHONE) == 0
    assert history["messages"] == []


def test_an_abandoned_stream_is_torn_down_and_answers_nothing(tmp_path):
    # The abandoned contract at the module's own seam (the browser gate
    # exercises the handler's write side): a consumer that stops reading
    # and closes the stream aborts the upstream — the fake's close() is
    # what a real socket's close does to a blocked readline — and the
    # reply stays unset, so the handler's completion branch (metering)
    # can never run.
    upstream = AgentUpstream([agent_stream_ok("پاسخی که ناتمام می‌ماند")])
    original_urlopen = agent_client.urlopen
    agent_client.urlopen = upstream
    try:
        stream = agent_client.AgentStream("پرسش؟", [], "learner-x")
        iterator = iter(stream)
        for line in iterator:
            assert line  # the first relayed frame arrived...
            break  # ...and then the Learner went away mid-stream
        stream.abort()
        assert stream.reply is None
        # The generator closed cleanly behind the abort; no completion,
        # so no metering branch can ever run for this stream.
        iterator.close()
        assert stream.reply is None
    finally:
        agent_client.urlopen = original_urlopen


def test_a_stream_that_completes_without_answer_text_meters_nothing(tmp_path):
    # The streamed twin of the reply-without-text: an upstream that ends
    # cleanly but composed no answer text is not an answered Question.
    upstream, base, server, original = with_agent(
        tmp_path, [sse_lines([start_frame(), finish_frame()])]
    )
    try:
        status, ctype, frames = ask_agent(base, {"query": "پرسش؟"})
    finally:
        stop_gate(server, original)
    assert status == 200
    assert "text/event-stream" in ctype
    assert frames[-1] == {"type": "chat-answer-error", "detail": AGENT_FAILED_DETAIL}
    assert question_window.questions_in_window(PHONE) == 0


def test_the_thread_is_stable_and_the_selection_rides_the_stream(tmp_path):
    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("یک"), agent_stream_ok("دو")]
    )
    try:
        for query in ("پرسش اول؟", "پرسش دوم؟"):
            status, _, frames = ask_agent(
                base, {"query": query, "datasets": ["tarhe-kolli"]}
            )
            assert status == 200
            assert frames[-1]["type"] == "chat-answer-finalized"
    finally:
        stop_gate(server, original)
    # Every message rides the same per-Learner thread (the agent's own
    # memory carries the conversation) with the Book selection in the
    # requestContext — never in the prompt text; the body is the
    # generate call's own shape on the stream route.
    for payload in upstream.payloads:
        assert payload["memory"]["thread"] == f"learner-{PHONE}"
        assert payload["messages"] == [
            {"role": "user", "content": payload["messages"][0]["content"]}
        ]
        assert payload["requestContext"]["datasets"] == ["tarhe-kolli"]


def test_the_reload_restores_without_the_agent_or_metering(tmp_path):
    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("پاسخ")]
    )
    try:
        status, _, frames = ask_agent(base, {"query": "پرسش؟"})
        assert status == 200
        history_status, history = get(base, "/agent/chat/history", phone=PHONE)
    finally:
        stop_gate(server, original)
    assert history_status == 200
    assert history["thread_id"] == f"learner-{PHONE}"
    assert len(history["messages"]) == 1
    assert history["messages"][0]["question"] == "پرسش؟"
    assert history["messages"][0]["answer"] == "پاسخ"
    # The restore re-read the store: one agent call total, one Question.
    assert len(upstream.urls) == 1
    assert question_window.questions_in_window(PHONE) == 1


# --- the window state on the seam (issue #23): the finalize frame
# carries it so the sheet's counter never needs a second shape ---------


def _persian_clock(epoch: float) -> str:
    """The reopen time the way the server renders it: the local clock's
    hour and minute, in Farsi digits."""
    reopen = time.localtime(epoch)
    return f"{reopen.tm_hour:02d}:{reopen.tm_min:02d}".translate(
        str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")
    )


def test_the_finalize_frame_carries_the_window_state_after_the_question_lands(
    tmp_path,
):
    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("پاسخ")]
    )
    try:
        status, _, frames = ask_agent(base, {"query": "پرسش؟"})
    finally:
        stop_gate(server, original)
    assert status == 200
    finalize = frames[-1]
    assert finalize["type"] == "chat-answer-finalized"
    # Computed AFTER record_question: the first answered message leaves
    # 29, with this Question's own aging-out as the reopen moment.
    assert finalize["window"]["remaining"] == (
        question_window.QUESTION_WINDOW_LIMIT - 1
    )
    assert isinstance(finalize["window"]["reopens_at"], float)


def test_the_history_read_carries_the_window_state_recomputed_fresh(tmp_path):
    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("پاسخ")]
    )
    try:
        _, _, frames = ask_agent(base, {"query": "پرسش؟"})
        history_status, history = get(base, "/agent/chat/history", phone=PHONE)
    finally:
        stop_gate(server, original)
    assert history_status == 200
    # Recomputed from the store, not echoed from the reply — but over
    # the same one recorded Question, so the two reads agree exactly.
    assert history["window"] == frames[-1]["window"]
    assert history["window"]["remaining"] == question_window.QUESTION_WINDOW_LIMIT - 1


def test_the_full_window_refusal_names_when_the_window_reopens(tmp_path):
    upstream, base, server, original = with_agent(tmp_path, [])
    try:
        now = time.time()
        # Explicit seed moments, not wall-clock drift: the oldest
        # Question sits one hour back, so the window reopens four hours
        # from the test's own now.
        for i in range(question_window.QUESTION_WINDOW_LIMIT):
            question_window.record_question(PHONE, now=now - 3600 + i)
        status, _, payload = ask_agent(base, {"query": "پرسش؟"})
    finally:
        stop_gate(server, original)
    assert status == 429
    expected_reopens = (now - 3600) + question_window.QUESTION_WINDOW_HOURS * 3600
    # The payload carries the same structured window the finalize
    # frames do, so the counter renders from the refusal itself.
    assert payload["window"] == {"remaining": 0, "reopens_at": expected_reopens}
    # And the prose names the reopen time on the server's own clock,
    # in Farsi digits — the same reopens_at the counter will show then.
    assert _persian_clock(expected_reopens) in payload["detail"]


def test_an_empty_window_history_read_carries_a_full_count(tmp_path):
    upstream, base, server, original = with_agent(tmp_path, [])
    try:
        history_status, history = get(base, "/agent/chat/history", phone=PHONE)
    finally:
        stop_gate(server, original)
    assert history_status == 200
    # A fresh Account: the whole window remains and nothing ages out.
    assert history["window"] == {
        "remaining": question_window.QUESTION_WINDOW_LIMIT,
        "reopens_at": None,
    }


def test_an_anonymous_call_never_reaches_the_agent(tmp_path):
    upstream, base, server, original = with_agent(tmp_path, [])
    try:
        status, _ = post(base, "/agent/chat", {"query": "پرسش؟"})
    finally:
        stop_gate(server, original)
    assert status == 401
    assert upstream.urls == []


# --- the guaranteed «بیرون از کتاب» marking (issue #24, ADR-0018):
# the marking is the sheet's guarantee, not the model's memory — the
# flag rides the executed tool's streamed record, never the answer text


def test_the_web_tool_record_guarantees_the_marking_the_prose_omits(tmp_path):
    # AC-1/AC-2/AC-3 in one: a streamed answer whose prose carries NO
    # «بیرون از کتاب» but whose tool-result frame shows the web tool
    # EXECUTED is web-sourced anyway — the finalize frame carries the
    # flag and the sources, and the persisted history message carries
    # them for the reload.
    upstream, base, server, original = with_agent(
        tmp_path,
        [agent_stream_with_tool("پاسخ بدون هیچ نشان", "webSearchTool", WEB_RESULTS)],
    )
    try:
        status, _, frames = ask_agent(base, {"query": "پرسش؟"})
        history_status, history = get(base, "/agent/chat/history", phone=PHONE)
    finally:
        stop_gate(server, original)
    assert status == 200
    finalize = frames[-1]
    assert finalize["type"] == "chat-answer-finalized"
    assert finalize["answer"] == "پاسخ بدون هیچ نشان"
    assert "بیرون از کتاب" not in finalize["answer"]
    assert finalize["web_sourced"] is True
    assert finalize["sources"] == CLEAN_WEB_SOURCES
    # The executed record rode the relay itself — the browser gate's
    # canned agent scripts this exact frame.
    tool_frames = [f for f in frames if f.get("type") == "tool-result"]
    assert tool_frames[0]["payload"]["toolName"] == "webSearchTool"
    # The reload's stored form carries the same guarantee — one agent
    # call total, the restore never re-billed.
    assert history_status == 200
    assert len(history["messages"]) == 1
    assert history["messages"][0]["web_sourced"] is True
    assert history["messages"][0]["sources"] == finalize["sources"]
    assert len(upstream.urls) == 1


def test_a_reply_without_tool_records_is_not_web_sourced(tmp_path):
    # The minimal streamed reply carries no tool record and the prose
    # carries no mark: no guarantee, no sources — on the finalize frame
    # and on the stored history message alike.
    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("پاسخ از کتاب‌ها")]
    )
    try:
        status, _, frames = ask_agent(base, {"query": "پرسش؟"})
        _, history = get(base, "/agent/chat/history", phone=PHONE)
    finally:
        stop_gate(server, original)
    assert status == 200
    assert frames[-1]["web_sourced"] is False
    assert frames[-1]["sources"] == []
    assert history["messages"][0]["web_sourced"] is False
    assert history["messages"][0]["sources"] == []


def test_a_book_tool_record_alone_is_not_web_sourced(tmp_path):
    # The search-books tool executing is NOT the web: the flag is
    # name-scoped to the web tool's own record, not "any tool ran".
    upstream, base, server, original = with_agent(
        tmp_path,
        [
            agent_stream_with_tool(
                "پاسخ از متن کتاب",
                "searchBooksTool",
                [{"reference": "document tarhe-kolli (pages 10-11)", "passage": "متن"}],
            )
        ],
    )
    try:
        status, _, frames = ask_agent(base, {"query": "پرسش؟"})
    finally:
        stop_gate(server, original)
    assert status == 200
    assert frames[-1]["web_sourced"] is False
    assert frames[-1]["sources"] == []


def test_the_web_sources_list_is_capped_at_eight(tmp_path):
    # A long web result list renders sanely: the seam keeps the first
    # eight (title+url only — the snippet is the tool's own detail).
    many = [
        {"title": f"منبع {i}", "url": f"https://example.ir/{i}", "snippet": "خلاصه"}
        for i in range(1, 13)
    ]
    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_with_tool("پاسخ وب", "webSearchTool", many)]
    )
    try:
        status, _, frames = ask_agent(base, {"query": "پرسش؟"})
    finally:
        stop_gate(server, original)
    assert status == 200
    assert len(frames[-1]["sources"]) == 8
    assert frames[-1]["sources"][0] == {"title": "منبع 1", "url": "https://example.ir/1"}
    assert frames[-1]["sources"][7] == {"title": "منبع 8", "url": "https://example.ir/8"}


def test_sources_with_unsafe_url_schemes_are_dropped_entirely(tmp_path):
    # #24 fixup (spec #21 story 17 — links inside answers open safely):
    # the sheet renders each source as a REAL anchor (a.href verbatim),
    # so a javascript:/ftp:/empty url from a malicious or buggy web
    # upstream would be a live clickable link inside the answer. The
    # seam owns the guarantee: an unsafe url drops the source entirely
    # (honest absence beats a dead or dangerous link) — on the finalize
    # frame AND the stored history message alike.
    mixed = [
        {"title": "منبع امن", "url": "https://example.ir/safe", "snippet": "خلاصه"},
        {"title": "منبع خطرناک", "url": "javascript:alert(1)"},
        {"title": "منبع ftp", "url": "ftp://files.example/x"},
        {"title": "منبع خالی", "url": ""},
    ]
    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_with_tool("پاسخ وب", "webSearchTool", mixed)]
    )
    try:
        status, _, frames = ask_agent(base, {"query": "پرسش؟"})
        history_status, history = get(base, "/agent/chat/history", phone=PHONE)
    finally:
        stop_gate(server, original)
    assert status == 200
    assert frames[-1]["web_sourced"] is True
    assert frames[-1]["sources"] == [
        {"title": "منبع امن", "url": "https://example.ir/safe"}
    ]
    assert history_status == 200
    assert len(history["messages"]) == 1
    assert history["messages"][0]["web_sourced"] is True
    assert history["messages"][0]["sources"] == frames[-1]["sources"]


def test_agent_answer_keeps_the_non_streamed_generate_path(tmp_path):
    # The generate call stays in the module as the documented non-stream
    # path (#26: unused by the seam, not deleted): its contract — the
    # structured {text, web_sourced, sources} reply with the guarantee
    # from the reply's tool-call record — is unchanged.
    captured = {}
    original_urlopen = agent_client.urlopen

    def fake_urlopen(request, timeout=None):
        captured["url"] = request.full_url
        return FakeResponse(agent_tool_reply("پاسخ", "webSearchTool", WEB_RESULTS))

    agent_client.urlopen = fake_urlopen
    try:
        reply = agent_client.agent_answer("پرسش؟", ["tarhe-kolli"], "learner-x")
    finally:
        agent_client.urlopen = original_urlopen
    assert captured["url"].endswith("/api/agents/chat-agent/generate")
    assert reply == {
        "text": "پاسخ",
        "web_sourced": True,
        "sources": CLEAN_WEB_SOURCES,
    }


def test_the_store_migrates_a_deployed_agent_chats_table(tmp_path):
    # The pre-#24 deployed DB predates the marking columns: the store's
    # own connect migrates it (guarded ALTER per missing column), old
    # rows read with the honest defaults, and new writes carry the
    # guarantee.
    from ui import chat_store

    original_db = chat_store.CHAT_DB
    db = tmp_path / "chats.sqlite3"
    chat_store.CHAT_DB = db
    try:
        conn = sqlite3.connect(str(db))
        conn.execute(
            "CREATE TABLE agent_chats (id TEXT PRIMARY KEY, phone TEXT NOT NULL,"
            " thread_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL,"
            " created_at TEXT NOT NULL)"
        )
        conn.execute(
            "INSERT INTO agent_chats (id, phone, thread_id, question, answer,"
            " created_at) VALUES ('old', ?, 'learner-old', 'پرسش قدیمی',"
            " 'پاسخ قدیمی', '2026-01-01T00:00:00')",
            (PHONE,),
        )
        conn.commit()
        conn.close()
        # The old row reads with the defaults applied...
        old = chat_store.agent_conversation(PHONE)
        assert old[0]["answer"] == "پاسخ قدیمی"
        assert old[0]["web_sourced"] is False
        assert old[0]["sources"] == []
        # ...and a new exchange persists the guarantee through the
        # migrated columns.
        chat_store.record_agent_exchange(
            PHONE, "learner-new", "پرسش جدید", "پاسخ وب", True, WEB_RESULTS
        )
        fresh = chat_store.agent_conversation(PHONE)
        assert fresh[-1]["web_sourced"] is True
        assert fresh[-1]["sources"] == CLEAN_WEB_SOURCES
    finally:
        chat_store.CHAT_DB = original_db
