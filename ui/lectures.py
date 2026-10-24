"""Lecture read-along: recorded lecture audio per session (جلسه) synced
to the Book's sentences, highlighted on the rendered PDF page.

Data: ``<books dir>/<dataset>.lectures.json`` built offline by
``tools/build_lecture_index.py`` from an audio alignment. Each sentence
carries its ``start``/``end`` seconds in the session's audio and its line
``boxes`` ([page, x0, y0, x1, y1], PDF points) on the PDF pages.

The session audio is committed beside the index, at
``<books dir>/<dataset>/lectures/<file>`` (the 32 kbps mono .mp3 files), and served
with HTTP Range. Optional overrides: ``LECTURE_AUDIO_DIR`` (another local
folder) or ``LECTURE_AUDIO_BASE_URL`` (a CDN/object store the browser
fetches from directly; never touched here).
Stdlib-only, like the rest of the server.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

_CACHE: dict[Path, tuple[int, dict]] = {}
AUDIO_TYPES = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
               ".opus": "audio/ogg", ".flac": "audio/flac", ".wav": "audio/wav"}
_SAFE_FILE = re.compile(r"[A-Za-z0-9_.-]+")


def index_path(books_dir: Path, dataset: str) -> Path:
    return Path(books_dir) / f"{dataset}.lectures.json"


def load_index(books_dir: Path, dataset: str) -> dict | None:
    """The Book's lecture index, re-read only when the file changes."""
    path = index_path(books_dir, dataset)
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        return None
    cached = _CACHE.get(path)
    if cached and cached[0] == mtime:
        return cached[1]
    data = json.loads(path.read_text(encoding="utf-8"))
    _CACHE[path] = (mtime, data)
    return data


def _audio_dir() -> Path | None:
    value = os.environ.get("LECTURE_AUDIO_DIR", "").strip()
    return Path(value) if value else None


def audio_file(books_dir: Path, dataset: str, session: int) -> Path | None:
    """The session's local audio file. ``$LECTURE_AUDIO_DIR/<dataset>/<file>``
    or ``$LECTURE_AUDIO_DIR/<file>`` when that override is set, otherwise
    the in-repo ``<books dir>/<dataset>/lectures/<file>``. The file name
    comes from the committed index, never from the request."""
    record = find_session(load_index(books_dir, dataset), session)
    name = (record or {}).get("audio") or ""
    if not record or not _SAFE_FILE.fullmatch(name) or name in {".", ".."}:
        return None
    root = _audio_dir()
    candidates = ((root / dataset / name, root / name) if root is not None
                  else (Path(books_dir) / dataset / "lectures" / name,))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def find_session(index: dict | None, session: int) -> dict | None:
    for record in (index or {}).get("sessions", []):
        if record.get("session") == session:
            return record
    return None


def audio_url(books_dir: Path, dataset: str, session: int) -> str | None:
    record = find_session(load_index(books_dir, dataset), session)
    if not record or not record.get("audio"):
        return None
    base = os.environ.get("LECTURE_AUDIO_BASE_URL", "").strip()
    if base:
        if "{book}" in base:
            return base.replace("{book}", dataset).rstrip("/") + "/" + record["audio"]
        return f"{base.rstrip('/')}/{dataset}/{record['audio']}"
    if audio_file(books_dir, dataset, session) is None:
        return None
    return f"/books/{dataset}/lectures/{session}/audio"


def lecture_list(books_dir: Path, dataset: str) -> dict | None:
    """Session summaries for the picker (no sentence bodies)."""
    index = load_index(books_dir, dataset)
    if index is None:
        return None
    sessions = []
    for record in index.get("sessions", []):
        number = record["session"]
        sessions.append({
            "session": number,
            "duration": record.get("duration"),
            "lecture_start": record.get("lecture_start", 0),
            "lecture_end": record.get("lecture_end"),
            "book_pages": record.get("book_pages"),
            "cover_page": record.get("cover_page"),
            "coverage": record.get("coverage"),
            "sentences": len(record.get("sentences", [])),
            "audio_available": audio_url(books_dir, dataset, number) is not None,
            "audio_url": audio_url(books_dir, dataset, number),
        })
    return {"book": dataset, "title": index.get("title"), "sessions": sessions}


def lecture_session(books_dir: Path, dataset: str, session: int) -> dict | None:
    """One session: timings, flags and page boxes, plus where its audio is."""
    index = load_index(books_dir, dataset)
    record = find_session(index, session)
    if record is None:
        return None
    pages = {str(b[0]) for s in record.get("sentences", []) for b in s.get("boxes", [])}
    sizes = index.get("page_sizes", {})
    url = audio_url(books_dir, dataset, session)
    payload = {
        "book": dataset,
        "session": session,
        "duration": record.get("duration"),
        "lecture_start": record.get("lecture_start", 0),
        "lecture_end": record.get("lecture_end"),
        "book_pages": record.get("book_pages"),
        "cover_page": record.get("cover_page"),
        "coverage": record.get("coverage"),
        "audio_available": url is not None,
        "audio_url": url,
        "page_sizes": {page: sizes[page] for page in sorted(pages, key=int) if page in sizes},
        "sentences": record.get("sentences", []),
    }
    if "cues" in record:
        payload["cues"] = record["cues"]
    if "word_alignment" in record:
        payload["word_alignment"] = record["word_alignment"]
    if "sentence_focus" in record:
        payload["sentence_focus"] = record["sentence_focus"]
    return payload


def parse_range(header: str | None, size: int) -> tuple[int, int] | None | bool:
    """``bytes=a-b`` → (start, end) inclusive; None for no/ignored range;
    False when the range cannot be satisfied (answer 416)."""
    if not header:
        return None
    match = re.fullmatch(r"\s*bytes=(\d*)-(\d*)\s*", header)
    if not match or not any(match.groups()):
        return None
    if match[1]:
        start = int(match[1])
        end = min(int(match[2]), size - 1) if match[2] else size - 1
    else:
        start, end = max(0, size - int(match[2])), size - 1
    if start >= size or start > end:
        return False
    return start, end


def send_file(handler, path: Path, content_type: str, head: bool = False) -> None:
    """Stream a file over a BaseHTTPRequestHandler with Range support
    (the <audio> element seeks with byte ranges)."""
    size = path.stat().st_size
    wanted = parse_range(handler.headers.get("Range"), size)
    if wanted is False:
        handler.send_response(416)
        handler.send_header("Content-Range", f"bytes */{size}")
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return
    start, end = wanted or (0, size - 1)
    handler.send_response(206 if wanted else 200)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(end - start + 1))
    handler.send_header("Accept-Ranges", "bytes")
    if wanted:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    handler.end_headers()
    if head:
        return
    try:
        with path.open("rb") as source:
            source.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = source.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                handler.wfile.write(chunk)
                remaining -= len(chunk)
    except (BrokenPipeError, ConnectionResetError):
        pass


ROUTE = re.compile(r"/books/([A-Za-z0-9_-]+)/lectures(?:/(\d{1,3})(/audio)?)?")


def handle(handler, path: str, books_dir: Path, allowed: set[str] | list[str],
           head: bool = False) -> bool:
    """Answer a lecture route; False when ``path`` is not one. The caller
    applies its own identity gate first."""
    match = ROUTE.fullmatch(path)
    if not match:
        return False
    dataset, number, audio = match.group(1), match.group(2), match.group(3)
    def not_found(message: str) -> bool:
        body = json.dumps({"detail": message}, ensure_ascii=False).encode()
        handler.send_response(404)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        if not head:
            handler.wfile.write(body)
        return True
    if dataset not in allowed:
        return not_found("کتاب پیدا نشد.")
    if audio:
        file = audio_file(books_dir, dataset, int(number))
        if file is None:
            return not_found("صوت این جلسه روی سرور نیست.")
        send_file(handler, file, AUDIO_TYPES.get(file.suffix.lower(), "application/octet-stream"), head)
        return True
    payload = (lecture_session(books_dir, dataset, int(number)) if number
               else lecture_list(books_dir, dataset))
    if payload is None:
        return not_found("برای این کتاب درس‌گفتار ثبت نشده است.")
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    if not head:
        handler.wfile.write(body)
    return True


# --- Compatibility helpers for fast-book-audio-delivery / legacy test suite ---

def resolve_session_audio_file(
    books_dir: Path,
    book_id: str,
    audio_filename: str,
    lecture_audio_dir: Path | str | None = None,
) -> Path | None:
    """Find the audio file on disk according to precedence rules."""
    if not audio_filename:
        return None

    ext_dir = lecture_audio_dir or os.environ.get("LECTURE_AUDIO_DIR")
    if ext_dir:
        ext_path = Path(ext_dir)
        cand1 = ext_path / book_id / audio_filename
        if cand1.is_file():
            return cand1
        cand2 = ext_path / audio_filename
        if cand2.is_file():
            return cand2
        return None

    cand1 = Path(books_dir) / book_id / "lectures" / audio_filename
    if cand1.is_file():
        return cand1
    cand2 = Path(books_dir) / book_id / audio_filename
    if cand2.is_file():
        return cand2
    return None


def resolve_audio_url(
    book_id: str,
    session_num: int,
    audio_filename: str,
    base_url: str | None = None,
) -> str:
    """Return the audio URL for a session."""
    effective_base = base_url or os.environ.get("LECTURE_AUDIO_BASE_URL", "").strip()
    if effective_base:
        return f"{effective_base.rstrip('/')}/{book_id}/{audio_filename}"
    return f"/books/{book_id}/lectures/{session_num}/audio"


def load_lectures_summary(
    books_dir: Path,
    book_id: str,
    lecture_audio_dir: Path | str | None = None,
    base_url: str | None = None,
) -> list[dict[str, Any]] | None:
    """Lightweight summary list of sessions."""
    data = load_index(books_dir, book_id)
    if data is None:
        return None

    effective_base = base_url or os.environ.get("LECTURE_AUDIO_BASE_URL", "").strip()
    summary: list[dict[str, Any]] = []
    for s in data.get("sessions", []):
        audio_name = s.get("audio", "")
        session_num = s.get("session", 0)
        file = resolve_session_audio_file(books_dir, book_id, audio_name, lecture_audio_dir)
        avail = bool(effective_base) or (file is not None and file.is_file())
        url = resolve_audio_url(book_id, session_num, audio_name, effective_base)

        item = {k: v for k, v in s.items() if k not in ("cues", "sentences", "sentence_focus", "word_alignment")}
        item["audio_available"] = avail
        item["audio_url"] = url
        summary.append(item)
    return summary


def get_session_data(
    books_dir: Path,
    book_id: str,
    session_num: int,
    lecture_audio_dir: Path | str | None = None,
    base_url: str | None = None,
) -> dict[str, Any] | None:
    """Session full data."""
    data = load_index(books_dir, book_id)
    if data is None:
        return None

    target = find_session(data, session_num)
    if target is None:
        return None

    effective_base = base_url or os.environ.get("LECTURE_AUDIO_BASE_URL", "").strip()
    audio_name = target.get("audio", "")
    file = resolve_session_audio_file(books_dir, book_id, audio_name, lecture_audio_dir)
    avail = bool(effective_base) or (file is not None and file.is_file())
    url = resolve_audio_url(book_id, session_num, audio_name, effective_base)

    session_copy = dict(target)
    session_copy["audio_available"] = avail
    session_copy["audio_url"] = url
    return session_copy


def get_session_audio_file(
    books_dir: Path,
    book_id: str,
    session_num: int,
    lecture_audio_dir: Path | str | None = None,
) -> Path | None:
    """Audio file path for a session number."""
    data = load_index(books_dir, book_id)
    if data is None:
        return None
    session_rec = find_session(data, session_num)
    if session_rec:
        audio_name = session_rec.get("audio", "")
        return resolve_session_audio_file(books_dir, book_id, audio_name, lecture_audio_dir)
    return None


def stream_audio_range(handler: Any, target_file: Path, head: bool = False) -> None:
    """Stream an MP3 file with HTTP Range support."""
    if not target_file.is_file():
        handler.send_error(404)
        return
    send_file(handler, target_file, "audio/mpeg", head=head)
