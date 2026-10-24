"""The static delivery law (the 2026-10-23 Lighthouse work): the UI's
text assets gzip down the wire and revalidate with ETag + 304, and the
mobile page carries the modulepreload set so the browser learns the
whole module graph at HTML parse — the recorded waterfall paid the
path's ~1.2s latency five times over, once per discovery wave. These
tests guard the three behaviors a regression would silently give back:
compression, revalidation, and the injected preloads."""

import gzip
import urllib.request

from tests.helpers import stop_gate, with_gate


def _get(base, path, headers=None):
    request = urllib.request.Request(base + path, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.request.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def _ok_upstream(url, *args, **kwargs):  # statics never proxy; a canary
    raise AssertionError(f"static request must not proxy: {url}")


def test_text_assets_gzip_and_revalidate(tmp_path):
    base, server, originals = with_gate(tmp_path, _ok_upstream)
    try:
        status, headers, body = _get(
            base,
            "/mobile/app-ui.mjs",
            {"Accept-Encoding": "gzip"},
        )
        assert status == 200
        assert headers["Content-Encoding"] == "gzip"
        assert headers["Vary"] == "Accept-Encoding"
        assert headers["Cache-Control"] == "public, max-age=0, must-revalidate"
        assert gzip.decompress(body).startswith(b"import")
        etag = headers["ETag"]
        assert etag

        status, headers, body = _get(
            base, "/mobile/app-ui.mjs", {"If-None-Match": etag}
        )
        assert status == 304
        assert body == b""
        assert headers["ETag"] == etag
    finally:
        stop_gate(server, originals)


def test_uncompressed_client_gets_plain_bytes(tmp_path):
    base, server, originals = with_gate(tmp_path, _ok_upstream)
    try:
        status, headers, body = _get(base, "/mobile/styles.css")
        assert status == 200
        assert "Content-Encoding" not in headers
        assert b"@font-face" in body
        # Fonts ride the ETag pair too but never gzip (already woff2).
        status, headers, _ = _get(base, "/vendor/fonts/Vazirmatn-Regular.woff2")
        assert status == 200
        assert "Content-Encoding" not in headers
        assert headers["ETag"]
    finally:
        stop_gate(server, originals)


def test_mobile_page_preloads_the_module_graph_and_revalidates(tmp_path):
    base, server, originals = with_gate(tmp_path, _ok_upstream)
    try:
        status, headers, body = _get(base, "/mobile/")
        assert status == 200
        page = body.decode("utf-8")
        # The app's static import closure is injected — the deep links
        # the waterfall proved the browser cannot discover on its own.
        assert '<link rel="modulepreload" href="/mobile/app-ui.mjs">' in page
        assert '<link rel="modulepreload" href="/mobile/views.mjs">' in page
        assert '<link rel="modulepreload" href="/book-reader/index.mjs">' in page
        # The PDF engine stays OFF the preload set: it loads only when
        # a reader opens (dynamic import), never on the anonymous boot.
        assert "/vendor/pdf.min.mjs" not in page
        # The page's own stylesheets ride the document (2026-10-24
        # pass: first paint waits on ONE request, not six) — the files
        # stay the source of truth, only the wire shape inlines.
        assert 'rel="stylesheet"' not in page
        assert page.count("<style>") == 6
        assert "@font-face" in page  # styles.css really is one of them
        etag = headers["ETag"]
        status, _, body = _get(base, "/mobile/", {"If-None-Match": etag})
        assert status == 304
        assert body == b""
    finally:
        stop_gate(server, originals)


def test_mobile_page_gzips_when_accepted(tmp_path):
    base, server, originals = with_gate(tmp_path, _ok_upstream)
    try:
        status, headers, body = _get(
            base, "/mobile/", {"Accept-Encoding": "gzip"}
        )
        assert status == 200
        assert headers["Content-Encoding"] == "gzip"
        assert headers["Vary"] == "Accept-Encoding"
        page = gzip.decompress(body).decode("utf-8")
        assert "<style>" in page  # the inlined payload arrives whole
    finally:
        stop_gate(server, originals)
