"""The network preview is loginless and serves only its UI and Book assets."""
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from ui.mobile.share import preview_handler


@contextmanager
def preview(tmp_path):
    ui = tmp_path / "ui"
    (ui / "mobile").mkdir(parents=True)
    (ui / "mobile" / "index.html").write_text("<html><head></head><body>Preview</body></html>")
    (ui / "index.html").write_text("private legacy UI")
    (ui / "mobile" / "app.mjs").write_text("export const demo = true;")
    (ui / "mobile" / "private.sqlite3").write_text("secret")
    books = tmp_path / "books"
    books.mkdir()
    (books / "tarhe-kolli.pdf").write_bytes(b"%PDF-1.7 abcdefghijk")
    (books / "tarhe-kolli.pages.json").write_text('{"1":"text"}')
    manifest = {
        "format": "v1", "book": "tarhe-kolli", "title": "طرح کلی",
        "sessions": [
            {
                "session": 1, "audio": "session_01.mp3", "duration": 2400.0,
                "lecture_start": 20.0, "lecture_end": 2380.0, "book_pages": [42, 58],
                "cues": [{"start": 20.0, "end": 25.0, "text": "sample", "page": 42}],
            }
        ]
    }
    (books / "tarhe-kolli.lectures.json").write_text(__import__("json").dumps(manifest), encoding="utf-8")
    lec_dir = books / "tarhe-kolli" / "lectures"
    lec_dir.mkdir(parents=True)
    (lec_dir / "session_01.mp3").write_bytes(b"A" * 2048)
    (tmp_path / ".env").write_text("secret")
    server = ThreadingHTTPServer(("127.0.0.1", 0), preview_handler(books, ui))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_preview_and_book_open_without_account(tmp_path):
    with preview(tmp_path) as base:
        with urlopen(base + "/") as response:
            assert response.geturl().endswith("/mobile/?demo=1")
            assert b'name="book-preview"' in response.read()
        with urlopen(base + "/mobile/app.mjs") as response:
            assert response.headers["Content-Type"].startswith("text/javascript")
        with urlopen(Request(base + "/books/tarhe-kolli/book", headers={"Range": "bytes=0-4"})) as response:
            assert response.status == 206
            assert response.read() == b"%PDF-"
            assert response.headers["Content-Range"].startswith("bytes 0-4/")
        with urlopen(Request(base + "/books/tarhe-kolli/book", method="HEAD")) as response:
            assert int(response.headers["Content-Length"]) > 4
            assert not response.read()
        with urlopen(base + "/books/tarhe-kolli.pages.json") as response:
            assert b"text" in response.read()


@pytest.mark.parametrize("path", ["/auth/me", "/notes", "/sessions", "/.env", "/mobile/../../.env", "/mobile/%2e%2e/%2e%2e/.env", "/mobile/private.sqlite3", "/mobile/subdirectory/", "/mobile/../index.html", "/books/private/book"])
def test_preview_never_exposes_account_routes_or_private_files(tmp_path, path):
    with preview(tmp_path) as base:
        with pytest.raises(HTTPError) as error:
            urlopen(base + path)
        assert error.value.code == 404


def test_preview_rejects_invalid_book_range_and_writes(tmp_path):
    with preview(tmp_path) as base:
        with pytest.raises(HTTPError) as error:
            urlopen(Request(base + "/books/tarhe-kolli/book", headers={"Range": "bytes=999-"}))
        assert error.value.code == 416
        with pytest.raises(HTTPError) as error:
            urlopen(Request(base + "/auth/login", data=b"{}", method="POST"))
        assert error.value.code == 501


def test_preview_serves_lectures_manifest_session_and_range_audio(tmp_path):
    import json
    with preview(tmp_path) as base:
        # 1. GET /books/tarhe-kolli/lectures
        with urlopen(base + "/books/tarhe-kolli/lectures") as response:
            assert response.status == 200
            assert response.headers["Content-Type"].startswith("application/json")
            data = json.loads(response.read().decode())
            sessions = data["sessions"] if isinstance(data, dict) else data
            assert len(sessions) == 1
            assert sessions[0]["session"] == 1
            assert sessions[0]["audio_available"] is True
            assert sessions[0]["audio_url"] == "/books/tarhe-kolli/lectures/1/audio"

        # 2. GET /books/tarhe-kolli/lectures/1
        with urlopen(base + "/books/tarhe-kolli/lectures/1") as response:
            assert response.status == 200
            s1 = json.loads(response.read().decode())
            assert s1["session"] == 1
            assert s1["audio_available"] is True
            assert s1["audio_url"] == "/books/tarhe-kolli/lectures/1/audio"
            assert len(s1["cues"]) == 1
            assert s1["cues"][0]["text"] == "sample"

        # 3. GET /books/tarhe-kolli/lectures/1/audio with Range
        req = Request(base + "/books/tarhe-kolli/lectures/1/audio", headers={"Range": "bytes=0-1023"})
        with urlopen(req) as response:
            assert response.status == 206
            assert response.headers["Content-Type"] == "audio/mpeg"
            assert response.headers["Content-Length"] == "1024"
            assert response.headers["Content-Range"] == "bytes 0-1023/2048"
            content = response.read()
            assert len(content) == 1024

        # 4. HEAD request
        head_req = Request(base + "/books/tarhe-kolli/lectures/1/audio", method="HEAD")
        with urlopen(head_req) as response:
            assert response.status == 200
            assert response.headers["Content-Type"] == "audio/mpeg"
            assert int(response.headers["Content-Length"]) == 2048
            assert not response.read()

        # 5. Invalid range
        with pytest.raises(HTTPError) as error:
            urlopen(Request(base + "/books/tarhe-kolli/lectures/1/audio", headers={"Range": "bytes=99999-"}))
        assert error.value.code == 416

        # 6. Missing session or unknown book
        with pytest.raises(HTTPError) as error:
            urlopen(base + "/books/tarhe-kolli/lectures/99")
        assert error.value.code == 404
        with pytest.raises(HTTPError) as error:
            urlopen(base + "/books/unknown-book/lectures")
        assert error.value.code == 404


def test_preview_lecture_external_dir_and_base_url(tmp_path, monkeypatch):
    import json
    ui = tmp_path / "ui"
    (ui / "mobile").mkdir(parents=True)
    (ui / "mobile" / "index.html").write_text("<html></html>")
    (ui / "mobile" / "app.mjs").write_text("export const demo = true;")
    books = tmp_path / "books"
    books.mkdir()
    (books / "tarhe-kolli.pdf").write_bytes(b"%PDF-1.7")
    manifest = {
        "format": "v1", "book": "tarhe-kolli",
        "sessions": [{"session": 1, "audio": "session_01.mp3", "duration": 100.0, "cues": []}]
    }
    (books / "tarhe-kolli.lectures.json").write_text(json.dumps(manifest), encoding="utf-8")

    # External audio dir: tarhe-kolli/session_01.mp3
    ext_dir = tmp_path / "custom_audio"
    (ext_dir / "tarhe-kolli").mkdir(parents=True)
    (ext_dir / "tarhe-kolli" / "session_01.mp3").write_bytes(b"EXT_AUDIO" * 50)

    server = ThreadingHTTPServer(("127.0.0.1", 0), preview_handler(books, ui, lecture_audio_dir=ext_dir))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_port}"
        with urlopen(base + "/books/tarhe-kolli/lectures") as response:
            data = json.loads(response.read().decode())
            sessions = data["sessions"] if isinstance(data, dict) else data
            assert sessions[0]["audio_available"] is True
        with urlopen(base + "/books/tarhe-kolli/lectures/1/audio") as response:
            assert response.status == 200
            assert response.read() == b"EXT_AUDIO" * 50
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

    # Now test with LECTURE_AUDIO_BASE_URL
    monkeypatch.setenv("LECTURE_AUDIO_BASE_URL", "https://cdn.example.com/audio")
    server2 = ThreadingHTTPServer(("127.0.0.1", 0), preview_handler(books, ui))
    thread2 = Thread(target=server2.serve_forever, daemon=True)
    thread2.start()
    try:
        base2 = f"http://127.0.0.1:{server2.server_port}"
        with urlopen(base2 + "/books/tarhe-kolli/lectures") as response:
            data = json.loads(response.read().decode())
            sessions = data["sessions"] if isinstance(data, dict) else data
            assert sessions[0]["audio_available"] is True
            assert sessions[0]["audio_url"] == "https://cdn.example.com/audio/tarhe-kolli/session_01.mp3"
    finally:
        server2.shutdown()
        server2.server_close()
        thread2.join()

