"""Serve the loginless UI preview and selected Books on a local network.

This host has no account, payment, AI, or database routes. Browser-local demo
state stays on each device. The authenticated product server remains separate.
"""
from __future__ import annotations

import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

UI_DIR = Path(__file__).resolve().parents[1]
BOOK_IDS = {"tarhe-kolli", "70143-336"}
STATIC_TYPES = {".html", ".css", ".mjs", ".js", ".woff2", ".woff", ".ttf", ".svg", ".png", ".jpg"}


def preview_handler(books_dir: Path, ui_dir: Path = UI_DIR):
    books_dir, ui_dir = books_dir.resolve(), ui_dir.resolve()

    class PreviewHandler(SimpleHTTPRequestHandler):
        def do_GET(self):
            self._serve(False)

        def do_HEAD(self):
            self._serve(True)

        def _serve(self, head):
            path = unquote(urlsplit(self.path).path)
            if path in {"/", "/mobile"}:
                self.send_response(302)
                self.send_header("Location", "/mobile/?demo=1")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if path == "/mobile/":
                path = "/mobile/index.html"
            book = re.fullmatch(r"/books/([A-Za-z0-9_-]+)(/book|\.pdf|\.pages\.json)", path)
            if book and book[1] in BOOK_IDS:
                suffix = ".pages.json" if book[2] == ".pages.json" else ".pdf"
                target = books_dir / (book[1] + suffix)
                content_type = "application/json; charset=utf-8" if suffix != ".pdf" else "application/pdf"
            elif path.startswith(("/mobile/", "/book-reader/", "/vendor/")):
                target = (ui_dir / path.lstrip("/")).resolve()
                if (not target.is_relative_to(ui_dir)
                        or target.relative_to(ui_dir).parts[0] not in {"mobile", "book-reader", "vendor"}
                        or target.suffix not in STATIC_TYPES):
                    self.send_error(404)
                    return
                content_type = self.guess_type(str(target))
                if target.suffix == ".mjs":
                    content_type = "text/javascript; charset=utf-8"
            else:
                self.send_error(404)
                return
            if not target.is_file():
                self.send_error(404)
                return
            if path == "/mobile/index.html":
                payload = target.read_bytes().replace(b"</head>", b'<meta name="book-preview" content="public"></head>')
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                if not head:
                    self.wfile.write(payload)
                return
            size = target.stat().st_size
            start, end, status = 0, size - 1, 200
            byte_range = self.headers.get("Range")
            if byte_range:
                match = re.fullmatch(r"bytes=(\d*)-(\d*)", byte_range)
                if not match or not any(match.groups()):
                    self.send_error(416)
                    return
                if match[1]:
                    start = int(match[1])
                    end = min(int(match[2]), size - 1) if match[2] else size - 1
                else:
                    start = max(0, size - int(match[2]))
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-cache")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if head:
                return
            with target.open("rb") as source:
                source.seek(start)
                remaining = end - start + 1
                try:
                    while remaining:
                        chunk = source.read(min(remaining, 64 * 1024))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass

    return PreviewHandler


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--books-dir", type=Path, required=True)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), preview_handler(args.books_dir))
    print(f"Book preview http://{args.host}:{args.port}/mobile/?demo=1", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
