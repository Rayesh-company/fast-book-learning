"""The Learner-facing seam (ADR-0018): the sheet's chat surface goes
through the Mastra agent — each Learner message that RECEIVES an agent
answer is one Question inside the 30-per-5-hours window, the exchange
persists for the reload's no-rebilling restore (ADR-0014's leg), and the
sheet's Book selection rides the seam's requestContext to the agent's
search-books tool. The Mastra upstream is canned (scripted replies at
ui.agent_client's urlopen seam — the tests.helpers rule); the window's
own arithmetic is pinned in test_question_window.py."""

import json
import sys
import time
from urllib.error import URLError

from tests.conftest import REPO_ROOT
from tests.helpers import FakeResponse, get, post, stop_gate, with_gate

sys.path.insert(0, str(REPO_ROOT))

from ui import question_window  # noqa: E402

PHONE = "09120000000"


class AgentUpstream:
    """The canned Mastra service: each call answers the next scripted
    reply (an Exception stands for a failed call); the payloads and URLs
    are captured for the seam's assertions."""

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
        return FakeResponse(item)


def agent_ok(text):
    return json.dumps({"text": text}, ensure_ascii=False).encode("utf-8")


def with_agent(tmp_path, replies):
    question_window.WINDOW_DB = tmp_path / "window.sqlite3"
    upstream = AgentUpstream(replies)
    return (upstream,) + with_gate(tmp_path, upstream)


def ask_agent(base, payload, phone=PHONE):
    return post(base, "/agent/chat", payload, phone=phone)


def test_an_answered_message_is_exactly_one_question(tmp_path):
    upstream, base, server, original = with_agent(
        tmp_path, [agent_ok("پاسخ عامل با استناد")]
    )
    try:
        status, payload = ask_agent(
            base, {"query": "پرسش؟", "datasets": ["tarhe-kolli"]}
        )
    finally:
        stop_gate(server, original)
    assert status == 200
    assert payload["answer"] == "پاسخ عامل با استناد"
    assert payload["thread_id"] == f"learner-{PHONE}"
    assert question_window.questions_in_window(PHONE) == 1


def test_the_full_window_refuses_the_next_message_without_calling_the_agent(
    tmp_path,
):
    upstream, base, server, original = with_agent(
        tmp_path, [agent_ok("نباید صدا شود")]
    )
    try:
        for _ in range(question_window.QUESTION_WINDOW_LIMIT):
            question_window.record_question(PHONE)
        status, payload = ask_agent(base, {"query": "پرسش؟"})
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


def test_an_unanswered_message_is_not_a_question(tmp_path):
    upstream, base, server, original = with_agent(
        tmp_path, [URLError("agent service down")]
    )
    try:
        status, payload = ask_agent(base, {"query": "پرسش؟"})
        history_status, history = get(base, "/agent/chat/history", phone=PHONE)
    finally:
        stop_gate(server, original)
    assert status == 504
    assert payload["detail"]
    # No answer landed: no Question, no persisted exchange.
    assert question_window.questions_in_window(PHONE) == 0
    assert history_status == 200
    assert history["messages"] == []


def test_a_reply_without_an_answer_text_is_not_a_question(tmp_path):
    upstream, base, server, original = with_agent(
        tmp_path, [json.dumps({"unexpected": True}).encode("utf-8")]
    )
    try:
        status, _ = ask_agent(base, {"query": "پرسش؟"})
    finally:
        stop_gate(server, original)
    assert status == 502
    assert question_window.questions_in_window(PHONE) == 0


def test_an_agent_error_status_is_a_502_not_an_unreachable(tmp_path):
    # The first capacity rehearsal: the provider's rate limit made the
    # agent answer 500s, and the seam called them 504 (HTTPError is a
    # URLError subclass). A reachable-but-failing agent is a 502 —
    # "the agent did not answer", never "the agent is unreachable".
    from urllib.error import HTTPError
    from io import BytesIO

    upstream, base, server, original = with_agent(
        tmp_path,
        [HTTPError("http://agent", 500, "upstream refused", {}, BytesIO(b"{}"))],
    )
    try:
        status, _ = ask_agent(base, {"query": "پرسش؟"})
    finally:
        stop_gate(server, original)
    assert status == 502
    assert question_window.questions_in_window(PHONE) == 0


def test_the_thread_is_stable_and_the_selection_rides_the_seam(tmp_path):
    upstream, base, server, original = with_agent(
        tmp_path, [agent_ok("یک"), agent_ok("دو")]
    )
    try:
        for query in ("پرسش اول؟", "پرسش دوم؟"):
            status, _ = ask_agent(
                base, {"query": query, "datasets": ["tarhe-kolli"]}
            )
            assert status == 200
    finally:
        stop_gate(server, original)
    # Every message rides the same per-Learner thread (the agent's own
    # memory carries the conversation) with the Book selection in the
    # requestContext — never in the prompt text.
    for payload in upstream.payloads:
        assert payload["memory"]["thread"] == f"learner-{PHONE}"
        assert payload["messages"] == [
            {"role": "user", "content": payload["messages"][0]["content"]}
        ]
        assert payload["requestContext"]["datasets"] == ["tarhe-kolli"]


def test_the_reload_restores_without_the_agent_or_metering(tmp_path):
    upstream, base, server, original = with_agent(tmp_path, [agent_ok("پاسخ")])
    try:
        status, _ = ask_agent(base, {"query": "پرسش؟"})
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


# --- the window state on the seam (issue #23): every reply carries it
# so the sheet's counter never needs a second shape -----------------------


def _persian_clock(epoch: float) -> str:
    """The reopen time the way the server renders it: the local clock's
    hour and minute, in Farsi digits."""
    reopen = time.localtime(epoch)
    return f"{reopen.tm_hour:02d}:{reopen.tm_min:02d}".translate(
        str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")
    )


def test_the_reply_carries_the_window_state_after_the_question_lands(tmp_path):
    upstream, base, server, original = with_agent(tmp_path, [agent_ok("پاسخ")])
    try:
        status, payload = ask_agent(base, {"query": "پرسش؟"})
    finally:
        stop_gate(server, original)
    assert status == 200
    # Computed AFTER record_question: the first answered message leaves
    # 29, with this Question's own aging-out as the reopen moment.
    assert payload["window"]["remaining"] == question_window.QUESTION_WINDOW_LIMIT - 1
    assert isinstance(payload["window"]["reopens_at"], float)


def test_the_history_read_carries_the_window_state_recomputed_fresh(tmp_path):
    upstream, base, server, original = with_agent(tmp_path, [agent_ok("پاسخ")])
    try:
        _, reply = ask_agent(base, {"query": "پرسش؟"})
        history_status, history = get(base, "/agent/chat/history", phone=PHONE)
    finally:
        stop_gate(server, original)
    assert history_status == 200
    # Recomputed from the store, not echoed from the reply — but over
    # the same one recorded Question, so the two reads agree exactly.
    assert history["window"] == reply["window"]
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
        status, payload = ask_agent(base, {"query": "پرسش؟"})
    finally:
        stop_gate(server, original)
    assert status == 429
    expected_reopens = (now - 3600) + question_window.QUESTION_WINDOW_HOURS * 3600
    # The payload carries the same structured window the 200s do, so
    # the counter renders from the refusal itself.
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
