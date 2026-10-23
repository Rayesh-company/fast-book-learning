"""The Store Kernel: consolidated SQLite setup, WAL pragmas, busy timeouts, and migrations.

Every SQLite-backed store in the system (accounts, chat_store, research_store,
question_window, quotas, ledger) connects through this kernel. It ensures:
1. Concurrency resilience via WAL journal mode (PRAGMA journal_mode=WAL) and
   configured busy timeouts (PRAGMA busy_timeout=5000 by default).
2. Declarative, idempotent schema definition and column migrations (ADD COLUMN
   and RENAME COLUMN checked via PRAGMA table_info).
3. Clean context management lifecycle via StoreConnection (commits on clean exit,
   rolls back on error, and closes cleanly).
4. Automatic creation of parent directories for database paths.
"""

from __future__ import annotations

import os
from pathlib import Path
import sqlite3
from typing import Callable, Sequence, Union

MigrationItem = Union[
    tuple[str, str, str],
    Callable[[sqlite3.Connection], None],
]


class StoreConnection(sqlite3.Connection):
    """SQLite connection subclass providing context manager lifecycle.

    When used with 'with open_store(...) as conn:', enters a transaction,
    commits on clean exit (or rolls back on unhandled exceptions), and closes
    the database connection cleanly on exit.
    """

    def __exit__(self, exc_type, exc_val, exc_tb):
        try:
            super().__exit__(exc_type, exc_val, exc_tb)
        finally:
            self.close()


def open_store(
    db_path: str | Path,
    schema_sql: str | Sequence[str],
    migrations: Sequence[MigrationItem] | None = None,
    timeout: float = 5.0,
) -> StoreConnection:
    """Open and initialize a SQLite store.

    Parameters:
        db_path: Path to SQLite file or ':memory:'. Parent directories are created
                 automatically if they do not exist.
        schema_sql: SQL string (can contain multiple statements) or sequence of
                    SQL statements creating required tables and indexes.
        migrations: Optional sequence of migration tuples:
                    (table_name, column_name, column_def_or_rename_directive)
                    e.g. ('chats', 'request_id', 'TEXT')
                    or ('chats', 'account', 'RENAME FROM phone').
                    Can also include callables fn(conn).
        timeout: Lock acquisition timeout in seconds (default 5.0s). Sets both
                 sqlite3 connect timeout and PRAGMA busy_timeout in milliseconds.

    Returns:
        StoreConnection instance ready for queries.
    """
    path_str = str(db_path)
    if path_str != ":memory:" and not path_str.startswith("file:"):
        Path(path_str).resolve().parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(path_str, timeout=timeout, factory=StoreConnection)

    # 1. Apply WAL mode and busy timeout pragmas
    conn.execute("PRAGMA journal_mode=WAL")
    busy_timeout_ms = int(timeout * 1000)
    conn.execute(f"PRAGMA busy_timeout={busy_timeout_ms}")

    # 2. Execute table creations from schema_sql
    # Statements that depend on migrated columns (e.g. CREATE INDEX) run after migrations.
    deferred_statements: list[str] = []
    if isinstance(schema_sql, (list, tuple)):
        statements = [s.strip() for s in schema_sql if s.strip()]
    else:
        statements = [s.strip() for s in schema_sql.strip().split(";") if s.strip()]

    for stmt in statements:
        if stmt.upper().startswith("CREATE INDEX"):
            deferred_statements.append(stmt)
        else:
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError:
                deferred_statements.append(stmt)
    conn.commit()

    # 3. Apply declarative migrations idempotently
    if migrations:
        for item in migrations:
            if callable(item):
                item(conn)
                continue

            table_name, col_or_target, action_or_def = item
            cols = {
                row[1]
                for row in conn.execute(f"PRAGMA table_info({table_name})")
            }
            if not cols:
                continue

            act = action_or_def.strip()
            act_upper = act.upper()
            try:
                if act_upper.startswith("RENAME FROM "):
                    old_col = act[len("RENAME FROM "):].strip()
                    if old_col in cols and col_or_target not in cols:
                        conn.execute(
                            f"ALTER TABLE {table_name} RENAME COLUMN {old_col} TO {col_or_target}"
                        )
                elif act_upper.startswith("RENAME TO "):
                    new_col = act[len("RENAME TO "):].strip()
                    if col_or_target in cols and new_col not in cols:
                        conn.execute(
                            f"ALTER TABLE {table_name} RENAME COLUMN {col_or_target} TO {new_col}"
                        )
                elif act_upper.startswith("ALTER TABLE "):
                    if col_or_target not in cols:
                        conn.execute(act)
                else:
                    if col_or_target not in cols:
                        conn.execute(
                            f"ALTER TABLE {table_name} ADD COLUMN {col_or_target} {act}"
                        )
            except sqlite3.OperationalError:
                pass
        conn.commit()

    # 4. Execute deferred statements (indexes, etc.) now that columns are present
    for stmt in deferred_statements:
        conn.execute(stmt)
    conn.commit()

    return conn


__all__ = ["StoreConnection", "open_store"]
