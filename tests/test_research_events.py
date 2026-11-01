"""The research turn's settle on the live line (ADR-0020): the engine's
terminal writes (done, the budget's honest stop, failed, aborted) ring
the module-level listener serve installs, and the tap fans the settle
out as "research.settled" — the poll (/research/turn) stays the full
payload's read, the stream stays the bell. Unit level, the listener's
contract: exactly one ring per terminal write, only when the write
actually sat (a settled turn is never re-rung), a broken ring never
breaks the turn. Wire level, the frame's shape through the real hub —
the same live-line harness the mobile contract tests read."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import http.client  # noqa: E402
import json  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import urllib.parse  # noqa: E402
from urllib.error import HTTPError  # noqa: E402
from urllib.request import Request, urlopen  # noqa: E402

from tests.helpers import (  # noqa: E402
    TEST_PASSWORD,
    account_email_for_phone,
    ensure_account,
    stop_gate,
    wait_turn_done,
    with_gate,
)
from tests.upstream_fakes import (  # noqa: E402
    PHONE,
    ResearchUpstream,
    classify_reply,
    conversational_writer_reply,
    make_session,
    run_turn_sync,
)

from ui import research, serve  # noqa: E402


def _bearer_request(base, path, token, method="GET", payload=None):
    """One request riding the Authorization header, no cookie — the
    mobile client's exact wire shape (test_mobile_api.py's helper)."""
    headers = {"Authorization": f"Bearer {token}"}
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    request = Request(base + path, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=10) as response:
            body = response.read()
            return response.status, json.loads(body) if body else {}
    except HTTPError as exc:
        body = exc.read()
        return exc.code, json.loads(body) if body else {}


def _login_token(base, email):
    status, payload = _bearer_request(
        base,
        "/auth/login",
        token="",
        method="POST",
        payload={"email": email, "password": TEST_PASSWORD},
    )
    assert status == 200, payload
    return payload["token"]


def _record_rings():
    """Park the recorder on the module-level tap; the returned closure
    restores whatever was parked BEFORE the recorder (serve installs
    its shim at import — clearing to None here would deafen every
    later test in the same process, the wire test included)."""
    rings = []
    previous = research._TURN_EVENT_LISTENER

    def record(turn):
        rings.append(turn)

    def restore():
        research.set_turn_event_listener(previous)

    research.set_turn_event_listener(record)
    return rings, restore


# --- the listener's contract, unit level -------------------------------------


def test_a_done_turn_rings_the_listener_once_with_the_settled_turn(tmp_path):
    rings, restore = _record_rings()
    try:
        session = make_session(tmp_path)
        upstream = ResearchUpstream(
            composer_replies=[
                classify_reply("casual_question"),
                conversational_writer_reply(),
            ]
        )
        turn = run_turn_sync(session, "پیام ساده", upstream, tmp_path)
    finally:
        restore()
    assert turn.state == "done"
    assert rings == [turn]


def test_a_budget_stopped_turn_rings_the_listener_too(tmp_path):
    # The honest stop settles done without RESEARCH_EVENT_DONE — its own
    # terminal write, its own ring (the same bell, not a second kind).
    rings, restore = _record_rings()
    try:
        session = make_session(tmp_path)
        upstream = ResearchUpstream(composer_replies=[classify_reply("casual_question")])
        turn = run_turn_sync(session, "پیام ساده", upstream, tmp_path, call_cap=2)
    finally:
        restore()
    assert turn.state == "done"
    assert research.RESEARCH_EVENT_BUDGET in turn.events
    assert rings == [turn]


def test_a_failed_turn_rings_once_and_a_settled_retry_rings_nothing(tmp_path):
    rings, restore = _record_rings()
    try:
        session = make_session(tmp_path)
        # A RuntimeError escapes classify_message's guarded trio
        # (KeyError/ValueError/OSError degrade conversationally) — the
        # worker's generic guard settles the turn failed.
        upstream = ResearchUpstream(composer_replies=[RuntimeError("بمب")])
        turn = run_turn_sync(session, "پیام ساده", upstream, tmp_path)
        # The turn is settled: a second terminal write re-rings nothing.
        assert research._turn_fail(turn, "دوباره") is False
        assert research.abort_research_turn(turn) is False
    finally:
        restore()
    assert turn.state == "failed"
    assert turn.error == research.RESEARCH_FAILED_DETAIL
    assert rings == [turn]


def test_an_aborted_turn_rings_once_and_a_rival_abort_rings_nothing(tmp_path):
    rings, restore = _record_rings()
    session = make_session(tmp_path)
    turn = research.ResearchTurn(session["account"], session["id"], "پیام")
    research.RESEARCH_REGISTRY[turn.id] = turn
    try:
        assert research.abort_research_turn(turn) is True
        assert research.abort_research_turn(turn) is False
    finally:
        research.RESEARCH_REGISTRY.pop(turn.id, None)
        restore()
    assert turn.state == "aborted"
    assert turn.cancel.is_set()
    assert rings == [turn]


def test_a_broken_listener_never_breaks_the_turn(tmp_path):
    def bomb(_turn):
        raise RuntimeError("زنگ شکست")

    previous = research._TURN_EVENT_LISTENER
    research.set_turn_event_listener(bomb)
    try:
        session = make_session(tmp_path)
        upstream = ResearchUpstream(
            composer_replies=[
                classify_reply("casual_question"),
                conversational_writer_reply(),
            ]
        )
        turn = run_turn_sync(session, "پیام ساده", upstream, tmp_path)
    finally:
        research.set_turn_event_listener(previous)
    assert turn.state == "done"
    assert turn.result is not None


# --- the wire: the frame through the real hub --------------------------------


def test_the_live_line_carries_the_settles_frame(tmp_path, monkeypatch):
    # The fast heartbeat keeps a lingering handler's writes landing
    # while the test tears the server down (test_mobile_api's shape) —
    # a closed client's socket must never wedge stop_gate.
    monkeypatch.setattr(serve, "_EVENT_HEARTBEAT", 0.2)
    upstream = ResearchUpstream(
        composer_replies=[
            classify_reply("casual_question"),
            conversational_writer_reply(),
        ]
    )
    base, server, original = with_gate(tmp_path, upstream)
    frames = []
    settled = threading.Event()
    body = None
    conns = []
    try:
        email = ensure_account(PHONE)
        token = _login_token(base, email)
        host, port = urllib.parse.urlparse(base).netloc.split(":")

        def reader():
            # The SSE client: headers, then frames, read off the
            # response itself — started rides ahead of settled, so the
            # reader keeps reading until the settle lands.
            conn = http.client.HTTPConnection(host, int(port), timeout=5)
            conns.append(conn)
            conn.request(
                "GET", "/events", headers={"Authorization": f"Bearer {token}"}
            )
            response = conn.getresponse()
            assert response.status == 200
            assert response.headers.get("Content-Type").startswith(
                "text/event-stream"
            )
            while True:
                line = response.readline()
                if not line:
                    break
                if line.startswith(b"data: "):
                    frame = json.loads(line[len(b"data: ") :])
                    frames.append(frame)
                    if frame.get("kind") == "research.settled":
                        settled.set()
                        return

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()
        # The subscriber must sit in the hub before the turn settles.
        for _ in range(100):
            with serve._EVENT_LOCK:
                if serve._EVENT_CLIENTS.get(email):
                    break
            time.sleep(0.05)
        # One research message settles server-side; the live line
        # carries it — the same hub, no second stream.
        status, body = _bearer_request(
            base,
            "/research/message",
            token,
            method="POST",
            payload={"text": "پیام ساده", "question": "پرسش پژوهش؟"},
        )
        assert status == 202, body
        wait_turn_done(body["turn_id"])
        assert settled.wait(5), "no research.settled frame ever arrived"
        thread.join(timeout=6)
    finally:
        for conn in conns:
            try:
                conn.close()
            except Exception:
                pass
        stop_gate(server, original)

    assert frames, "the stream never carried a frame"
    started = [
        frame
        for frame in frames
        if frame["kind"] == "research.started" and frame["turn_id"] == body["turn_id"]
    ]
    assert started, "the settle rode the same stream, but the start never fired"
    settled_frame = next(
        frame for frame in frames if frame["kind"] == "research.settled"
    )
    # The announcement shape is small and exactly these keys — the
    # full payload stays the poll's read (the stores, not the stream).
    assert set(settled_frame) == {"kind", "turn_id", "state", "session_id"}
    assert settled_frame["turn_id"] == body["turn_id"]
    assert settled_frame["state"] == "done"
    assert settled_frame["session_id"] == body["session_id"]
