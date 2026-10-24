"""Tests for ui.store_kernel (Store Kernel consolidation).

Verifies:
1. open_store creates tables from string and list schemas.
2. WAL mode and busy timeout pragmas are set.
3. Declarative migrations add missing columns and handle renames idempotently.
4. Connections work cleanly as context managers (commit on exit, rollback on error, close cleanly).
5. Auto-creation of parent directories.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
import pytest

from ui.store_kernel import StoreConnection, open_store


def test_open_store_creates_tables_str_schema(tmp_path: Path):
    db_path = tmp_path / "test_str.sqlite3"
    schema = "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)"
    conn = open_store(db_path, schema)
    try:
        conn.execute("INSERT INTO items (name) VALUES ('book')")
        conn.commit()
        row = conn.execute("SELECT id, name FROM items").fetchone()
        assert row == (1, "book")
    finally:
        conn.close()


def test_open_store_creates_tables_list_schema(tmp_path: Path):
    db_path = tmp_path / "test_list.sqlite3"
    schema = [
        "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)",
    ]
    conn = open_store(str(db_path), schema)
    try:
        conn.execute("INSERT INTO users (id, email) VALUES ('u1', 'test@example.com')")
        conn.commit()
        row = conn.execute("SELECT id, email FROM users WHERE email = 'test@example.com'").fetchone()
        assert row == ("u1", "test@example.com")
    finally:
        conn.close()


def test_wal_mode_and_busy_timeout_set(tmp_path: Path):
    db_path = tmp_path / "test_wal.sqlite3"
    schema = "CREATE TABLE IF NOT EXISTS t (id INT)"
    conn = open_store(db_path, schema, timeout=5.0)
    try:
        journal_mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert journal_mode.lower() == "wal"

        busy_timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        assert busy_timeout == 5000
    finally:
        conn.close()


def test_custom_busy_timeout(tmp_path: Path):
    db_path = tmp_path / "test_timeout.sqlite3"
    schema = "CREATE TABLE IF NOT EXISTS t (id INT)"
    conn = open_store(db_path, schema, timeout=2.5)
    try:
        busy_timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        assert busy_timeout == 2500
    finally:
        conn.close()


def test_in_memory_store_pragmas():
    schema = "CREATE TABLE IF NOT EXISTS t (id INT)"
    conn = open_store(":memory:", schema, timeout=3.0)
    try:
        journal_mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert journal_mode.lower() == "memory"
        busy_timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        assert busy_timeout == 3000
    finally:
        conn.close()


def test_migrations_add_missing_columns(tmp_path: Path):
    db_path = tmp_path / "test_migrate.sqlite3"
    # Pre-populate database with an older schema
    conn = sqlite3.connect(str(db_path))
    conn.execute("CREATE TABLE accounts (email TEXT PRIMARY KEY, password_hash TEXT NOT NULL)")
    conn.execute("INSERT INTO accounts (email, password_hash) VALUES ('a@b.com', 'hash123')")
    conn.commit()
    conn.close()

    migrations = [
        ("accounts", "balance_toman", "INTEGER NOT NULL DEFAULT 0"),
        ("accounts", "profile_json", "TEXT"),
    ]
    # Now open with open_store
    conn = open_store(
        db_path,
        "CREATE TABLE IF NOT EXISTS accounts (email TEXT PRIMARY KEY, password_hash TEXT NOT NULL)",
        migrations=migrations,
    )
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(accounts)")}
        assert "balance_toman" in cols
        assert "profile_json" in cols

        # Existing row preserved and populated with defaults
        row = conn.execute("SELECT email, password_hash, balance_toman, profile_json FROM accounts").fetchone()
        assert row == ("a@b.com", "hash123", 0, None)
    finally:
        conn.close()


def test_migrations_are_idempotent(tmp_path: Path):
    db_path = tmp_path / "test_idempotent.sqlite3"
    schema = "CREATE TABLE IF NOT EXISTS items (id INT)"
    migrations = [
        ("items", "request_id", "TEXT"),
        ("items", "web_sourced", "INTEGER NOT NULL DEFAULT 0"),
    ]
    # First touch: applies migrations
    conn1 = open_store(db_path, schema, migrations=migrations)
    conn1.close()

    # Second touch: columns already exist, should be a safe no-op
    conn2 = open_store(db_path, schema, migrations=migrations)
    try:
        cols = {row[1] for row in conn2.execute("PRAGMA table_info(items)")}
        assert "request_id" in cols
        assert "web_sourced" in cols
    finally:
        conn2.close()


def test_migrations_support_rename_from(tmp_path: Path):
    db_path = tmp_path / "test_rename.sqlite3"
    conn = sqlite3.connect(str(db_path))
    conn.execute("CREATE TABLE chats (phone TEXT NOT NULL, day TEXT NOT NULL)")
    conn.execute("INSERT INTO chats (phone, day) VALUES ('09120000000', '2026-10-23')")
    conn.commit()
    conn.close()

    migrations = [
        ("chats", "account", "RENAME FROM phone"),
    ]
    conn = open_store(
        db_path,
        "CREATE TABLE IF NOT EXISTS chats (account TEXT NOT NULL, day TEXT NOT NULL)",
        migrations=migrations,
    )
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(chats)")}
        assert "account" in cols
        assert "phone" not in cols

        row = conn.execute("SELECT account, day FROM chats").fetchone()
        assert row == ("09120000000", "2026-10-23")
    finally:
        conn.close()


def test_context_manager_commits_and_closes(tmp_path: Path):
    db_path = tmp_path / "test_cm.sqlite3"
    schema = "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, title TEXT)"

    with open_store(db_path, schema) as conn:
        assert isinstance(conn, StoreConnection)
        assert isinstance(conn, sqlite3.Connection)
        conn.execute("INSERT INTO items (title) VALUES ('clean')")

    # Outside the context manager: conn is closed
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")

    # Data is committed on disk
    with open_store(db_path, schema) as conn2:
        rows = conn2.execute("SELECT title FROM items").fetchall()
        assert rows == [("clean",)]


def test_context_manager_rolls_back_on_exception(tmp_path: Path):
    db_path = tmp_path / "test_cm_err.sqlite3"
    schema = "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, title TEXT)"

    with pytest.raises(RuntimeError):
        with open_store(db_path, schema) as conn:
            conn.execute("INSERT INTO items (title) VALUES ('doomed')")
            raise RuntimeError("something went wrong")

    with open_store(db_path, schema) as conn2:
        rows = conn2.execute("SELECT title FROM items").fetchall()
        assert rows == []


def test_auto_creates_parent_directories(tmp_path: Path):
    nested_db = tmp_path / "nested" / "sub" / "store.sqlite3"
    assert not nested_db.parent.exists()

    conn = open_store(nested_db, "CREATE TABLE IF NOT EXISTS t (x INT)")
    try:
        assert nested_db.exists()
        conn.execute("INSERT INTO t VALUES (42)")
        conn.commit()
    finally:
        conn.close()
