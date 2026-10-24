"""The Book set's Account gate (F-001 of the 2026-10-24 review): every
/books surface — the PDF forms, the full-text page index, the lecture
alignment, one session's MP3, the player's slim summary, the page
rasters — speaks only to a logged-in Account. An anonymous caller
receives the standard 401 before any dataset is even looked at, and
the seeded reader behind the same routes keeps reading.

The client half rides beside it: /auth/me re-plants the HttpOnly
cookie for a Bearer-authenticated caller, because the Book routes'
<img>/<audio>/pdf.js fetches cannot carry an Authorization header —
the WebView's cookie jar dies with the app while the token in its
secure store survives."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import urllib.error
import urllib.request

from tests.conftest import REPO_ROOT
from tests.helpers import (
    account_email_for_phone,
    cookie_for,
    ensure_account,
    stop_gate,
    with_gate,
)

sys.path.insert(0, REPO_ROOT)

import ui.serve as serve  # noqa: E402

MP3 = b"fake-lecture-audio-bytes"

ANONYMOUS_BOOK_PATHS = (
    "/books/tarhe-kolli.pdf",
    "/books/tarhe-kolli/book",
    "/books/tarhe-kolli.pages.json",
    "/books/tarhe-kolli.lectures.json",
    "/books/tarhe-kolli.lectures.summary.json",
    "/books/tarhe-kolli/lectures/session_01.mp3",
    "/books/tarhe-kolli/page/14.png?w=640",
)


class NoUpstream:
    def __call__(self, request, timeout=None):
        raise AssertionError(f"upstream called: {request.full_url}")


def _plant_books(tmp_path, monkeypatch):
    books = tmp_path / "books"
    books.mkdir(exist_ok=True)
    (books / "tarhe-kolli.pdf").write_bytes(b"%PDF-fake")
    (books / "tarhe-kolli.pages.json").write_text(
        '{"pages": {"1": "متن"}}', encoding="utf-8"
    )
    (books / "tarhe-kolli.lectures.json").write_text(
        '{"format":1}', encoding="utf-8"
    )
    audio = tmp_path / "audio"
    (audio / "tarhe-kolli").mkdir(parents=True)
    (audio / "tarhe-kolli" / "session_01.mp3").write_bytes(MP3)
    monkeypatch.setattr(serve, "BOOKS_DIR", books)
    monkeypatch.setenv("LECTURE_AUDIO_DIR", str(audio))


def test_every_books_surface_refuses_the_anonymous_caller(tmp_path, monkeypatch):
    """The corpus is the paying Customer's content: no login, no bytes —
    the gate answers before the dataset allowlist or the filesystem is
    ever consulted, so a stranger learns nothing but the door itself."""
    _plant_books(tmp_path, monkeypatch)
    base, server, original = with_gate(tmp_path, NoUpstream())
    try:
        for path in ANONYMOUS_BOOK_PATHS:
            request = urllib.request.Request(base + path)
            try:
                urllib.request.urlopen(request, timeout=10)
                raise AssertionError(f"anonymous read opened: {path}")
            except urllib.error.HTTPError as exc:
                assert exc.code == 401, path
    finally:
        stop_gate(server, original)


def test_the_seeded_reader_keeps_reading_through_the_same_routes(
    tmp_path, monkeypatch
):
    _plant_books(tmp_path, monkeypatch)
    base, server, original = with_gate(tmp_path, NoUpstream())
    cookie = cookie_for(base, ensure_account("09120000800"))
    try:
        for path in (
            "/books/tarhe-kolli.pdf",
            "/books/tarhe-kolli/book",
            "/books/tarhe-kolli.pages.json",
            "/books/tarhe-kolli.lectures.json",
            "/books/tarhe-kolli/lectures/session_01.mp3",
        ):
            request = urllib.request.Request(
                base + path, headers={"Cookie": cookie}
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                assert response.status == 200, path
    finally:
        stop_gate(server, original)


def test_auth_me_replants_the_cookie_for_a_bearer_caller(tmp_path, monkeypatch):
    """The WebView's cookie jar dies with the app; the token does not.
    A whoami that authenticated by Bearer alone re-plants the HttpOnly
    cookie the Book routes' header-less fetches ride — and a caller
    already holding the cookie gets no second Set-Cookie."""
    base, server, original = with_gate(tmp_path, NoUpstream())
    try:
        email = ensure_account("09120000801")
        # One login by cookie — the response carries the native
        # clients' token (ADR-0020) beside the Set-Cookie.
        request = urllib.request.Request(
            base + "/auth/login",
            data=(
                '{"email": "%s", "password": "cwb-test-password"}' % email
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.loads(response.read())
            token = body["token"]

        # A Bearer whoami with NO cookie: the cookie rides back.
        request = urllib.request.Request(
            base + "/auth/me", headers={"Authorization": f"Bearer {token}"}
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            set_cookie = response.headers.get("Set-Cookie", "")
        assert set_cookie.startswith("cwb_auth=")

        # A whoami that already carries the cookie: no second plant.
        request = urllib.request.Request(
            base + "/auth/me", headers={"Cookie": cookie_for(base, email)}
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            assert response.headers.get("Set-Cookie") is None
    finally:
        stop_gate(server, original)
