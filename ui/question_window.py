"""The Question window (Wayfinder #13, ADR-0017/0018): the launch meter
for chat-with-book — 30 Questions per rolling 5 hours per Account,
replacing the 5-ask daily quota the ask gate kept. A Question is one
Learner message that RECEIVES an agent answer (ADR-0018): the
Learner-facing seam records it when the answer lands, and the agent's
own tool rounds never meter. The store is the quota DB's own file (one
more table on the same persisted volume); the module attribute is the
seam the tests patch."""

from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path

# ADR-0017's launch values: 30 Questions (one ask + its answer) per 5
# hours per Account. Reading, notes, and TTS are never windowed.
QUESTION_WINDOW_LIMIT = 30
QUESTION_WINDOW_HOURS = 5.0

WINDOW_DB = Path(
    os.environ.get(
        "SESSION_UI_QUOTA_DB", str(Path(__file__).resolve().parent / "usage.sqlite3")
    )
)


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(WINDOW_DB), timeout=5)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS questions ("
        "phone TEXT NOT NULL, at REAL NOT NULL)"
    )
    return conn


def questions_in_window(phone: str, now: float = None) -> int:
    """The phone's Questions inside the rolling five hours."""
    moment = time.time() if now is None else now
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT COUNT(*) FROM questions WHERE phone = ? AND at > ?",
            (phone, moment - QUESTION_WINDOW_HOURS * 3600),
        ).fetchone()
    finally:
        conn.close()
    return row[0]


def record_question(phone: str, now: float = None) -> None:
    """One Question recorded; the write prunes the phone's records at or
    past the five-hour edge, so the table stays the window's own size."""
    moment = time.time() if now is None else now
    conn = _connect()
    try:
        conn.execute(
            "DELETE FROM questions WHERE phone = ? AND at <= ?",
            (phone, moment - QUESTION_WINDOW_HOURS * 3600),
        )
        conn.execute(
            "INSERT INTO questions (phone, at) VALUES (?, ?)", (phone, moment)
        )
        conn.commit()
    finally:
        conn.close()


def window_state(phone: str, now: float = None) -> dict:
    """The window at a glance (issue #23): how many Questions remain in
    the rolling five hours, and when the oldest in-window Question ages
    out — the moment a full window reopens. One read feeds every
    Learner-facing surface (the seam's reply, the restore read, and the
    429 refusal's named reopen time), so the sheet's counter and the
    refusal can never disagree. remaining is clamped at 0 — a store may
    honestly hold more than the limit (the refusal stops the write, it
    cannot un-write); reopens_at is None when no Question is aging out."""
    moment = time.time() if now is None else now
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT COUNT(*), MIN(at) FROM questions WHERE phone = ? AND at > ?",
            (phone, moment - QUESTION_WINDOW_HOURS * 3600),
        ).fetchone()
    finally:
        conn.close()
    count, oldest = row
    return {
        "remaining": max(QUESTION_WINDOW_LIMIT - count, 0),
        "reopens_at": (
            oldest + QUESTION_WINDOW_HOURS * 3600 if oldest is not None else None
        ),
    }
