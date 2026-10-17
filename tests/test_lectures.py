"""Tests for ui.lectures: manifest loading, audio path resolution, and Range streaming."""
import json
from pathlib import Path
import pytest
from ui import lectures


def test_resolve_session_audio_internal_default(tmp_path):
    books = tmp_path / "books"
    lectures_dir = books / "tarhe-kolli" / "lectures"
    lectures_dir.mkdir(parents=True)
    audio_file = lectures_dir / "session_01.mp3"
    audio_file.write_bytes(b"ID3" + b"\x00" * 100)

    found = lectures.resolve_session_audio_file(books, "tarhe-kolli", "session_01.mp3")
    assert found == audio_file

    missing = lectures.resolve_session_audio_file(books, "tarhe-kolli", "session_02.mp3")
    assert missing is None


def test_resolve_session_audio_external_dir_precedence(tmp_path):
    books = tmp_path / "books"
    (books / "tarhe-kolli" / "lectures").mkdir(parents=True)
    (books / "tarhe-kolli" / "lectures" / "session_01.mp3").write_bytes(b"internal")

    ext = tmp_path / "external_audio"
    (ext / "tarhe-kolli").mkdir(parents=True)
    ext_file = ext / "tarhe-kolli" / "session_01.mp3"
    ext_file.write_bytes(b"external-subfolder")

    # When external dir is passed, internal is ignored
    found = lectures.resolve_session_audio_file(books, "tarhe-kolli", "session_01.mp3", lecture_audio_dir=ext)
    assert found == ext_file

    # Also test flat folder fallback in external dir
    ext_flat = tmp_path / "flat_ext"
    ext_flat.mkdir()
    flat_file = ext_flat / "session_02.mp3"
    flat_file.write_bytes(b"flat")
    found_flat = lectures.resolve_session_audio_file(books, "tarhe-kolli", "session_02.mp3", lecture_audio_dir=ext_flat)
    assert found_flat == flat_file

    # If missing in external dir, does NOT fall back to internal
    missing = lectures.resolve_session_audio_file(books, "tarhe-kolli", "session_01.mp3", lecture_audio_dir=ext_flat)
    assert missing is None


def test_load_lectures_summary_and_session_data(tmp_path):
    books = tmp_path / "books"
    books.mkdir()
    manifest = {
        "format": "v1",
        "book": "tarhe-kolli",
        "title": "طرح کلی",
        "sessions": [
            {
                "session": 1,
                "audio": "session_01.mp3",
                "duration": 2400.0,
                "lecture_start": 20.0,
                "lecture_end": 2380.0,
                "book_pages": [42, 58],
                "cues": [{"start": 20.0, "end": 25.0, "text": "sample", "page": 42}],
            },
            {
                "session": 2,
                "audio": "session_02.mp3",
                "duration": 3000.0,
                "lecture_start": 15.0,
                "book_pages": [60, 80],
                "cues": [{"start": 15.0, "end": 22.0, "text": "session 2", "page": 60}],
            },
        ],
    }
    (books / "tarhe-kolli.lectures.json").write_text(json.dumps(manifest), encoding="utf-8")

    # Create audio file only for session 1
    (books / "tarhe-kolli" / "lectures").mkdir(parents=True)
    (books / "tarhe-kolli" / "lectures" / "session_01.mp3").write_bytes(b"mp3data")

    summary = lectures.load_lectures_summary(books, "tarhe-kolli")
    assert len(summary) == 2
    # Cues should be stripped from summary
    assert "cues" not in summary[0]
    assert summary[0]["session"] == 1
    assert summary[0]["audio_available"] is True
    assert summary[0]["audio_url"] == "/books/tarhe-kolli/lectures/1/audio"

    assert summary[1]["session"] == 2
    assert summary[1]["audio_available"] is False

    # Get session 1 full data
    s1 = lectures.get_session_data(books, "tarhe-kolli", 1)
    assert s1 is not None
    assert s1["session"] == 1
    assert s1["audio_available"] is True
    assert len(s1["cues"]) == 1
    assert s1["cues"][0]["text"] == "sample"

    # Base URL override
    summary_base = lectures.load_lectures_summary(books, "tarhe-kolli", base_url="https://audio.example.com")
    assert summary_base[0]["audio_url"] == "https://audio.example.com/tarhe-kolli/session_01.mp3"
