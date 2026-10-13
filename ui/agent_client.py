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

from dataclasses import dataclass, field
import json
import os
import queue
import threading
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    from ui.accounts import get_profile
    from ui.dive import BOOK_DATASETS
    from ui.page_resolver import get_page_context
except ImportError:
    from accounts import get_profile
    from dive import BOOK_DATASETS
    from page_resolver import get_page_context

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


def validated_datasets(raw: list | None) -> list[str] | None:
    """The ask's Book selection (ADR-0010): the client's list
    intersected with the Book set, in the set's stable order — a name
    outside the Book set never reaches an upstream. None (missing,
    malformed, or nothing left) means the whole Book set, the shape
    every searcher already treats as the default."""
    if not isinstance(raw, list):
        return None
    picked = {item for item in raw if isinstance(item, str) and item in BOOK_DATASETS}
    if not picked:
        return None
    return [dataset for dataset in BOOK_DATASETS if dataset in picked]


def normalize_selection(
    selection: dict | str | None,
    default_page: int | None = None,
    default_book: str | None = None,
) -> dict | None:
    """Normalize user selection payload into a canonical dictionary or None.

    Accepts either:
    - a dict with 'text' and optional 'page'/'book'
    - a non-empty string representing selected text
    Returns None if selection is empty, missing, or whitespace.
    """
    if not selection:
        return None
    if isinstance(selection, dict):
        text = selection.get("text")
        if not isinstance(text, str) or not text.strip():
            return None
        res = {"text": text.strip()}
        page = (
            selection.get("page")
            if selection.get("page") is not None
            else default_page
        )
        if page is not None:
            res["page"] = page
        book = selection.get("book") or default_book
        if book:
            res["book"] = book
        return res
    if isinstance(selection, str):
        text = selection.strip()
        if not text:
            return None
        res = {"text": text}
        if default_page is not None:
            res["page"] = default_page
        if default_book:
            res["book"] = default_book
        return res
    return None


@dataclass
class LearnerTurnContext:
    query: str
    datasets: list[str] = field(default_factory=list)
    thread_id: str = ""
    resource_id: str = ""
    user_profile: dict = field(default_factory=dict)
    page_context: dict | None = None
    selection_text: dict | str | None = None

    def __post_init__(self) -> None:
        if self.datasets is None:
            self.datasets = []
        elif not isinstance(self.datasets, list):
            self.datasets = list(self.datasets)
        if not self.resource_id:
            self.resource_id = self.thread_id
        if self.user_profile is None:
            self.user_profile = {}

    def to_request_body(self) -> dict:
        """The ONE body both routes carry (the generate call's own shape —
        #24's pin): the message, the per-Learner thread, and the Book
        selection, user profile, and active page context riding the requestContext,
        never the prompt text."""
        body = {
            "messages": [{"role": "user", "content": self.query}],
            "memory": {
                "thread": self.thread_id,
                "resource": self.resource_id or self.thread_id,
            },
            "requestContext": {"datasets": list(self.datasets or [])},
        }
        if self.user_profile:
            body["requestContext"]["userProfile"] = self.user_profile
        if self.page_context:
            body["requestContext"]["pageContext"] = self.page_context
        if self.selection_text:
            body["requestContext"]["selectionText"] = self.selection_text
        return body

    @classmethod
    def from_request(
        cls, phone: str, account: str | None, payload: dict
    ) -> LearnerTurnContext:
        """Factory creating turn context from a client request payload."""
        if not isinstance(payload, dict):
            raise ValueError("payload must be a dictionary")
        query = payload.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query is required")
        query = query.strip()
        datasets = validated_datasets(payload.get("datasets")) or []
        thread_id = f"learner-{phone}"
        resource_id = f"learner-{account or phone}"
        user_profile = (get_profile(account) if account else {}) or {}
        book = payload.get("book") or (datasets[0] if datasets else None)
        page = payload.get("page")
        pages = payload.get("pages")
        scope = payload.get("scope")
        page_context = None
        if (scope == "page" or "این بخش" in query or "این صفحه" in query) and (page is not None or pages) and book:
            page_context = get_page_context(book, page, pages=pages)
        selection = payload.get("selection")
        selection_payload = normalize_selection(
            selection,
            default_page=page,
            default_book=book,
        )
        return cls(
            query=query,
            datasets=datasets,
            thread_id=thread_id,
            resource_id=resource_id,
            user_profile=user_profile,
            page_context=page_context,
            selection_text=selection_payload,
        )


def _coerce_turn_context(
    turn_or_query: LearnerTurnContext | str = None,
    datasets=None,
    thread_id: str = "",
    resource_id: str = None,
    user_profile: dict = None,
    page_context: dict = None,
    selection_text: dict | str = None,
    *,
    query: str = None,
) -> LearnerTurnContext:
    if isinstance(turn_or_query, LearnerTurnContext):
        return turn_or_query
    actual_query = query if query is not None else (turn_or_query or "")
    return LearnerTurnContext(
        query=actual_query,
        datasets=list(datasets or []),
        thread_id=thread_id,
        resource_id=resource_id or thread_id,
        user_profile=user_profile or {},
        page_context=page_context,
        selection_text=selection_text,
    )


def _request_body(
    turn_or_query: LearnerTurnContext | str = None,
    datasets=None,
    thread_id: str = "",
    resource_id: str = None,
    user_profile: dict = None,
    page_context: dict = None,
    selection_text: dict | str = None,
    *,
    query: str = None,
) -> dict:
    """The ONE body both routes carry (the generate call's own shape —
    #24's pin): the message, the per-Learner thread, and the Book
    selection, user profile, and active page context riding the requestContext,
    never the prompt text."""
    return _coerce_turn_context(
        turn_or_query,
        datasets=datasets,
        thread_id=thread_id,
        resource_id=resource_id,
        user_profile=user_profile,
        page_context=page_context,
        selection_text=selection_text,
        query=query,
    ).to_request_body()


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

    def __init__(
        self,
        turn: LearnerTurnContext | str = None,
        datasets=None,
        thread_id: str = "",
        resource_id: str = None,
        user_profile: dict = None,
        page_context: dict = None,
        selection_text: dict | str = None,
        *,
        query: str = None,
    ):
        self.turn = (
            turn
            if isinstance(turn, LearnerTurnContext)
            else _coerce_turn_context(
                turn,
                datasets=datasets,
                thread_id=thread_id,
                resource_id=resource_id,
                user_profile=user_profile,
                page_context=page_context,
                selection_text=selection_text,
                query=query,
            )
        )
        self.reply = None
        self._response = None
        self._generator = None

    @property
    def query(self) -> str:
        return self.turn.query

    @property
    def datasets(self) -> list[str]:
        return self.turn.datasets

    @property
    def thread_id(self) -> str:
        return self.turn.thread_id

    @property
    def resource_id(self) -> str:
        return self.turn.resource_id

    @property
    def user_profile(self) -> dict:
        return self.turn.user_profile

    @property
    def page_context(self) -> dict | None:
        return self.turn.page_context

    @property
    def selection_text(self) -> dict | str | None:
        return self.turn.selection_text

    def to_request_body(self) -> dict:
        return self.turn.to_request_body()

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
                self.turn.to_request_body(),
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


def agent_answer(
    turn: LearnerTurnContext | str = None,
    datasets=None,
    thread_id: str = "",
    resource_id: str = None,
    user_profile: dict = None,
    page_context: dict = None,
    selection_text: dict | str = None,
    *,
    query: str = None,
) -> dict:
    """One Learner message through the agent; the STRUCTURED reply back
    — {"text", "web_sourced", "sources"} — the marking derived from the
    reply's tool-call record so it is the platform's guarantee, never
    the model's memory (#24, ADR-0018). Raises AgentError when the reply
    carries no answer and URLError/TimeoutError/OSError when the service
    is unreachable — the seam maps both (502/504) and meters neither: a
    Question is an ANSWERED message (ADR-0018)."""
    body = _coerce_turn_context(
        turn,
        datasets=datasets,
        thread_id=thread_id,
        resource_id=resource_id,
        user_profile=user_profile,
        page_context=page_context,
        selection_text=selection_text,
        query=query,
    ).to_request_body()
    request = Request(
        _agent_url(),
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
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
