"""The lecture audio's serving contract (the کتاب‌خوان's lecture
player, the delivery guide's method two): the ~45MB session index
lives beside the PDF it aligns to (books/<dataset>.lectures.json,
box-side, rsync-excluded like the PDFs), the heavy MP3s live OUTSIDE
the tree at LECTURE_AUDIO_DIR/<dataset>/*.mp3, and both routes honor
Range byte-for-byte — seeking IS the player. The allowlist is the
traversal guard: a dataset outside the Book set, a foreign filename,
or an unset audio dir answers the same 404."""

import json
import sys
import threading
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from tests.conftest import REPO_ROOT

sys.path.insert(0, str(REPO_ROOT))

from ui import serve  # noqa: E402
from tests.helpers import stop_gate, with_gate  # noqa: E402

MP3 = b"fake-lecture-audio-bytes-0123456789"


class EmptyUpstream:
    """The with_gate seam's quiet stand-in: no lecture route touches an
    upstream, so an always-empty context is exactly right."""

    def __call__(self, request, timeout=None):
        raise AssertionError("lecture routes must never phone an upstream")


def _get(base, path, range_header=None):
    headers = {"Range": range_header} if range_header else {}
    request = Request(base + path, headers=headers)
    try:
        with urlopen(request, timeout=10) as response:
            return response.status, dict(response.headers), response.read()
    except HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def test_lecture_audio_serves_json_and_mp3_with_range(tmp_path, monkeypatch):
    books = tmp_path / "books"
    books.mkdir()
    (books / "tarhe-kolli.lectures.json").write_text('{"format":1}', encoding="utf-8")
    audio = tmp_path / "audio"
    (audio / "tarhe-kolli").mkdir(parents=True)
    (audio / "tarhe-kolli" / "session_01.mp3").write_bytes(MP3)
    monkeypatch.setattr(serve, "BOOKS_DIR", books)
    monkeypatch.setenv("LECTURE_AUDIO_DIR", str(audio))
    base, server, original = with_gate(tmp_path, EmptyUpstream())
    try:
        # The index rides beside the PDF it aligns to.
        status, headers, body = _get(base, "/books/tarhe-kolli.lectures.json")
        assert status == 200
        assert body == b'{"format":1}'
        assert "application/json" in headers["Content-Type"]
        # One session's MP3, whole and ranged — seeking is the player.
        status, headers, body = _get(base, "/books/tarhe-kolli/lectures/session_01.mp3")
        assert status == 200 and body == MP3
        assert headers["Content-Type"] == "audio/mpeg"
        assert headers["Accept-Ranges"] == "bytes"
        status, headers, body = _get(
            base, "/books/tarhe-kolli/lectures/session_01.mp3", "bytes=5-9"
        )
        assert status == 206
        assert body == MP3[5:10]
        assert headers["Content-Range"] == f"bytes 5-9/{len(MP3)}"
        status, headers, body = _get(
            base, "/books/tarhe-kolli/lectures/session_01.mp3", "bytes=-4"
        )
        assert status == 206 and body == MP3[-4:]
        # The allowlist is the traversal guard: a dataset outside the
        # Book set, a foreign filename, and a path traversal all answer
        # the same 404.
        for path in (
            "/books/70143-336/lectures/session_01.mp3",
            "/books/tarhe-kolli/lectures/other.mp3",
            "/books/tarhe-kolli/lectures/%2E%2E%2Fsecret.mp3",
            "/books/tarhe-kolli/lectures/session_01.txt",
        ):
            status, _headers, _body = _get(base, path)
            assert status == 404, path
    finally:
        stop_gate(server, original)


def test_lecture_audio_routes_refuse_without_the_package(tmp_path, monkeypatch):
    monkeypatch.setattr(serve, "BOOKS_DIR", tmp_path)
    monkeypatch.delenv("LECTURE_AUDIO_DIR", raising=False)
    base, server, original = with_gate(tmp_path, EmptyUpstream())
    try:
        # No package configured: the mp3 route 404s while the index
        # route still serves whatever the books dir genuinely holds.
        status, _headers, _body = _get(
            base, "/books/tarhe-kolli/lectures/session_01.mp3"
        )
        assert status == 404
        status, _headers, _body = _get(base, "/books/tarhe-kolli.lectures.json")
        assert status == 404  # the tmp books dir holds no index either
    finally:
        stop_gate(server, original)


def test_the_preview_server_speaks_the_same_contract(tmp_path):
    # share.py is the LAN delivery server (the guide's own recipe): its
    # books route carries the index and its --lecture-audio-dir carries
    # the MP3s, ranged exactly like the product server's.
    from ui.mobile.share import preview_handler

    books = tmp_path / "books"
    books.mkdir()
    (books / "tarhe-kolli.lectures.json").write_text('{"format":1}', encoding="utf-8")
    audio = tmp_path / "audio"
    (audio / "tarhe-kolli").mkdir(parents=True)
    (audio / "tarhe-kolli" / "session_01.mp3").write_bytes(MP3)
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        preview_handler(books, ui_dir=REPO_ROOT / "ui", lecture_dir=audio),
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        status, _headers, body = _get(base, "/books/tarhe-kolli.lectures.json")
        assert status == 200 and body == b'{"format":1}'
        status, headers, body = _get(
            base, "/books/tarhe-kolli/lectures/session_01.mp3", "bytes=0-3"
        )
        assert status == 206 and body == MP3[:4]
        # Without the lecture dir the mp3 route stays a 404 — the
        # handler answers, it never serves what it does not have.
        bare = ThreadingHTTPServer(
            ("127.0.0.1", 0), preview_handler(books, ui_dir=REPO_ROOT / "ui")
        )
        bare_base = f"http://127.0.0.1:{bare.server_address[1]}"
        bare_thread = threading.Thread(target=bare.serve_forever, daemon=True)
        bare_thread.start()
        try:
            status, _headers, _body = _get(
                bare_base, "/books/tarhe-kolli/lectures/session_01.mp3"
            )
            assert status == 404
        finally:
            bare.shutdown()
            bare.server_close()
    finally:
        server.shutdown()
        server.server_close()


def test_the_summary_route_serves_the_players_slim_index(tmp_path, monkeypatch):
    # The 45MB alignment file is box-side only; the player's picker
    # reads THIS: one slim row per session — number, audio, duration,
    # the «بدون مقدمه» boundaries, pages — no sentences, no cues.
    books = tmp_path / "books"
    books.mkdir()
    index = {
        "format": 1,
        "book": "tarhe-kolli",
        "title": "طرح کلی",
        "page_sizes": {"41": [411.02, 595.28]},
        "sessions": [
            {
                "session": 1,
                "audio": "session_01.mp3",
                "duration": 2484.2,
                "lecture_start": 20.0,
                "lecture_end": 2472.22,
                "cover_page": 41,
                "book_pages": [41, 84],
                "sentences": [{"t": 0}],
                "cues": [{"t": 0}],
                "word_alignment": {"m": 1},
                "sentence_focus": [{"t": 0}],
            }
        ],
    }
    (books / "tarhe-kolli.lectures.json").write_text(
        json.dumps(index, ensure_ascii=False), encoding="utf-8"
    )
    monkeypatch.setattr(serve, "BOOKS_DIR", books)
    base, server, original = with_gate(tmp_path, EmptyUpstream())
    try:
        request = Request(base + "/books/tarhe-kolli.lectures.summary.json")
        with urlopen(request, timeout=10) as response:
            payload = json.loads(response.read())
        assert response.status == 200
        assert payload["title"] == "طرح کلی"
        assert len(payload["sessions"]) == 1
        row = payload["sessions"][0]
        assert row["audio"] == "session_01.mp3"
        assert row["lecture_start"] == 20.0
        assert "sentences" not in row and "cues" not in row
        # A dataset outside the Book set answers the same 404.
        try:
            urlopen(Request(base + "/books/nope.lectures.summary.json"), timeout=10)
            assert False, "foreign dataset must 404"
        except HTTPError as exc:
            assert exc.code == 404
    finally:
        stop_gate(server, original)
