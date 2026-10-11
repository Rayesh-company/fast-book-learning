"""Lecture read-along: the offline box builder, the committed index, and
the /books/<id>/lectures routes (Account-gated on the sheet server,
loginless on the LAN preview)."""
import json
import shutil
import urllib.request
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.error import HTTPError

import pytest

from tests.helpers import _login_cookie, get, stop_gate, with_gate
from tools.build_lecture_index import Stream, boxes_for, build, locate, monotonic, norm_key
from ui import lectures, serve
from ui.mobile.share import preview_handler

REPO = Path(__file__).resolve().parents[1]
SAMPLE = REPO / "tests" / "fixtures" / "lectures-sample.json"
PHONE = "09120000000"


# ------------------------------------------------------------ the builder

def test_norm_key_folds_the_pdf_encoding_quirks():
    # lam-alef stored as «ال», ZWNJ vs space, tatweel, diacritics, Arabic
    # letter forms, footnote digits and the ▯ placeholder all fold away.
    assert norm_key("اسلامی") == norm_key("اسالمی")
    assert norm_key("می‌فرماید") == norm_key("می فرماید")
    assert norm_key("رهبانیـون") == norm_key("رهبانیون")
    assert norm_key("عالِم") == norm_key("عالم")
    assert norm_key("كتاب يك") == norm_key("کتاب یک")
    assert norm_key("رهبانیت1 پیشه") == norm_key("رهبانیت پیشه")
    assert norm_key("رَه ▯ ا") == norm_key("رَه ا")


def test_locate_prefers_the_occurrence_after_the_cursor_and_falls_back_to_seeds():
    stream = "الفبتثجحخدذ" + "رزژسشصضطظعغ" + "الفبتثجحخدذ"
    key = "الفبتثجحخدذ"
    assert locate(stream, key, 0, len(stream), 0) == (0, 11, "exact")
    assert locate(stream, key, 0, len(stream), 12) == (22, 33, "exact")
    # A garbled middle still lands on the right span from its seeds.
    body = "مسلمانانمحروممانداندازایمانعمیقراسخمصونمانده"
    stream = "سرصفحه" + body + "پانوشت"
    garbled = body[:15] + "XYZ" + body[18:]
    start, end, kind = locate(stream, garbled, 0, len(stream), 0, seed=8)
    assert kind == "fuzzy" and abs(start - 6) <= 2 and abs(end - (6 + len(body))) <= 2
    assert locate(stream, "چیزیکهدرصفحهنیستاصلاوابدا", 0, len(stream), 0) is None


def test_monotonic_orders_by_start_and_clips_overlaps():
    out = monotonic([
        {"id": 0, "start": 0.0, "end": 5.0},
        {"id": 2, "start": 9.0, "end": 12.0},
        {"id": 1, "start": 4.0, "end": 10.0},
    ])
    assert [s["id"] for s in out] == [0, 1, 2]
    assert [(s["start"], s["end"]) for s in out] == [(0.0, 4.0), (4.0, 9.0), (9.0, 12.0)]


class FakePage:
    """PyMuPDF's page surface the builder reads: words, dict lines, rect."""

    def __init__(self, lines, width=400.0, height=600.0):
        self.lines = lines  # [(y, size, [word, ...] right-to-left)]
        self.rect = type("R", (), {"width": width, "height": height})()

    def get_text(self, kind):
        if kind == "dict":
            return {"blocks": [{"lines": [{"bbox": [0, y, 0, y + 12], "spans": [{"size": size}]}
                                          for y, size, _ in self.lines]}]}
        words = []
        for line_no, (y, size, ws) in enumerate(self.lines):
            x1 = 380.0
            for n, w in enumerate(ws):
                words.append((x1 - 40, y, x1, y + 12, w, 0, line_no, n))
                x1 -= 45
        return words


def test_build_boxes_a_sentence_across_a_page_break_and_skips_footnotes():
    doc = [
        FakePage([(20, 10, ["سرصفحه"]), (100, 13, ["آغاز", "جمله‌ای", "که"]),
                  (130, 13, ["ادامه", "دارد"]), (500, 10, ["پانوشت", "کوچک"])]),
        FakePage([(100, 13, ["تا", "صفحهٔ", "بعد."]), (130, 13, ["جملهٔ", "دوم", "اینجاست."])]),
    ]
    alignment = {"title": "t", "sessions": [{
        "session": 1, "audio_mp3": "session_01.mp3", "audio_duration_s": 60,
        "lecture_start_s": 2, "lecture_end_s": 58, "book_pages": [1, 2],
        "sentences": [
            {"id": 0, "text": "آغاز جمله‌ای که ادامه دارد تا صفحهٔ بعد.", "page": 1, "page_end": 2,
             "start": 2.0, "end": 9.0, "confidence": 0.9, "flags": []},
            {"id": 1, "text": "جملهٔ دوم اینجاست.", "page": 2, "page_end": 2,
             "start": 8.5, "end": 12.0, "confidence": 0.8, "flags": ["low_confidence"]},
            {"id": 2, "text": "سخنی که در کتاب نیست و هرگز پیدا نمی‌شود.", "page": 2, "page_end": 2,
             "start": 13.0, "end": 15.0, "confidence": 0.1, "flags": ["interpolated"]},
        ]}]}
    index, stats = build(alignment, doc, "tarhe-kolli")
    first, second, third = index["sessions"][0]["sentences"]
    assert [b[0] for b in first["boxes"]] == [1, 1, 2]      # two lines on p1, one on p2
    assert all(b[2] < 400 for b in first["boxes"])          # never the footnote zone
    assert second["boxes"] == [[2, 250.0, 130.0, 380.0, 142.0]]
    assert first["end"] == 8.5                                # overlap clipped
    assert "boxes" not in third
    assert stats == {"sentences": 3, "boxed": 2, "exact": 2, "fuzzy": 0}
    assert index["page_sizes"] == {"1": [400.0, 600.0], "2": [400.0, 600.0]}


def test_the_committed_index_is_monotonic_and_boxed():
    index = json.loads((REPO / "books" / "tarhe-kolli.lectures.json").read_text(encoding="utf-8"))
    assert index["format"] == 1 and len(index["sessions"]) == 28
    total = boxed = 0
    for session in index["sessions"]:
        starts = [s["start"] for s in session["sentences"]]
        assert starts == sorted(starts)
        for a, b in zip(session["sentences"], session["sentences"][1:]):
            assert a["end"] <= b["start"] + 1e-9
        for s in session["sentences"]:
            total += 1
            boxed += bool(s.get("boxes"))
            for page, x0, y0, x1, y1 in s.get("boxes", []):
                width, height = index["page_sizes"][str(page)]
                assert 0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height
    assert boxed / total > 0.99


# ------------------------------------------------------------ the routes

@pytest.fixture
def lecture_books(tmp_path, monkeypatch):
    books = tmp_path / "books"
    books.mkdir()
    shutil.copy(SAMPLE, books / "tarhe-kolli.lectures.json")
    audio = books / "tarhe-kolli" / "lectures"  # the in-repo default layout
    audio.mkdir(parents=True)
    (audio / "session_01.m4a").write_bytes(bytes(range(256)) * 4)
    monkeypatch.setattr(serve, "BOOKS_DIR", books)
    monkeypatch.delenv("LECTURE_AUDIO_DIR", raising=False)
    monkeypatch.delenv("LECTURE_AUDIO_BASE_URL", raising=False)
    return books


def fetch(base, path, headers=None):
    request = urllib.request.Request(base + path, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, dict(response.headers), response.read()
    except HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def test_lecture_routes_serve_timings_boxes_and_ranged_audio_to_an_account(tmp_path, lecture_books):
    base, server, originals = with_gate(tmp_path, None)
    try:
        assert get(base, "/books/tarhe-kolli/lectures")[0] == 401
        assert fetch(base, "/books/tarhe-kolli/lectures/1/audio")[0] == 401
        status, listing = get(base, "/books/tarhe-kolli/lectures", phone=PHONE)
        assert status == 200
        assert [(s["session"], s["audio_available"]) for s in listing["sessions"]] == [(1, True), (2, False)]
        status, session = get(base, "/books/tarhe-kolli/lectures/1", phone=PHONE)
        assert status == 200
        assert session["audio_url"] == "/books/tarhe-kolli/lectures/1/audio"
        assert session["lecture_start"] == 20.0 and len(session["sentences"]) == 5
        assert session["sentences"][1]["boxes"][0][0] == 42
        assert set(session["page_sizes"]) == {str(b[0]) for s in session["sentences"] for b in s.get("boxes", [])}
        cookie = {"Cookie": _login_cookie(base, PHONE)}
        status, headers, body = fetch(base, "/books/tarhe-kolli/lectures/1/audio", {**cookie, "Range": "bytes=10-19"})
        assert status == 206 and body == bytes(range(10, 20))
        assert headers["Content-Range"] == "bytes 10-19/1024" and headers["Content-Type"] == "audio/mp4"
        status, headers, body = fetch(base, "/books/tarhe-kolli/lectures/1/audio", cookie)
        assert status == 200 and len(body) == 1024 and headers["Accept-Ranges"] == "bytes"
        assert fetch(base, "/books/tarhe-kolli/lectures/1/audio", {**cookie, "Range": "bytes=5000-"})[0] == 416
        status, session2 = get(base, "/books/tarhe-kolli/lectures/2", phone=PHONE)
        assert status == 200 and session2["audio_url"] is None
        assert get(base, "/books/tarhe-kolli/lectures/2/audio", phone=PHONE)[0] == 404
        assert get(base, "/books/tarhe-kolli/lectures/9", phone=PHONE)[0] == 404
        assert get(base, "/books/unknown/lectures", phone=PHONE)[0] == 404
        assert get(base, "/books/70143-336/lectures", phone=PHONE)[0] == 404  # no index for that Book
    finally:
        stop_gate(server, originals)


def test_lecture_audio_dir_overrides_the_in_repo_files(lecture_books, tmp_path, monkeypatch):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "session_02.m4a").write_bytes(b"\0\0\0\x20ftypM4A ")
    assert lectures.audio_file(lecture_books, "tarhe-kolli", 1).parent == lecture_books / "tarhe-kolli" / "lectures"
    assert lectures.audio_file(lecture_books, "tarhe-kolli", 2) is None
    monkeypatch.setenv("LECTURE_AUDIO_DIR", str(elsewhere))
    assert lectures.audio_file(lecture_books, "tarhe-kolli", 2) == elsewhere / "session_02.m4a"
    assert lectures.audio_file(lecture_books, "tarhe-kolli", 1) is None  # the override is the only source
    assert lectures.audio_url(lecture_books, "tarhe-kolli", 2) == "/books/tarhe-kolli/lectures/2/audio"


def test_audio_can_come_from_a_cdn_and_never_from_a_request_path(lecture_books, monkeypatch):
    monkeypatch.setenv("LECTURE_AUDIO_BASE_URL", "https://cdn.example/lectures/{book}/")
    session = lectures.lecture_session(lecture_books, "tarhe-kolli", 2)
    assert session["audio_url"] == "https://cdn.example/lectures/tarhe-kolli/session_02.m4a"
    index = lectures.load_index(lecture_books, "tarhe-kolli")
    index["sessions"][0]["audio"] = "../../etc/passwd"
    assert lectures.audio_file(lecture_books, "tarhe-kolli", 1) is None
    lectures._CACHE.clear()


def test_parse_range():
    assert lectures.parse_range(None, 100) is None
    assert lectures.parse_range("bytes=0-9", 100) == (0, 9)
    assert lectures.parse_range("bytes=90-", 100) == (90, 99)
    assert lectures.parse_range("bytes=-10", 100) == (90, 99)
    assert lectures.parse_range("bytes=95-500", 100) == (95, 99)
    assert lectures.parse_range("bytes=100-", 100) is False
    assert lectures.parse_range("items=1-2", 100) is None


def test_the_lan_preview_serves_lectures_without_an_account(lecture_books):
    server = ThreadingHTTPServer(("127.0.0.1", 0), preview_handler(lecture_books))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        status, _, body = fetch(base, "/books/tarhe-kolli/lectures/1")
        assert status == 200 and json.loads(body)["sentences"][0]["page"] == 42
        status, _, body = fetch(base, "/books/tarhe-kolli/lectures/1/audio", {"Range": "bytes=0-3"})
        assert status == 206 and body == bytes(range(4))
        assert fetch(base, "/books/unknown/lectures")[0] == 404
    finally:
        server.shutdown(); server.server_close(); thread.join()


def test_the_image_and_compose_carry_the_lecture_module_and_the_books_mount_carries_audio():
    assert "lectures.py" in (REPO / "ui" / "Dockerfile").read_text(encoding="utf-8")
    compose = (REPO / "compose.yaml").read_text(encoding="utf-8")
    assert "- ./books:/books:ro" in compose  # PDF, indexes and books/<id>/lectures/*.m4a
    assert "LECTURE_AUDIO_DIR: ${LECTURE_AUDIO_DIR:-}" in compose
    assert "LECTURE_AUDIO_BASE_URL: ${LECTURE_AUDIO_BASE_URL:-}" in compose
    ignored = (REPO / ".gitignore").read_text(encoding="utf-8")
    assert "!books/tarhe-kolli.pdf" in ignored and "*.flac" in ignored and "*.mp3" in ignored and "*.m4a" not in ignored


def test_the_committed_assets_are_the_ones_the_index_was_built_from():
    """The PDF the reader serves is byte-for-byte the one the page boxes
    were computed from, and every session's audio (AAC .m4a) ships beside the index."""
    import hashlib
    index = json.loads((REPO / "books" / "tarhe-kolli.lectures.json").read_text(encoding="utf-8"))
    pdf = REPO / "books" / "tarhe-kolli.pdf"
    assert hashlib.sha256(pdf.read_bytes()).hexdigest() == index["source"]["boxes_pdf_sha256"]
    for session in index["sessions"]:
        audio = REPO / "books" / "tarhe-kolli" / "lectures" / session["audio"]
        assert audio.is_file(), audio
        assert 0 < audio.stat().st_size < 100 * 1024 * 1024  # GitHub's per-file ceiling
        assert lectures.audio_file(REPO / "books", "tarhe-kolli", session["session"]) == audio or \
            lectures._audio_dir() is not None
