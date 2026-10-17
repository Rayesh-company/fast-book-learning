"""Lecture audio and timing service for fast-book-learning.

Provides manifest loading, session timing retrieval, audio path resolution,
and HTTP Range-enabled streaming for book lecture recordings (e.g. tarhe-kolli).
Follows specifications in fast-book-audio-delivery/README.fa.md.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
from typing import Any

# Cache for loaded lectures JSON parsed data: path -> (mtime, data)
_MANIFEST_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}


def resolve_session_audio_file(
    books_dir: Path,
    book_id: str,
    audio_filename: str,
    lecture_audio_dir: Path | str | None = None,
) -> Path | None:
    """Find the audio file on disk according to precedence rules in README.fa.md.

    If lecture_audio_dir is specified (via argument or LECTURE_AUDIO_DIR env),
    the server searches ONLY that directory:
      1. <lecture_audio_dir>/<book_id>/<audio_filename>
      2. <lecture_audio_dir>/<audio_filename>
    It never falls back to the project's internal books directory when this setting is active.

    If lecture_audio_dir is not set:
      1. <books_dir>/<book_id>/lectures/<audio_filename>
      2. <books_dir>/<book_id>/<audio_filename>
    """
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

    cand1 = books_dir / book_id / "lectures" / audio_filename
    if cand1.is_file():
        return cand1
    cand2 = books_dir / book_id / audio_filename
    if cand2.is_file():
        return cand2
    return None


def resolve_audio_url(
    book_id: str,
    session_num: int,
    audio_filename: str,
    base_url: str | None = None,
) -> str:
    """Return the audio URL for a session.

    If LECTURE_AUDIO_BASE_URL (or base_url parameter) is set, it overrides
    the local server path.
    Otherwise, defaults to /books/<book_id>/lectures/<session_num>/audio.
    """
    effective_base = base_url or os.environ.get("LECTURE_AUDIO_BASE_URL", "").strip()
    if effective_base:
        return f"{effective_base.rstrip('/')}/{book_id}/{audio_filename}"
    return f"/books/{book_id}/lectures/{session_num}/audio"


def _read_manifest_data(books_dir: Path, book_id: str) -> dict[str, Any] | None:
    manifest_path = books_dir / f"{book_id}.lectures.json"
    if not manifest_path.is_file():
        return None
    try:
        mtime = manifest_path.stat().st_mtime
        cached = _MANIFEST_CACHE.get(str(manifest_path))
        if cached and cached[0] == mtime:
            return cached[1]
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        _MANIFEST_CACHE[str(manifest_path)] = (mtime, data)
        return data
    except (OSError, json.JSONDecodeError):
        return None


def load_lectures_summary(
    books_dir: Path,
    book_id: str,
    lecture_audio_dir: Path | str | None = None,
    base_url: str | None = None,
) -> list[dict[str, Any]] | None:
    """Load lightweight summary list of all sessions for GET /books/<id>/lectures.

    Omits heavy word-level cues and sentence arrays to keep response under ~6 KB.
    Injects audio_available and audio_url dynamically.
    """
    data = _read_manifest_data(books_dir, book_id)
    if data is None:
        return None

    effective_base = base_url or os.environ.get("LECTURE_AUDIO_BASE_URL", "").strip()
    summary: list[dict[str, Any]] = []
    for s in data.get("sessions", []):
        audio_name = s.get("audio", "")
        session_num = s.get("session", 0)
        audio_file = resolve_session_audio_file(books_dir, book_id, audio_name, lecture_audio_dir)
        audio_available = bool(effective_base) or (audio_file is not None and audio_file.is_file())
        audio_url = resolve_audio_url(book_id, session_num, audio_name, effective_base)

        item = {k: v for k, v in s.items() if k not in ("cues", "sentences", "sentence_focus", "word_alignment")}
        item["audio_available"] = audio_available
        item["audio_url"] = audio_url
        summary.append(item)
    return summary


def get_session_data(
    books_dir: Path,
    book_id: str,
    session_num: int,
    lecture_audio_dir: Path | str | None = None,
    base_url: str | None = None,
) -> dict[str, Any] | None:
    """Load full details of a specific session for GET /books/<id>/lectures/<session_num>.

    Includes cues, sentences, and bounding boxes.
    Injects audio_available and audio_url.
    """
    data = _read_manifest_data(books_dir, book_id)
    if data is None:
        return None

    target = None
    for s in data.get("sessions", []):
        if s.get("session") == session_num:
            target = s
            break
    if target is None:
        return None

    effective_base = base_url or os.environ.get("LECTURE_AUDIO_BASE_URL", "").strip()
    audio_name = target.get("audio", "")
    audio_file = resolve_session_audio_file(books_dir, book_id, audio_name, lecture_audio_dir)
    audio_available = bool(effective_base) or (audio_file is not None and audio_file.is_file())
    audio_url = resolve_audio_url(book_id, session_num, audio_name, effective_base)

    session_copy = dict(target)
    session_copy["audio_available"] = audio_available
    session_copy["audio_url"] = audio_url
    return session_copy


def get_session_audio_file(
    books_dir: Path,
    book_id: str,
    session_num: int,
    lecture_audio_dir: Path | str | None = None,
) -> Path | None:
    """Find the audio file path for a session number."""
    data = _read_manifest_data(books_dir, book_id)
    if data is None:
        return None
    for s in data.get("sessions", []):
        if s.get("session") == session_num:
            audio_name = s.get("audio", "")
            return resolve_session_audio_file(books_dir, book_id, audio_name, lecture_audio_dir)
    return None


def stream_audio_range(handler: Any, target_file: Path, head: bool = False) -> None:
    """Stream an MP3 file with HTTP Range support (206 Partial Content)."""
    if not target_file.is_file():
        handler.send_error(404)
        return

    size = target_file.stat().st_size
    start, end, status = 0, size - 1, 200
    byte_range = handler.headers.get("Range")

    if byte_range:
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", byte_range.strip())
        if not match or not any(match.groups()):
            handler.send_error(416)
            return
        if match[1]:
            start = int(match[1])
            end = min(int(match[2]), size - 1) if match[2] else size - 1
        else:
            start = max(0, size - int(match[2]))
        if start > end or start >= size:
            handler.send_response(416)
            handler.send_header("Content-Range", f"bytes */{size}")
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
        status = 206

    handler.send_response(status)
    handler.send_header("Content-Type", "audio/mpeg")
    handler.send_header("Content-Length", str(end - start + 1))
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("Cache-Control", "public, max-age=3600")
    if status == 206:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    handler.end_headers()

    if head:
        return

    with target_file.open("rb") as source:
        source.seek(start)
        remaining = end - start + 1
        try:
            while remaining > 0:
                chunk = source.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                handler.wfile.write(chunk)
                remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
