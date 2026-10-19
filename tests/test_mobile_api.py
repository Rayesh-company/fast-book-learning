"""The mobile clients' API contract (ADR-0020): one backend, both
clients. The native app holds the login token in its secure store and
rides the Authorization: Bearer header where the browser rides the
HttpOnly cookie; a browser client on an allowlisted Origin may call
cross-origin (the Expo web dev server); and the live line — /events —
pushes the settles this backend lands server-side the moment they
land, so an ask on one device opens the sitting on the other."""

import http.client
import json
import threading
import urllib.parse
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from tests.helpers import (
    ADMIN_EMAIL,
    TEST_PASSWORD,
    account_email_for_phone,
    ensure_account,
    stop_gate,
    with_gate,
)

import sys

from tests.conftest import REPO_ROOT

sys.path.insert(0, str(REPO_ROOT))

from ui import serve  # noqa: E402


PHONE = "09130000000"


def _bearer_request(base, path, token, method="GET", payload=None):
    """One request riding the Authorization header, no cookie — the
    mobile client's exact wire shape."""
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


def _login_token(base, email=ADMIN_EMAIL, password=TEST_PASSWORD):
    status, payload = _bearer_request(
        base,
        "/auth/login",
        token="",
        method="POST",
        payload={"email": email, "password": password},
    )
    assert status == 200, payload
    return payload["token"]


class _Body:
    """The urlopen seam's reply: a context manager whose read() is the
    bytes — the shape ask.py's searcher unpacks."""

    def __init__(self, body):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class EmptyUpstream:
    """The upstream seam that answers an empty context doc list: enough
    for the ask's contract (the honest {"sources": []} is a settled
    reply) without any retrieval. Callable, the seam's shape."""

    def __init__(self):
        self.search_bodies = []

    def __call__(self, request, timeout=None):
        return _Body(b"[]")


def test_login_body_carries_the_bearer_token(tmp_path):
    base, server, original = with_gate(tmp_path, EmptyUpstream())
    try:
        token = _login_token(base)
        # The token is the same signed payload the cookie carries, and
        # verify_token takes it back.
        claims = serve.verify_token(token)
        assert claims["email"] == ADMIN_EMAIL
    finally:
        stop_gate(server, original)


def test_bearer_header_authenticates_the_gated_reads(tmp_path):
    base, server, original = with_gate(tmp_path, EmptyUpstream())
    try:
        ensure_account(PHONE)
        token = _login_token(
            base, account_email_for_phone(PHONE), "cwb-test-password"
        )
        # The gated reads answer the Bearer header exactly as they
        # answer the cookie — the mobile client's whole auth.
        status, payload = _bearer_request(base, "/sessions", token)
        assert status == 200
        assert payload == {"sessions": []}
        status, payload = _bearer_request(base, "/chat/latest", token)
        assert status == 200
        assert payload["chat"] is None
        status, payload = _bearer_request(base, "/auth/me", token)
        assert status == 200
        assert payload["email"] == account_email_for_phone(PHONE)
    finally:
        stop_gate(server, original)


def test_a_tampered_bearer_refuses_like_a_bad_cookie(tmp_path):
    base, server, original = with_gate(tmp_path, EmptyUpstream())
    try:
        token = _login_token(base)
        status, payload = _bearer_request(base, "/sessions", token + "x")
        assert status == 401
        assert payload["detail"] == serve.AUTH_LOGIN_401_DETAIL
        status, _ = _bearer_request(base, "/sessions", "")
    finally:
        stop_gate(server, original)


def test_cors_stamps_only_the_allowlisted_origin(tmp_path, monkeypatch):
    monkeypatch.delenv("SESSION_UI_ALLOWED_ORIGINS", raising=False)
    base, server, original = with_gate(tmp_path, EmptyUpstream())
    try:
        # No allowlist, no stamps: the recorded production shape.
        request = Request(base + "/livez", headers={"Origin": "http://localhost:8081"})
        with urlopen(request, timeout=10) as response:
            assert response.headers.get("Access-Control-Allow-Origin") is None
    finally:
        stop_gate(server, original)
    monkeypatch.setenv(
        "SESSION_UI_ALLOWED_ORIGINS", "http://localhost:8081,https://books.example.ir"
    )
    base, server, original = with_gate(tmp_path, EmptyUpstream())
    try:
        request = Request(base + "/livez", headers={"Origin": "http://localhost:8081"})
        with urlopen(request, timeout=10) as response:
            assert (
                response.headers.get("Access-Control-Allow-Origin")
                == "http://localhost:8081"
            )
            assert response.headers.get("Access-Control-Allow-Credentials") == "true"
        # A foreign origin earns nothing.
        request = Request(base + "/livez", headers={"Origin": "https://evil.example"})
        with urlopen(request, timeout=10) as response:
            assert response.headers.get("Access-Control-Allow-Origin") is None
        # The preflight is a question about access, answered bare.
        request = Request(
            base + "/ask",
            method="OPTIONS",
            headers={
                "Origin": "http://localhost:8081",
                "Access-Control-Request-Method": "POST",
            },
        )
        with urlopen(request, timeout=10) as response:
            assert response.status == 204
            assert (
                response.headers.get("Access-Control-Allow-Origin")
                == "http://localhost:8081"
            )
    finally:
        stop_gate(server, original)


def test_the_live_line_pushes_the_settles(tmp_path, monkeypatch):
    monkeypatch.setattr(serve, "_EVENT_HEARTBEAT", 0.2)
    base, server, original = with_gate(tmp_path, EmptyUpstream())
    try:
        ensure_account(PHONE)
        email = account_email_for_phone(PHONE)
        token = _login_token(base, email, "cwb-test-password")
        host, port = urllib.parse.urlparse(base).netloc.split(":")
        seen = {"connected": threading.Event(), "event": None}
        timed_out = threading.Event()

        def reader():
            # The SSE client: headers, then frames, read off the
            # response itself (the connection's own 5s leash bounds
            # every blocking read).
            conn = http.client.HTTPConnection(host, int(port), timeout=5)
            conn.request(
                "GET", "/events", headers={"Authorization": f"Bearer {token}"}
            )
            response = conn.getresponse()
            assert response.status == 200
            assert response.headers.get("Content-Type").startswith("text/event-stream")
            while True:
                line = response.readline()
                if not line:
                    break
                if line.startswith(b"data: "):
                    seen["event"] = json.loads(line[len(b"data: ") :])
                    conn.close()
                    return
                if line.startswith(b": connected"):
                    seen["connected"].set()
            conn.close()

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()
        # The subscriber must be in the hub before the settle fires.
        for _ in range(100):
            with serve._EVENT_LOCK:
                if serve._EVENT_CLIENTS.get(email):
                    break
            timed_out.wait(0.05)
        assert seen["connected"].wait(5), "the stream never opened"
        # One ask settles server-side; the live line carries it.
        status, payload = _bearer_request(
            base,
            "/ask",
            token,
            method="POST",
            payload={"query": "پرسش زنده؟"},
        )
        assert status == 200
        thread.join(timeout=6)
        event = seen["event"]
        assert event is not None, "no event frame ever arrived"
        assert event["kind"] == "chat.asked"
        assert event["chat_id"] == payload["chat_id"]
        assert event["query"] == "پرسش زنده؟"
    finally:
        stop_gate(server, original)


def test_the_live_line_answers_401_anonymous(tmp_path):
    base, server, original = with_gate(tmp_path, EmptyUpstream())
    try:
        status, payload = _bearer_request(base, "/events", "")
        assert status == 401
    finally:
        stop_gate(server, original)


def test_the_mobile_client_speaks_the_sheets_own_routes():
    # One backend, both clients (ADR-0020): every path the app calls
    # is a route the sheet's server serves — the contract is the
    # sheet's own wire protocol, never a second API.
    mobile_src = REPO_ROOT / "mobile" / "src"
    mobile = (mobile_src / "api.ts").read_text(encoding="utf-8") + (
        mobile_src / "events.ts"
    ).read_text(encoding="utf-8")
    server = (REPO_ROOT / "ui" / "serve.py").read_text(encoding="utf-8")
    for route in (
        "/auth/login",
        "/auth/logout",
        "/sessions",
        "/ask",
        "/quote-selection",
        "/quoted-answer",
        "/research/message",
        "/research/turn",
        "/research/state",
        "/events",
    ):
        assert route in mobile, f"the app never calls {route}"
        assert f'"{route}"' in server, f"the app calls {route}, which no route serves"
    # The credential rides the Bearer header, and the login body's
    # token is what the app stores.
    assert "Authorization" in mobile
    assert "expo-secure-store" in mobile
    assert "payload.token" in mobile
