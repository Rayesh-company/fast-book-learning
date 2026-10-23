"""The usage ledger (T22, GitLab #24): every ask-path upstream call lands
one entry on the paying Account — metered where the upstream exposes its
token counts (the composer seam), estimated from text volume where it
does not (Cognee's internal completion is invisible to this layer) — and
an entry that is not metered is MARKED as estimated, never passed off as
measured. Entries key by the ACCOUNT's email (T21, GitLab #23): the
phone no longer keys anything (ADR-0013's contract step); a pre-T21
store's rows remap through ui/migrate.py's attach map. The tariff converts tokens to Toman; the rates live in config
(compose env) and never in code, so a price change is an .env edit and a
restart, not a deploy.

The live read: `session_total` sums from the newest `ask` entry
inclusive — the sheet's header shows the open Session's running cost,
and a new ask (which records `ask` first) re-anchors it to zero-plus.

The store follows the quotas.py pattern: one SQLite file, its path over
env (`LEDGER_DB`), the module attribute the tests patch. Nothing here
imports the other ui modules — the container runs this file flat."""

from __future__ import annotations

import math
import os
import sqlite3
import threading
import time
from pathlib import Path

# The tariff (T22): Toman per million tokens, config-held. The defaults
# are the PM's starting dials for glm-5.3-flash on AvalAI — they are
# deliberately NOT measured market prices; the shape (config over code)
# is the decision (ADR-0013 batch D), the numbers are one .env edit away.
TARIFF_INPUT_TOMAN_PER_MTOK = int(
    os.environ.get("TARIFF_INPUT_TOMAN_PER_MTOK", "2000")
)
TARIFF_OUTPUT_TOMAN_PER_MTOK = int(
    os.environ.get("TARIFF_OUTPUT_TOMAN_PER_MTOK", "8000")
)

# The deduction wire (T23, GitLab #25): serve sets this once at import —
# every recorded entry's cost leaves the paying Account's Balance through
# exactly one path, so no capture site can forget it.
_DEDUCTOR = None


def set_deductor(fn) -> None:
    global _DEDUCTOR
    _DEDUCTOR = fn


LEDGER_DB = os.environ.get(
    "LEDGER_DB", str(Path(__file__).resolve().parent / "usage_ledger.sqlite3")
)

_LOCK = threading.Lock()


def _connect() -> sqlite3.Connection:
    con = sqlite3.connect(LEDGER_DB)
    con.execute(
        """CREATE TABLE IF NOT EXISTS usage_entries (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               account TEXT NOT NULL,
               ts TEXT NOT NULL,
               day TEXT NOT NULL,
               kind TEXT NOT NULL,
               metered INTEGER NOT NULL,
               input_tokens INTEGER NOT NULL,
               output_tokens INTEGER NOT NULL,
               cost_toman INTEGER NOT NULL,
               request_id TEXT
           )"""
    )
    # A pre-T21 store keys its rows `phone` — the column renames in
    # place (the values follow when ui/migrate.py runs the attach map).
    columns = {row[1] for row in con.execute("PRAGMA table_info(usage_entries)")}
    if "phone" in columns and "account" not in columns:
        con.execute("ALTER TABLE usage_entries RENAME COLUMN phone TO account")
        con.commit()
    # A deployed store predates the join key (spec 0025 §1): the guarded
    # ALTER per missing column, the chat store's own migration shape, so
    # a rebuild keeps existing rows and old entries read with the honest
    # absence.
    if "request_id" not in columns:
        con.execute("ALTER TABLE usage_entries ADD COLUMN request_id TEXT")
        con.commit()
    return con


def _today() -> str:
    return time.strftime("%Y-%m-%d", time.localtime())


def estimate_tokens(text: str) -> int:
    """The text-volume estimate: Farsi prose runs roughly three characters
    per token through the GLM tokenizer — a coarse mid, honest exactly
    because every entry it produces is marked estimated."""
    if not text:
        return 0
    return max(1, math.ceil(len(text) / 3))


def cost_toman(input_tokens: int, output_tokens: int) -> int:
    """The pure tariff conversion — the function the table-driven tests
    pin, so a rate change is provably arithmetic, never code."""
    cost = (
        input_tokens / 1_000_000 * TARIFF_INPUT_TOMAN_PER_MTOK
        + output_tokens / 1_000_000 * TARIFF_OUTPUT_TOMAN_PER_MTOK
    )
    return int(cost + 0.5)


def record(
    account: str,
    kind: str,
    input_tokens: int,
    output_tokens: int,
    metered: bool,
    request_id: str | None = None,
) -> dict:
    """One ledger entry: the Account pays for tokens, the entry says
    whether those tokens were measured or estimated."""
    cost = cost_toman(input_tokens, output_tokens)
    with _LOCK:
        con = _connect()
        try:
            con.execute(
                "INSERT INTO usage_entries (account, ts, day, kind, metered,"
                " input_tokens, output_tokens, cost_toman, request_id)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    account,
                    time.strftime("%Y-%m-%d %H:%M:%S"),
                    _today(),
                    kind,
                    1 if metered else 0,
                    input_tokens,
                    output_tokens,
                    cost,
                    request_id,
                ),
            )
            con.commit()
        finally:
            con.close()
    if _DEDUCTOR is not None and cost:
        try:
            _DEDUCTOR(account, cost)
        except Exception:
            pass  # the meter watches the work; it never breaks it
    return {
        "kind": kind,
        "metered": metered,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_toman": cost,
        "request_id": request_id,
    }


def record_composer_call(
    account: str,
    kind: str,
    prompt: str,
    reply,
    request_id: str | None = None,
) -> dict | None:
    """One composer-seam call: metered when the upstream's usage block
    rode the reply, estimated from the text volumes when it did not —
    the caller never decides, the reply's own honesty does."""
    usage = reply.get("usage") if isinstance(reply, dict) else None
    if isinstance(usage, dict) and isinstance(
        usage.get("prompt_tokens"), int
    ):
        output = usage.get("completion_tokens")
        output = output if isinstance(output, int) else estimate_tokens(
            _reply_text(reply)
        )
        return record(
            account,
            kind,
            usage["prompt_tokens"],
            output,
            metered=True,
            request_id=request_id,
        )
    output_text = _reply_text(reply)
    return record(
        account,
        kind,
        estimate_tokens(prompt),
        estimate_tokens(output_text),
        metered=False,
        request_id=request_id,
    )


def record_size_estimate(
    account: str,
    kind: str,
    input_bytes: int,
    request_id: str | None = None,
) -> dict:
    """The ask entry (T22): the gate knows only the request's size before
    the relay streams the answer — an input-side estimate, marked
    estimated like every non-metered entry."""
    return record(
        account,
        kind,
        estimate_tokens("x" * max(0, input_bytes)),
        0,
        metered=False,
        request_id=request_id,
    )


def _reply_text(reply) -> str:
    """The reply's own completion text, for the output-side estimate."""
    try:
        return reply["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        return ""


def session_total(account: str) -> int:
    """The open Session's running cost: everything since the newest
    `ask` entry inclusive — the entry a fresh ask records first, so the
    header re-anchors per ask and grows as the phases spend."""
    with _LOCK:
        con = _connect()
        try:
            anchor = con.execute(
                "SELECT id FROM usage_entries WHERE account = ? AND kind = 'ask'"
                " ORDER BY id DESC LIMIT 1",
                (account,),
            ).fetchone()
            if anchor is None:
                return 0
            row = con.execute(
                "SELECT COALESCE(SUM(cost_toman), 0) FROM usage_entries"
                " WHERE account = ? AND id >= ?",
                (account, anchor[0]),
            ).fetchone()
            return int(row[0])
        finally:
            con.close()


def day_total(account: str, day: str) -> int:
    """One calendar day's spend for the Account — `day` in the store's
    own `%Y-%m-%d` shape. The console's yesterday read (T25, GitLab
    #26): per-day usage and Toman was the ticket's ask, and every entry
    already carries its day, so history answers without a new store."""
    with _LOCK:
        con = _connect()
        try:
            row = con.execute(
                "SELECT COALESCE(SUM(cost_toman), 0) FROM usage_entries"
                " WHERE account = ? AND day = ?",
                (account, str(day)),
            ).fetchone()
            return int(row[0])
        finally:
            con.close()


# The profile's read cap (T24, GitLab #27): the history shows the last
# 20 Sessions, the open (newest) one first — a history that renders the
# Account's every sitting since day one is an unbounded query wearing a
# list; the cap keeps the profile a read, not a scan.
SESSION_HISTORY_CAP = 20


def session_history(account: str) -> list[dict]:
    """The Account's spend grouped into Sessions (T24, GitLab #27): the
    same anchor discipline as `session_total`, walked for the profile's
    history. The entries are read oldest→newest and each `ask` entry
    opens a new Session group that runs to the next ask (the group's
    own ask entry is its first row — `session_total` sums from the
    anchor inclusive, so the history counts the same way). The newest
    group leads — the open Session first — capped at the last
    SESSION_HISTORY_CAP groups.

    One group is {started, entries, cost_toman}: `started` is the ask
    entry's own ts (the sitting's opening), `entries` the group's rows
    oldest→newest with ts and the metered flag riding along, and
    `cost_toman` the group's summed spend. Entries before the first
    ask belong to no Session (a Session opens with an ask — the same
    reason `session_total` is 0 without one) and stay out of the
    history; the day's spend still counts them, which is
    `today_total`'s business. Read-only: the meter never lets a read
    rearrange what it recorded, and the profile needs no more than
    this — every field the sheet renders rides in these groups."""
    with _LOCK:
        con = _connect()
        try:
            rows = con.execute(
                "SELECT ts, kind, metered, input_tokens, output_tokens,"
                " cost_toman FROM usage_entries WHERE account = ? ORDER BY id",
                (account,),
            ).fetchall()
        finally:
            con.close()
    groups: list[dict] = []
    for ts, kind, metered, input_tokens, output_tokens, cost in rows:
        if kind == "ask":
            groups.append({"started": ts, "entries": [], "cost_toman": 0})
        if not groups:
            continue  # a spend with no ask behind it belongs to no Session
        groups[-1]["entries"].append(
            {
                "kind": kind,
                "metered": bool(metered),
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cost_toman": cost,
                "ts": ts,
            }
        )
        groups[-1]["cost_toman"] += cost
    return list(reversed(groups[-SESSION_HISTORY_CAP:]))


def today_total(account: str) -> int:
    """The server-local day's spend for the Account — the number the
    profile (T24) and the console (T25) read."""
    return day_total(account, _today())


def get_entries_by_request_id(request_id: str) -> list[dict]:
    """Queries usage_entries where request_id == request_id ordered by id ASC."""
    if not request_id:
        return []
    with _LOCK:
        con = _connect()
        try:
            con.row_factory = sqlite3.Row
            rows = con.execute(
                "SELECT id, ts, account, cost_toman, request_id, input_tokens, output_tokens, metered, kind "
                "FROM usage_entries WHERE request_id = ? ORDER BY id ASC",
                (request_id,),
            ).fetchall()
            entries = []
            for r in rows:
                cost = int(r["cost_toman"] or 0)
                in_tok = int(r["input_tokens"] or 0)
                out_tok = int(r["output_tokens"] or 0)
                is_met = bool(r["metered"])
                acc = r["account"] or ""
                entries.append(
                    {
                        "id": r["id"],
                        "ts": r["ts"],
                        "account": acc,
                        "phone": acc,
                        "cost_toman": cost,
                        "amount_toman": cost,
                        "request_id": r["request_id"],
                        "input_tokens": in_tok,
                        "output_tokens": out_tok,
                        "metered": is_met,
                        "is_metered": is_met,
                        "kind": r["kind"],
                        "raw_json": None,
                    }
                )
            return entries
        finally:
            con.close()


def get_request_usage_summary() -> dict[str, dict]:
    """Queries usage_entries where request_id IS NOT NULL, aggregating by request_id."""
    with _LOCK:
        con = _connect()
        try:
            con.row_factory = sqlite3.Row
            rows = con.execute(
                "SELECT account, ts, day, kind, metered, input_tokens, output_tokens, cost_toman, request_id "
                "FROM usage_entries WHERE request_id IS NOT NULL AND request_id != '' "
                "ORDER BY id DESC"
            ).fetchall()
        finally:
            con.close()

    summary: dict[str, dict] = {}
    for r in rows:
        req_id = r["request_id"]
        if not req_id:
            continue
        in_tok = int(r["input_tokens"] or 0)
        out_tok = int(r["output_tokens"] or 0)
        cost = int(r["cost_toman"] or 0)
        is_met = bool(r["metered"])
        acc = r["account"] or ""
        ts = r["ts"] or ""
        kind = r["kind"] or ""

        if req_id not in summary:
            summary[req_id] = {
                "cost_toman": cost,
                "input_tokens": in_tok,
                "output_tokens": out_tok,
                "tokens": in_tok + out_tok,
                "metered": is_met,
                "ts": ts,
                "phone": acc,
                "account": acc,
                "kind": kind,
            }
        else:
            s = summary[req_id]
            s["cost_toman"] += cost
            s["input_tokens"] += in_tok
            s["output_tokens"] += out_tok
            s["tokens"] += (in_tok + out_tok)
            if is_met:
                s["metered"] = True
            if not s["account"] and acc:
                s["account"] = acc
                s["phone"] = acc
    return summary
