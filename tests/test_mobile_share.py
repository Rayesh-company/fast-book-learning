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
