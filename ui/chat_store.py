"""The ask chat store (ADR-0014): one SQLite row per ask — the
question, its Book selection, the retrieval pool, the Quote selection,
and the Quoted answer's blocks — so a browser reload restores the whole
sheet instead of an empty page. The store is the research_store's
pattern (its own file, a module-attribute DB path the tests patch);
every write is idempotent per field, keyed by the row the ask minted,
and the reader is one phone-keyed ``latest_chat``.

Why a store of our own and not cognee's session manager: cognee's
(cognee/infrastructure/session) is a cache-backed completion-layer
assistant for its own retrievers — Redis/FsCache history that no-ops
when caching is off — not a durable, phone-keyed, phone-authorized
record of the sheet's phases. The sheet owns its persistence; the
retrieval service stays stateless to us."""

from __future__ import annotations

import datetime
import json
import os
import secrets
import sqlite3
from pathlib import Path

CHAT_DB = Path(
    os.environ.get(
        "SESSION_CHAT_DB", str(Path(__file__).resolve().parent / "chats.sqlite3")
    )
)


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(CHAT_DB), timeout=5)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS chats ("
        "id TEXT PRIMARY KEY, phone TEXT NOT NULL, "
        "question TEXT NOT NULL, datasets_json TEXT NOT NULL, "
        "sources_json TEXT NOT NULL, selections_json TEXT NOT NULL, "
        "blocks_json TEXT NOT NULL, truncated INTEGER NOT NULL DEFAULT 0, "
        "created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS agent_chats ("
        "id TEXT PRIMARY KEY, phone TEXT NOT NULL, thread_id TEXT NOT NULL, "
        "question TEXT NOT NULL, answer TEXT NOT NULL, "
        "web_sourced INTEGER NOT NULL DEFAULT 0, "
        "sources TEXT NOT NULL DEFAULT '[]', "
        "created_at TEXT NOT NULL)"
    )
    # The deployed DB's pre-#24 table predates the marking columns — the
    # store migrates itself on connect (guarded ALTER per missing
    # column), so a deployed DB reads old rows with the honest defaults
    # and takes the guarantee on new writes without a manual step.
    columns = {
        row[1] for row in conn.execute("PRAGMA table_info(agent_chats)")
    }
    if "web_sourced" not in columns:
        conn.execute(
            "ALTER TABLE agent_chats ADD COLUMN web_sourced"
            " INTEGER NOT NULL DEFAULT 0"
        )
    if "sources" not in columns:
        conn.execute(
            "ALTER TABLE agent_chats ADD COLUMN sources TEXT NOT NULL DEFAULT '[]'"
        )
    return conn


def _now() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


def create_chat(chat_id: str, phone: str, question: str, datasets, sources) -> None:
    """Insert one ask's row with its founding pool; the caller owns the
    id (the handler minted it before the first write, so the ask is
    always addressable by the id it already answered with)."""
    conn = _connect()
    try:
        stamp = _now()
        conn.execute(
            "INSERT INTO chats (id, phone, question, datasets_json, sources_json,"
            " selections_json, blocks_json, truncated, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
            (
                chat_id,
                phone,
                question,
                json.dumps(list(datasets or []), ensure_ascii=False),
                json.dumps(sources, ensure_ascii=False),
                "[]",
                "[]",
                stamp,
                stamp,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _owned(chat_id: str, phone: str) -> bool:
    """The row exists AND belongs to this phone — every phase update's
    guard, so a foreign chat_id in a request body can never write
    another phone's ask."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT 1 FROM chats WHERE id = ? AND phone = ?", (chat_id, phone)
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def _update(chat_id: str, phone: str, field: str, value) -> None:
    """One column's write, phone-guarded; the row's updated_at rides
    along. A value that is not the column's list shape is ignored — a
    malformed phase reply never corrupts the row."""
    if not isinstance(value, list) or not _owned(chat_id, phone):
        return
    conn = _connect()
    try:
        conn.execute(
            f"UPDATE chats SET {field} = ?, updated_at = ? WHERE id = ?",
            (json.dumps(value, ensure_ascii=False), _now(), chat_id),
        )
        conn.commit()
    finally:
        conn.close()


def update_pool(chat_id: str, phone: str, sources) -> None:
    """The pool column — the ask's founding write and the widen's
    (recall-more) growth land the same way."""
    _update(chat_id, phone, "sources_json", sources)


def update_selections(chat_id: str, phone: str, selections) -> None:
    """The Quote-selection column (ADR-0006): the first answer's
    verbatim Book sentences, kept for the reload."""
    _update(chat_id, phone, "selections_json", selections)


def update_quoted(chat_id: str, phone: str, blocks, truncated: bool = False) -> None:
    """The Quoted-answer column: phase 2's guarded document, kept for
    the reload; truncated rides beside it so the restored sheet shows
    the same continuation note the live one did."""
    if not isinstance(blocks, list) or not _owned(chat_id, phone):
        return
    conn = _connect()
    try:
        conn.execute(
            "UPDATE chats SET blocks_json = ?, truncated = ?, updated_at = ?"
            " WHERE id = ?",
            (
                json.dumps(blocks, ensure_ascii=False),
                1 if truncated else 0,
                _now(),
                chat_id,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def record_agent_exchange(
    phone: str,
    thread_id: str,
    question: str,
    answer: str,
    web_sourced: bool = False,
    sources=None,
) -> str:
    """One Question's row in the agent conversation (ADR-0018): the
    Learner's message, the agent's answer, and the guaranteed «بیرون از
    کتاب» marking (#24) — the web-sourced flag and its sources as the
    seam derived them from the tool-call record, kept for the reload's
    restore so the marking re-renders from the stored form with no agent
    call. A malformed source never corrupts the row (title+url kept,
    the rest dropped). Returns the minted row id."""
    exchange_id = secrets.token_hex(8)
    clean_sources = [
        {"title": source["title"], "url": source["url"]}
        for source in (sources or [])
        if isinstance(source, dict)
        and isinstance(source.get("title"), str)
        and isinstance(source.get("url"), str)
    ]
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO agent_chats (id, phone, thread_id, question, answer,"
            " web_sourced, sources, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                exchange_id,
                phone,
                thread_id,
                question,
                answer,
                1 if web_sourced else 0,
                json.dumps(clean_sources, ensure_ascii=False),
                _now(),
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return exchange_id


def agent_conversation(phone: str, limit: int = 50) -> list:
    """The phone's agent-chat transcript — the newest ``limit``
    exchanges, oldest first: the reload's restore payload (ADR-0014's
    persistence leg), each message carrying its stored «بیرون از کتاب»
    guarantee (#24) so the marking renders without re-deriving it. No
    LLM call, no metering; one phone's reload never reads another's
    conversation."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id, question, answer, web_sourced, sources, created_at"
            " FROM agent_chats WHERE phone = ?"
            " ORDER BY created_at DESC, rowid DESC LIMIT ?",
            (phone, limit),
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "id": row[0],
            "question": row[1],
            "answer": row[2],
            "web_sourced": bool(row[3]),
            "sources": json.loads(row[4]),
            "created_at": row[5],
        }
        for row in reversed(rows)
    ]


def latest_chat(phone: str):
    """The phone's newest ask row as {"id", "question", "datasets",
    "sources", "selections", "blocks", "truncated", "updated_at"}, or
    None — the reload's restore payload. One phone's reload never
    reads another's ask."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id, question, datasets_json, sources_json, selections_json,"
            " blocks_json, truncated, updated_at FROM chats WHERE phone = ?"
            " ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (phone,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return {
        "id": row[0],
        "question": row[1],
        "datasets": json.loads(row[2]),
        "sources": json.loads(row[3]),
        "selections": json.loads(row[4]),
        "blocks": json.loads(row[5]),
        "truncated": bool(row[6]),
        "updated_at": row[7],
    }
