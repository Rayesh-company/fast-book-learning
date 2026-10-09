"""The Mastra agent service client (ADR-0016/0018): the Learner-facing
seam's one upstream call — the Learner's message goes to the chat
agent's stream route (#26; agent_answer keeps the generate route as the
documented non-stream path), the conversation keyed per Learner thread
(Mastra Memory, durable in the agent service's own LibSQL), and the
sheet's Book selection rides the requestContext the search-books tool
reads (the selection reaches the tool without ever becoming prompt
text). The reply comes back STRUCTURED (#24, ADR-0018): the answer text
plus the guaranteed «بیرون از کتاب» marking derived here from the
reply's tool-call record — never parsed from the answer text — so the
sheet renders the marking even when the model's own prose omits it; on
the streamed path the SAME derivation reads the tool-result frames
(agent/src/mastra/stream-shape.test.ts pins the dialect). The module
talks to the agent service behind this module's ONE ``urlopen``
attribute, the ask.py rule; the URL and leash are read at call time so
the tests' env pins hold."""

from __future__ import annotations

import json
import os
import queue
import threading
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# The web tool's names in the reply's tool-call record: the OBJECT KEY
# is what the model actually sees ("webSearchTool" — probed against the
# real agent 2026-10-07, pinned in agent/src/mastra/generate-shape.test.ts);
# the tool's own id ("web-search", agent/src/mastra/tools/web-search.ts)
# rides along as the fallback so a Mastra rename of the wire name can
# never silently unmark the sheet.
WEB_TOOL_NAMES = ("webSearchTool", "web-search")

# A long web result list renders sanely: the seam keeps the first eight
# sources (title+url) — the snippet stays the tool's own detail.
MAX_WEB_SOURCES = 8

# The seam's OWN SSE frames (issue #26): the upstream's frames are
# relayed verbatim, and the stream ends with exactly one terminal frame
# of the seam's — chat-answer-finalized when an answer completed (the
# handler appends the window after its metering), chat-answer-error
# when it did not. The texts are the honest Farsi failures the JSON
# path carried — the same words, now streamed.
CHAT_ANSWER_FINALIZED = "chat-answer-finalized"
CHAT_ANSWER_ERROR = "chat-answer-error"
AGENT_FAILED_DETAIL = "عامل گفت‌وگو پاسخ نداد؛ دوباره بپرسید."
AGENT_UNREACHABLE_DETAIL = "ارتباط با عامل گفت‌وگو قطع شد؛ دوباره بپرسید."


class AgentError(Exception):
    """The service was reached but carries no answer — an HTTP error
    status of its own (its model upstream refused, e.g. the provider's
    rate limit) or a reply without answer text. The seam answers 502:
    the agent is up and failed, not unreachable."""


def _agent_url() -> str:
    return (
        os.environ.get("AGENT_URL", "http://127.0.0.1:4111").rstrip("/")
        + "/api/agents/chat-agent/generate"
    )


def _agent_stream_url() -> str:
    return (
        os.environ.get("AGENT_URL", "http://127.0.0.1:4111").rstrip("/")
        + "/api/agents/chat-agent/stream"
    )


def sse_frame(payload: dict) -> bytes:
    """One seam-owned SSE line: the wire format every frame the seam
    emits itself rides — the same `data: <json>` shape the Mastra
    server writes for its own chunks."""
    return (
        b"data: "
        + json.dumps(payload, ensure_ascii=False).encode("utf-8")
        + b"\n\n"
    )


def _web_guarantee(payload: dict) -> tuple[bool, list]:
    """The «بیرون از کتاب» guarantee from the reply's tool-call record
    (#24, ADR-0018): web_sourced is TRUE only when a tool-RESULT for the
    web tool exists — the tool EXECUTED — and the sources are that
    result's own entries. Never text-parsed; a reply without tool
    records (no web round) is honestly false with no sources."""
    sourced = False
    sources: list = []
    records = payload.get("toolResults")
    if isinstance(records, list):
        for record in records:
            if not isinstance(record, dict):
                continue
            inner = record.get("payload")
            if (
                not isinstance(inner, dict)
                or inner.get("toolName") not in WEB_TOOL_NAMES
            ):
                continue
            # A tool-result record for the web tool IS the executed proof.
            sourced = True
            result = inner.get("result")
            items = result.get("results") if isinstance(result, dict) else None
            for item in items if isinstance(items, list) else ():
                if (
                    isinstance(item, dict)
                    and isinstance(item.get("title"), str)
                    and isinstance(item.get("url"), str)
                    # The seam owns the safe-links rule (#24 fixup, spec
                    # #21 story 17): the sheet renders each source as a
                    # real anchor with a.href set verbatim, so only an
                    # http(s) url may survive — a javascript:/ftp:/empty
                    # url drops the source entirely. Honest absence
                    # beats a dead or dangerous link.
                    and item["url"].lower().startswith(
                        ("http://", "https://")
                    )
                ):
                    sources.append({"title": item["title"], "url": item["url"]})
    return sourced, sources[:MAX_WEB_SOURCES]


def _request_body(query: str, datasets, thread_id: str) -> dict:
    """The ONE body both routes carry (the generate call's own shape —
    #24's pin): the message, the per-Learner thread, and the Book
    selection riding the requestContext, never the prompt text."""
    return {
        "messages": [{"role": "user", "content": query}],
        "memory": {"thread": thread_id, "resource": thread_id},
        "requestContext": {"datasets": list(datasets or [])},
    }


class AgentStream:
    """The streamed agent call (issue #26): iterate to relay the
    upstream's SSE frames UNBUFFERED — one readline at a time, the
    serve.py _relay close-delimited pattern — while ACCUMULATING the
    answer text (the ``text-delta`` frames' payloads) and the tool-call
    records (the ``tool-result`` frames' payloads — the «بیرون از
    کتاب» guarantee's source, in the generate() reply's own
    toolResults[] entry shape so ONE derivation serves both paths). The
    stream never raises upstream failures at its consumer: a failed,
    unreachable, or stalled (leashed — AGENT_TIMEOUT, read at call
    time, fractional so the tests pin a tiny leash) upstream ends with
    the honest-error frame instead. ``reply`` — the structured
    {"text", "web_sourced", "sources"} — is set ONLY when an answer
    completed, so the handler's completion-anchored metering
    (record_question + record_agent_exchange, then the finalize frame)
    can never run for a stream that failed, stalled, or was abandoned
    (abort(): the Learner went away; the upstream is torn down and
    nothing is answered)."""

    def __init__(self, query: str, datasets, thread_id: str):
        self.query = query
        self.datasets = datasets
        self.thread_id = thread_id
        self.reply = None
        self._response = None
        self._generator = None

    def abort(self) -> None:
        """Tear the upstream down (a gone Learner abandons the stream):
        close the response — a real socket's close unblocks a blocked
        readline — and leave ``reply`` forever unset."""
        response, self._response = self._response, None
        if response is not None:
            try:
                response.close()
            except OSError:
                pass

    def close(self) -> None:
        """Close the relay generator (its teardown aborts the upstream);
        idempotent, and a completed stream is already closed."""
        if self._generator is not None:
            self._generator.close()
            self._generator = None

    def _error_frame(self, detail: str) -> bytes:
        return sse_frame({"type": CHAT_ANSWER_ERROR, "detail": detail})

    def __iter__(self):
        if self._generator is None:
            self._generator = self._relay()
        return self._generator

    def _relay(self):
        # A fractional leash is legitimate: the stall test pins
        # AGENT_TIMEOUT at a fraction, and float() reads "120" the same
        # as the generate path's int.
        leash = float(os.environ.get("AGENT_TIMEOUT", "120"))
        request = Request(
            _agent_stream_url(),
            data=json.dumps(
                _request_body(self.query, self.datasets, self.thread_id),
                ensure_ascii=False,
            ).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        try:
            self._response = urlopen(request, timeout=leash)
        except HTTPError:
            # HTTPError is a URLError subclass; caught here first so a
            # reachable-but-failing agent keeps the 502's own text,
            # never the unreachable's.
            yield self._error_frame(AGENT_FAILED_DETAIL)
            return
        except (URLError, TimeoutError, OSError):
            yield self._error_frame(AGENT_UNREACHABLE_DETAIL)
            return

        # The leash must fire on a stalled upstream even though a
        # blocking readline cannot be interrupted in-thread: the reader
        # thread owns the readline and the main loop waits on the queue
        # with the leash as its own timeout. abort()'s close unblocks
        # the reader on a real socket.
        lines: "queue.Queue" = queue.Queue()

        def _read_upstream() -> None:
            try:
                while True:
                    line = self._response.readline()
                    if not line:
                        lines.put(None)
                        return
                    lines.put(line)
            except BaseException as exc:  # OSError/TimeoutError mid-read
                lines.put(exc)

        reader = threading.Thread(target=_read_upstream, daemon=True)
        reader.start()

        text_parts: list = []
        tool_records: list = []
        try:
            while True:
                try:
                    item = lines.get(timeout=leash)
                except queue.Empty:
                    # STALL: no upstream line within the leash.
                    yield self._error_frame(AGENT_UNREACHABLE_DETAIL)
                    return
                if item is None:
                    break  # the upstream ended — completion territory
                if isinstance(item, BaseException):
                    # The read failed mid-stream: partial text is not an
                    # answer.
                    yield self._error_frame(AGENT_UNREACHABLE_DETAIL)
                    return
                yield item
                self._accumulate(item, text_parts, tool_records)
        finally:
            self.abort()

        text = "".join(text_parts)
        if not text.strip():
            # The upstream ended without composing an answer — the
            # streamed twin of the reply-without-text.
            yield self._error_frame(AGENT_FAILED_DETAIL)
            return
        web_sourced, sources = _web_guarantee({"toolResults": tool_records})
        self.reply = {"text": text, "web_sourced": web_sourced, "sources": sources}

    @staticmethod
    def _accumulate(line: bytes, text_parts: list, tool_records: list) -> None:
        """Fold one relayed upstream line into the accumulating answer:
        ``text-delta`` frames grow the text, ``tool-result`` frames
        collect the executed tool's record (already the generate()
        reply's toolResults[] entry shape — the payload dict itself — so
        _web_guarantee reads both paths through ONE implementation).
        Every other frame (start, step-start, finish, the upstream's
        [DONE] terminator, SSE comments) relays without accumulating."""
        stripped = line.strip()
        if not stripped.startswith(b"data:"):
            return
        data = stripped[len(b"data:") :].strip()
        if not data or data == b"[DONE]":
            return
        try:
            frame = json.loads(data)
        except ValueError:
            return
        if not isinstance(frame, dict):
            return
        kind = frame.get("type")
        if kind == "text-delta":
            payload = frame.get("payload")
            if isinstance(payload, dict) and isinstance(payload.get("text"), str):
                text_parts.append(payload["text"])
        elif kind == "tool-result":
            payload = frame.get("payload")
            if isinstance(payload, dict):
                tool_records.append({"payload": payload})


def agent_answer(query: str, datasets, thread_id: str) -> dict:
    """One Learner message through the agent; the STRUCTURED reply back
    — {"text", "web_sourced", "sources"} — the marking derived from the
    reply's tool-call record so it is the platform's guarantee, never
    the model's memory (#24, ADR-0018). Raises AgentError when the reply
    carries no answer and URLError/TimeoutError/OSError when the service
    is unreachable — the seam maps both (502/504) and meters neither: a
    Question is an ANSWERED message (ADR-0018)."""
    request = Request(
        _agent_url(),
        data=json.dumps(
            _request_body(query, datasets, thread_id), ensure_ascii=False
        ).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    timeout = int(os.environ.get("AGENT_TIMEOUT", "120"))
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read() or b"{}")
    except HTTPError as exc:
        # HTTPError is a URLError subclass; caught here first so a
        # reachable-but-failing agent stays a 502, never a 504.
        raise AgentError(f"the agent service answered {exc.code}") from exc
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise AgentError("the agent reply carries no answer")
    web_sourced, sources = _web_guarantee(payload)
    return {"text": text, "web_sourced": web_sourced, "sources": sources}
