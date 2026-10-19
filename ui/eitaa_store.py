"""The Eita binding store (ADR-0021): one SQLite row per Eita user
linked to an Account — the برنامک's own durable join table. The
note_store.py pattern exactly: the database path is the module
attribute tests patch, its own file so a patched Eita DB never shares
a test with the Session, account, quota, ledger, research, chat, or
note stores.

The domain law it serves (ADR-0013, untouched): the Account is the
only identity and Login is the one door — the برنامک never issues,
never registers. The row records that this Eita user answered the
door once with an Account's email and password; every later open of
the app exchanges its initData for that Account's ordinary signed
token and rides the shared API. One Eita user holds ONE binding (a
re-link upserts in place — the user's latest answer is the truth);
one Account may carry several (a phone and a laptop are both Eita
users to the platform). The chat_id is the same Eita user id the
sendMessage call addresses — recorded beside the names so the push
never has to re-derive anything.

Ownership: a binding is read and removed through its Account's email
(the cookie-is-the-address rule); another Account's row is None/
False/absent, never a leak."""

from __future__ import annotations

import datetime
import os
import sqlite3
import threading
from pathlib import Path

# The binding store's own file (the session_store.py pattern): ui/ in
# dev, the /data volume in deploys; EITAA_DB moves it for tests.
EITAA_DB = Path(
    os.environ.get(
        "EITAA_DB", str(Path(__file__).resolve().parent / "eitaa.sqlite3")
    )
)

_LOCK = threading.Lock()


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(
        timespec="seconds"
    )


def _connect() -> sqlite3.Connection:
    con = sqlite3.connect(EITAA_DB)
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS eita_bindings (
            eita_user_id INTEGER PRIMARY KEY,
            account TEXT NOT NULL,
            chat_id INTEGER NOT NULL,
            first_name TEXT NOT NULL DEFAULT '',
            last_name TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    con.execute(
        "CREATE INDEX IF NOT EXISTS idx_eita_account ON eita_bindings(account)"
    )
    return con


def _row_to_binding(row) -> dict:
    return {
        "eita_user_id": row[0],
        "account": row[1],
        "chat_id": row[2],
        "first_name": row[3],
        "last_name": row[4],
        "created_at": row[5],
        "updated_at": row[6],
    }


_SELECT = (
    "SELECT eita_user_id, account, chat_id, first_name, last_name,"
    " created_at, updated_at FROM eita_bindings"
)


def get_binding(eita_user_id: int) -> dict | None:
    """The row behind an Eita user id — the /eitaa/auth exchange's
    lookup; the Account's own liveness is the caller's question (a
    binding whose Account was deleted resolves to no token)."""
    con = _connect()
    try:
        row = con.execute(
            _SELECT + " WHERE eita_user_id = ?", (int(eita_user_id),)
        ).fetchone()
        return _row_to_binding(row) if row else None
    finally:
        con.close()


def bindings_for_account(account: str, cap: int = 20) -> list[dict]:
    """The Account's bound Eita users — the push's address book, the
    profile's future read. The cap bounds a pathological book, not a
    real one."""
    con = _connect()
    try:
        return [
            _row_to_binding(row)
            for row in con.execute(
                _SELECT + " WHERE account = ? ORDER BY updated_at DESC LIMIT ?",
                (account, cap),
            )
        ]
    finally:
        con.close()


def bind(
    eita_user_id: int,
    account: str,
    chat_id: int,
    first_name: str = "",
    last_name: str = "",
) -> dict:
    """Record (or re-record) the link. The upsert is the whole
    policy: a user re-linking to another Account moves the row — one
    Eita user, one current answer to the door. The chat_id rides as
    the INTEGER it is (Eita's ids stay under 52 bits) — the number
    the sendMessage doc's own example carries."""
    with _LOCK:
        con = _connect()
        try:
            now = _now()
            con.execute(
                """
                INSERT INTO eita_bindings (
                    eita_user_id, account, chat_id,
                    first_name, last_name, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(eita_user_id) DO UPDATE SET
                    account = excluded.account,
                    chat_id = excluded.chat_id,
                    first_name = excluded.first_name,
                    last_name = excluded.last_name,
                    updated_at = excluded.updated_at
                """,
                (
                    int(eita_user_id),
                    account,
                    int(chat_id),
                    str(first_name or "")[:120],
                    str(last_name or "")[:120],
                    now,
                    now,
                ),
            )
            con.commit()
        finally:
            con.close()
    return get_binding(eita_user_id) or {}


def unbind(eita_user_id: int, account: str | None = None) -> bool:
    """Remove a link. With an account given, only THAT Account's row
    goes — the «خروج از ایتا» verb is the caller's own act on the
    caller's own binding, and a foreign id is silently not theirs."""
    with _LOCK:
        con = _connect()
        try:
            if account is None:
                cur = con.execute(
                    "DELETE FROM eita_bindings WHERE eita_user_id = ?",
                    (int(eita_user_id),),
                )
            else:
                cur = con.execute(
                    "DELETE FROM eita_bindings"
                    " WHERE eita_user_id = ? AND account = ?",
                    (int(eita_user_id), account),
                )
            con.commit()
            return cur.rowcount > 0
        finally:
            con.close()
