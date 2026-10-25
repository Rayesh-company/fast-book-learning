#!/usr/bin/env python3
"""Serve the Farsi Session sheet, proxy first-answer recall to Cognee,
pick the Quote selection — the first answer rendered on the sheet
(ADR-0006, issue #28) — relay the recorded Next-tier COT probe to
cognee-next-tier (the operator probe remains), compose the Quoted answer
for phase 2, and run Research Mode (ADR-0008): the multi-turn Wayfinder
whose turns classify intent, gather evidence over the second Cognee
service with the old dive's bounded fan-out, synthesize guarded claims,
and close with a Brief built from the research state."""

from __future__ import annotations

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import base64
import gzip
import hashlib
import hmac
import json
import os
from pathlib import Path
import queue
import re
import secrets
import socket
import sys
import time
import threading
from stat import S_ISREG
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urljoin, urlparse
from urllib.request import Request, urlopen

try:
    from ui.dotenv_helper import load_env
except ImportError:
    from dotenv_helper import load_env

load_env()

try:
    # The visual pipeline: pages of the Books rasterized by a real PDF
    # engine (PDFium, ADR-0007's rendering addendum) — the browser never
    # re-typesets these Persian subsets. Kept optional so a dev machine
    # without the wheel still serves the sheet (the reader's /books
    # page route answers 503 and the sheet explains itself).
    import pypdfium2 as _pdfium
except ImportError:  # pragma: no cover - the container installs it
    _pdfium = None

try:
    # The deep modules behind this facade; the re-exports below keep the
    # tests' single `from ui import serve` import seam.
    from ui.agent_client import (
        AGENT_FAILED_DETAIL,
        AGENT_UNREACHABLE_DETAIL,
        AgentError,
        AgentStream,
        CHAT_ANSWER_ERROR,
        CHAT_ANSWER_FINALIZED,
        LearnerTurnContext,
        agent_answer,
        sse_frame,
        validated_datasets,
    )
    from ui.question_window import (
        QUESTION_WINDOW_HOURS,
        QUESTION_WINDOW_LIMIT,
        questions_in_window,
        record_question,
        window_state,
    )
    from ui.guard import (
        _fuzzy_window,
        _stream_with_offsets,
        book_label,
        display_text,
        first_page_label,
        guard_blocks,
        guard_sentences,
        normalize_for_match,
        pages_label,
        parse_quoted_reply,
    )
    from ui.quotas import (
        DAILY_CHAT_LIMIT,
        chats_today,
        is_unlimited,
        normalize_phone,
        record_chat,
    )
    from ui.accounts import (
        account_by_email,
        account_by_phone,
        admins_exist,
        attach_phone,
        create_account,
        credit_balance,
        deduct_balance,
        ensure_admin,
        get_balance,
        get_profile,
        list_accounts,
        normalize_local_phone,
        save_profile,
        verify_login,
    )
    from ui import otp
    from ui import audit, migrate, throttle
    from ui.console import console_html
    from ui.composer import (
        COMPOSER_MAX_TOKENS,
        COMPOSER_TIMEOUT,
        build_continuation_prompt,
        build_planner_prompt,
        build_quoted_prompt,
        compose_quoted_answer,
        rewrite_followup_query,
        set_meter,
    )
    from ui.ledger import (
        record_composer_call,
        record_size_estimate,
        session_history,
        session_total,
        today_total,
        day_total,
    )
    from ui import ledger
    from ui import session_store
    from ui import note_store
    from ui import research_store
    from ui import eitaa
    from ui import eitaa_store
    from ui.picker import (
        QUOTE_SELECTION_FLOOR,
        build_picker_prompt,
        parse_picker_reply,
        pick_quote_selection,
    )
    from ui.recall_more import (
        build_broaden_prompt,
        parse_broaden_reply,
        recall_more,
    )
    from ui.page_resolver import (
        install as install_page_resolver,
    )
    from ui.dive import (
        BOOK_DATASETS,
        DIVE_MAX_RETRIEVAL_ROUNDS,
        DIVE_MAX_SUB_QUESTIONS,
        DIVE_SEARCH_TIMEOUT,
        DIVE_STARVED_PASSAGES,
        NEXT_TIER_URL,
        dive_recall,
        dive_retrieve,
        parse_evidence_sources,
        run_dive_round,
    )
    from ui.report import research_session_report
    from ui import chat_store
    from ui.chat_store import latest_chat
    from ui.ask import ask_pool, distill_pool
    from ui.research import (
        COMMAND_AUDIT,
        COMMAND_BRIEF,
        COMMAND_GATHER,
        COMMAND_SYNTHESIZE,
        CONVERSATIONAL_INTENTS,
        RESEARCH_BUSY_GLOBAL_DETAIL,
        RESEARCH_BUSY_ACCOUNT_DETAIL,
        RESEARCH_EVIDENCE_FLOOR,
        RESEARCH_EVENT_ABORTED,
        RESEARCH_EVENT_BRIEF,
        RESEARCH_EVENT_CLASSIFYING,
        RESEARCH_EVENT_DONE,
        RESEARCH_EVENT_FAILED,
        RESEARCH_EVENT_PLANNING,
        RESEARCH_EVENT_SEARCHING,
        RESEARCH_EVENT_WRITING,
        RESEARCH_FAILED_DETAIL,
        RESEARCH_INTENTS,
        RESEARCH_MAX_CONCURRENT,
        RESEARCH_MODEL,
        RESEARCH_NO_EVIDENCE_DETAIL,
        RESEARCH_RECENT_SETTLED,
        RESEARCH_REGISTRY,
        RESEARCH_REGISTRY_LOCK,
        RESEARCH_SESSION_CAP_DETAIL,
        RESEARCH_SESSION_CLOSED_DETAIL,
        RESEARCH_SESSION_NOT_FOUND_DETAIL,
        RESEARCH_SESSION_TURN_CAP,
        RESEARCH_TURN_NOT_FOUND_DETAIL,
        TURN_TERMINAL_STATES,
        ResearchTurn,
        abort_account_research,
        abort_research_turn,
        build_classify_prompt,
        build_conversational_prompt,
        build_subquestions_prompt,
        build_synthesis_prompt,
        classify_message,
        compose_guarded_reply,
        decide_proposal,
        ensure_session,
        find_turn,
        next_best_move,
        parse_classify_reply,
        plan_subquestions,
        record_claims,
        research_session_messages,
        research_session_state,
        research_state_summary,
        research_suggestions,
        run_research_turn,
        seed_evidence,
        start_research_turn,
        turn_status_payload,
        with_references,
    )
    from ui import lectures
    from ui import telemetry
    abort_phone_research = abort_account_research
except ImportError:  # the container runs this file as a script beside the modules
    from agent_client import (
        AGENT_FAILED_DETAIL,
        AGENT_UNREACHABLE_DETAIL,
        AgentError,
        AgentStream,
        CHAT_ANSWER_ERROR,
        CHAT_ANSWER_FINALIZED,
        LearnerTurnContext,
        agent_answer,
        sse_frame,
        validated_datasets,
    )
    from question_window import (
        QUESTION_WINDOW_HOURS,
        QUESTION_WINDOW_LIMIT,
        questions_in_window,
        record_question,
        window_state,
    )
    from guard import (
        _fuzzy_window,
        _stream_with_offsets,
        book_label,
        display_text,
        first_page_label,
        guard_blocks,
        guard_sentences,
        normalize_for_match,
        pages_label,
        parse_quoted_reply,
    )
    from quotas import (
        DAILY_CHAT_LIMIT,
        chats_today,
        is_unlimited,
        normalize_phone,
        record_chat,
    )
    from accounts import (
        account_by_email,
        account_by_phone,
        admins_exist,
        attach_phone,
        create_account,
        credit_balance,
        deduct_balance,
        ensure_admin,
        get_balance,
        get_profile,
        list_accounts,
        normalize_local_phone,
        save_profile,
        verify_login,
    )
    import otp
    import audit, migrate, throttle
    from console import console_html
    from report import research_session_report
    from ask import ask_pool, distill_pool
    from chat_store import latest_chat
    import chat_store
    from composer import (
        COMPOSER_MAX_TOKENS,
        COMPOSER_TIMEOUT,
        build_continuation_prompt,
        build_planner_prompt,
        build_quoted_prompt,
        compose_quoted_answer,
        rewrite_followup_query,
        set_meter,
    )
    from ledger import (
        record_composer_call,
        record_size_estimate,
        session_history,
        session_total,
        today_total,
        day_total,
    )
    import ledger
    import session_store
    import note_store
    import research_store
    import eitaa
    import eitaa_store
    from picker import (
        QUOTE_SELECTION_FLOOR,
        build_picker_prompt,
        parse_picker_reply,
        pick_quote_selection,
    )
    from recall_more import (
        build_broaden_prompt,
        parse_broaden_reply,
        recall_more,
    )
    from page_resolver import (
        install as install_page_resolver,
    )
    from dive import (
        BOOK_DATASETS,
        DIVE_MAX_RETRIEVAL_ROUNDS,
        DIVE_MAX_SUB_QUESTIONS,
        DIVE_SEARCH_TIMEOUT,
        DIVE_STARVED_PASSAGES,
        NEXT_TIER_URL,
        dive_recall,
        dive_retrieve,
        parse_evidence_sources,
        run_dive_round,
    )
    from research import (
        COMMAND_AUDIT,
        COMMAND_BRIEF,
        COMMAND_GATHER,
        COMMAND_SYNTHESIZE,
        CONVERSATIONAL_INTENTS,
        RESEARCH_BUSY_GLOBAL_DETAIL,
        RESEARCH_BUSY_ACCOUNT_DETAIL,
        RESEARCH_EVIDENCE_FLOOR,
        RESEARCH_EVENT_ABORTED,
        RESEARCH_EVENT_BRIEF,
        RESEARCH_EVENT_CLASSIFYING,
        RESEARCH_EVENT_DONE,
        RESEARCH_EVENT_FAILED,
        RESEARCH_EVENT_PLANNING,
        RESEARCH_EVENT_SEARCHING,
        RESEARCH_EVENT_WRITING,
        RESEARCH_FAILED_DETAIL,
        RESEARCH_INTENTS,
        RESEARCH_MAX_CONCURRENT,
        RESEARCH_MODEL,
        RESEARCH_NO_EVIDENCE_DETAIL,
        RESEARCH_RECENT_SETTLED,
        RESEARCH_REGISTRY,
        RESEARCH_REGISTRY_LOCK,
        RESEARCH_SESSION_CAP_DETAIL,
        RESEARCH_SESSION_CLOSED_DETAIL,
        RESEARCH_SESSION_NOT_FOUND_DETAIL,
        RESEARCH_SESSION_TURN_CAP,
        RESEARCH_TURN_NOT_FOUND_DETAIL,
        TURN_TERMINAL_STATES,
        ResearchTurn,
        abort_account_research,
        abort_research_turn,
        build_classify_prompt,
        build_conversational_prompt,
        build_subquestions_prompt,
        build_synthesis_prompt,
        classify_message,
        compose_guarded_reply,
        decide_proposal,
        ensure_session,
        find_turn,
        next_best_move,
        parse_classify_reply,
        plan_subquestions,
        record_claims,
        research_session_messages,
        research_session_state,
        research_state_summary,
        research_suggestions,
        run_research_turn,
        seed_evidence,
        start_research_turn,
        turn_status_payload,
        with_references,
    )
    import lectures
    import telemetry
    abort_phone_research = abort_account_research

UI_DIR = Path(__file__).resolve().parent
# The Book set's PDFs and per-page text indexes (tools/build_page_index.py).
# Default: the repo's books/ beside ui/ in dev; compose bind-mounts it at
# /books in the container — the same relative place from /app/ui.
BOOKS_DIR = Path(
    os.environ.get("SESSION_BOOKS_DIR", str(UI_DIR.parent / "books"))
)
# The lecture sessions' recorded MP3s (the کتاب‌خوان's lecture player).
# The heavy audio lives OUTSIDE the repo and OUTSIDE the rsynced tree —
# the deploy mounts it read-only at /lecture-audio — and
# LECTURE_AUDIO_DIR points there (<dir>/<dataset>/session_XX.mp3). Read
# per call, the auth_secret() rule; unset (dev without the package),
# the routes answer 404 and the player explains itself.
LECTURE_AUDIO_DIR_ENV = "LECTURE_AUDIO_DIR"

# The session index is ~45MB of word-level alignment — too heavy for a
# phone to fetch just to show a session picker. The summary below is
# what the player reads: one slim row per session (number, audio file,
# duration, the «بدون مقدمه» boundaries, pages), parsed once per
# process and cached until the file's mtime moves.
_LECTURES_SUMMARY_CACHE: dict = {}


def lectures_summary(dataset: str) -> dict | None:
    """The slim session index for the player's picker, or None when the
    dataset holds no lecture package. Parsed once per process — the
    cache key carries the source file's mtime so a new delivery is
    picked up without a restart."""
    import json as _json

    source = BOOKS_DIR / f"{dataset}.lectures.json"
    if not source.is_file():
        return None
    try:
        mtime = source.stat().st_mtime
    except OSError:
        return None
    cached = _LECTURES_SUMMARY_CACHE.get(dataset)
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        index = _json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    sessions = []
    for row in index.get("sessions") or []:
        if not isinstance(row, dict) or "audio" not in row:
            continue
        sessions.append(
            {
                "session": row.get("session"),
                "audio": row.get("audio"),
                "duration": row.get("duration"),
                "lecture_start": row.get("lecture_start"),
                "lecture_end": row.get("lecture_end"),
                "cover_page": row.get("cover_page"),
                "book_pages": row.get("book_pages"),
            }
        )
    summary = {
        "book": index.get("book", dataset),
        "title": index.get("title", ""),
        "sessions": sessions,
    }
    _LECTURES_SUMMARY_CACHE[dataset] = (mtime, summary)
    return summary


def lecture_audio_dir():
    value = str(os.environ.get(LECTURE_AUDIO_DIR_ENV, "") or "").strip()
    return value or None
# Rendered page rasters (the visual pipeline). The books/ mount is
# read-only, so the cache lives outside it. Default: a `render-cache/`
# beside the books dir — persistent across restarts and deploys, unlike
# the old /tmp default that turned every container rebuild into a fully
# cold reader (ADR-0017); compose pins the volume explicitly.
RENDER_CACHE_DIR = Path(
    os.environ.get("SESSION_RENDER_CACHE", str(BOOKS_DIR.parent / "render-cache"))
)
# The cache's ceiling (ADR-0017): width buckets × pages can outgrow a
# small disk, so once the total passes the cap the oldest rasters go
# first. Overridable for tests and tight volumes.
RENDER_CACHE_CAP = int(os.environ.get("SESSION_RENDER_CACHE_CAP", str(3 << 30)))
# The OTA payload (rule 001, docs/rules/001-no-new-apks.md): the mobile
# app's over-the-air updates — one manifest.json plus the current
# bundle's files under current/. Published by scripts/publish_ota.py
# from an `expo export`; an empty dir simply means "no update yet" and
# /ota answers 204, the client keeps what it has.
OTA_DIR = Path(os.environ.get("SESSION_OTA_DIR", str(UI_DIR / "ota")))
# PDFium is not provably thread-safe across documents; renders are
# serialized (one page takes a fraction of a second).
RENDER_LOCK = threading.Lock()
# The open-document reuse (ADR-0017): a raster cache miss used to pay a
# full PdfDocument parse of the whole file on EVERY page — under the
# global lock, so every waiting client waited too. The parsed document
# handles live here, newest-used wins, closed on eviction; reuse stays
# inside RENDER_LOCK so the thread-safety argument above holds unchanged.
PDF_DOCS_CACHE: dict[str, object] = {}
PDF_DOCS_CACHE_CAP = 2
COGNEE_URL = os.environ.get("COGNEE_URL", "http://127.0.0.1:8000").rstrip("/")
HOST = os.environ.get("SESSION_UI_HOST", "0.0.0.0")
PORT = int(os.environ.get("SESSION_UI_PORT", "8765"))
PROXY_TIMEOUT = 600


def allowed_origins():
    """The CORS allowlist (ADR-0020): SESSION_UI_ALLOWED_ORIGINS, a
    comma-separated set of Origins that may call this API from a
    BROWSER cross-origin — the Expo web dev server's origin in dev;
    the deployed VPS shape stays empty (the sheet serves its own
    origin only). Native clients (the Expo Android app) need no CORS:
    their requests carry the Bearer token and no Origin check. Read
    per request, so a test's monkeypatched env lands."""
    raw = os.environ.get("SESSION_UI_ALLOWED_ORIGINS", "")
    return {item.strip() for item in raw.split(",") if item.strip()}
# A Next-tier search runs four chain-of-thought rounds and can pass ten
# minutes (live logs, 2026-09-11) — past the shared 600s leash the relay
# once gave up on a search the second service had already finished.
# Phase 3 waits on its own leash; "unreachable: timed out" only after it.
NEXT_TIER_TIMEOUT = int(os.environ.get("NEXT_TIER_TIMEOUT", "1200"))
# The prepaid wiring (T23, GitLab #25): every ledger entry's cost leaves
# the paying Account's Balance through this one path — the capture sites
# never deduct by hand, so none can forget.
ledger.set_deductor(deduct_balance)

ALLOWED_PROXY = {"/health", "/api/v1/recall"}
NEXT_TIER_SEARCH_TYPE = "GRAPH_COMPLETION_COT"

# --- the Account gate (ADR-0013) ---------------------------------------------
# The login page replaced the honor-system phone gate: an Account — an
# email and a password issued by the Admin, never self-created — is the
# only door, and the phone number survives as legacy data attached to
# it, not an identity. Authentication is a stateless signed token in an
# HttpOnly cookie: the payload is base64(JSON{email, role, exp}) and
# the signature is hmac-sha256 over exactly those bytes with the server
# secret — no revocation list, no server-side session store, nothing
# for a handful of Admin-issued Accounts to outgrow.

# The cookie the sheet's browser carries; HttpOnly so the sheet's own
# JS can never read the token, Path=/ so every endpoint sees it.
AUTH_COOKIE = "cwb_auth"
# Thirty days: the PM's monthly-Session law (2026-10-25) — a login
# lasts one month, then the honest 401 walks the caller back to the
# door and the client's honest boot shows the login page again.
# Pinned in source, never env.
AUTH_TOKEN_TTL = 30 * 24 * 3600
AUTH_LOGIN_401_DETAIL = "برای ادامه وارد شوید."
AUTH_NOT_ADMIN_403_DETAIL = "ساختن حساب فقط از دست مدیر برمی‌آید."
# The console's own refusal (T25): the mirror is the Admin's surface —
# a logged-in operator's cookie reaches the endpoint but not the page,
# and the Farsi note names whose door it is.
ADMIN_CONSOLE_403_DETAIL = "میز مدیریت فقط از دست مدیر برمی‌آید."
# How many audit rows the console shows (T25): a glance at the newest
# actions, not the archive — the log itself keeps everything.
ADMIN_AUDIT_ROWS = 20
AUTH_BAD_CREDENTIALS_DETAIL = "ایمیل یا گذرواژه نادرست است."
AUTH_BAD_LOGIN_BODY_DETAIL = "ایمیل و گذرواژه را بفرستید."
AUTH_LOGOUT_DETAIL = "خارج شدید."
AUTH_EMAIL_TAKEN_DETAIL = "این ایمیل پیش‌تر حساب گرفته است."
# The SMS login's own words (the OTP layer ADR-0013 parked, 2026-10-23):
# one refusal shape for a wrong and an expired code alike (the guesser
# never learns which), the cooldown's honest wait, and the two
# configuration failures that must never wear a user error's clothing —
# an unconfigured فراز اسمس answers 503 like the برنامک's unconfigured
# bot, a panel refusal answers 502.
OTP_BAD_BODY_DETAIL = "شمارهٔ موبایل را بفرستید."
OTP_BAD_PHONE_DETAIL = "شمارهٔ موبایل ایرانی را با ۱۱ رقم وارد کنید."
OTP_BAD_CODE_401_DETAIL = "کد درست نیست یا به پایان رسیده است. دوباره کد بگیرید."
OTP_RATE_429_DETAIL = "برای درخواست کد جدید یک دقیقه صبر کنید."
# The per-IP throttle's own refusal (F-002/F-003 of the 2026-10-24
# review): one Farsi note for every anonymous door's exhausted budget —
# the guesser learns the bound exists, nothing more.
THROTTLE_429_DETAIL = (
    "درخواست‌های این نشانی بیش از حد است؛ کمی بعد دوباره تلاش کنید."
)
OTP_UNCONFIGURED_503_DETAIL = (
    "ورود پیامکی روی این سرور تنظیم نشده است؛ از ورود با ایمیل استفاده کنید."
)
OTP_SEND_502_DETAIL = "پیامک فرستاده نشد؛ کمی بعد دوباره کد بگیرید."
# The waitlist's retirement (2026-10-24): a phone no Account carries is
# no longer a fork with its own view — the door's one honest refusal.
# Accounts stay Admin-issued (ADR-0013), so the answer names the fact
# the caller can act on: this number is not in the system.
OTP_UNKNOWN_PHONE_404_DETAIL = "این شماره در کتاب و همراه ثبت نشده است."
# The برنامک's own refusals (ADR-0021, DRAFT display vocabulary
# pending PM approval — the CONTEXT.md draft row carries them): the
# initData that fails the signature or the freshness bound refuses
# one way — a tampered string and a stale one are never told apart —
# and an unconfigured bot answers its own honest note. The link form's
# bad credentials reuse AUTH_BAD_CREDENTIALS_DETAIL verbatim: the
# ADR-0013 rule that an unknown email and a wrong password are never
# an attacker's to tell apart holds at every door.
EITAA_AUTH_401_DETAIL = (
    "ورود از ایتا تأیید نشد؛ برنامه را از داخل ایتا باز کنید."
)
EITAA_NOT_CONFIGURED_503_DETAIL = "برنامک ایتا روی این سرور تنظیم نشده است."
# The server→user push (ADR-0021): the settle that lands while the
# operator is away rides eitaayar.ir's sendMessage to every Eita user
# the Account has bound. Opt-in by env and off by default — the daily
# message quota is Eita's, not ours, and the push is a bell, never a
# record (the events law).
EITAA_PUSH_ENABLED_ENV = "EITAA_PUSH_ENABLED"
EITAA_PUSH_SETTLED_TEXT = "پاسخ نشست شما آماده شد؛ از برنامک ادامه دهید."
AUTH_BAD_ACCOUNT_BODY_DETAIL = (
    "ایمیل و گذرواژهٔ حساب را بفرستید (گذرواژه خالی نباشد)."
)
# The console's write side (T26, GitLab #28): the forms POST
# form-encoded bodies and get a 303 back to the page, so a refused
# write re-renders the console with its Farsi note — one whitelisted
# error code in the query string, never user text in a URL.
ADMIN_ERROR_BAD_BODY = "bad_body"
ADMIN_ERROR_BAD_PHONE = "bad_phone"
ADMIN_ERROR_EMAIL_TAKEN = "email_taken"
ADMIN_ERROR_BAD_AMOUNT = "bad_amount"
ADMIN_ERROR_UNKNOWN_ACCOUNT = "unknown_account"
ADMIN_ERROR_NOTES = {
    ADMIN_ERROR_BAD_BODY: "ایمیل و گذرواژهٔ حساب را بفرستید (گذرواژه خالی نباشد).",
    ADMIN_ERROR_BAD_PHONE: "شمارهٔ تلفن همراه را وارد کنید.",
    ADMIN_ERROR_EMAIL_TAKEN: "این ایمیل پیش‌تر حساب گرفته است.",
    ADMIN_ERROR_BAD_AMOUNT: "مقدار شارژ را به تومان و مثبت وارد کنید.",
    ADMIN_ERROR_UNKNOWN_ACCOUNT: "حسابی با این ایمیل نیست.",
}

# The profile's honesty badges (T24, GitLab #27) — DRAFT display
# vocabulary, pending PM approval (2026-09-19, CONTEXT.md's draft
# roster discipline): the two labels that keep an estimate from ever
# rendering as a measurement. They live here in ONE constant pair and
# ride the /profile/data payload per entry, so the PM's approval
# renames them in one line and the sheet never decides what counts as
# measured (index.html documents the same strings in its own DRAFT
# comment — the tests lock the two together).
PROFILE_METERED_BADGE = "اندازه‌گیری‌شده"
PROFILE_ESTIMATED_BADGE = "تخمینی"

# The 429 refusal names the reopen time in Farsi digits (issue #23) —
# the server-side twin of the sheet's toPersianDigits, so the prose and
# the counter render the same clock.
_PERSIAN_DIGITS = str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")

# The generated-once-per-process secret lives here; auth_secret() reads
# the env on every call so a test (or an operator) that pins
# AUTH_SECRET always wins over a cached value.
_GENERATED_AUTH_SECRET = None


def auth_secret() -> bytes:
    """The token-signing secret: AUTH_SECRET from the env when pinned,
    otherwise one random secret generated once per process — with a
    Farsi warning, because a per-process secret invalidates every
    outstanding login at restart and the operator must know that. The
    tests pin AUTH_SECRET so the client and server sign alike."""
    global _GENERATED_AUTH_SECRET
    pinned = os.environ.get("AUTH_SECRET", "")
    if pinned:
        return pinned.encode("utf-8")
    if _GENERATED_AUTH_SECRET is None:
        _GENERATED_AUTH_SECRET = secrets.token_hex(32)
        sys.stderr.write(
            "هشدار: AUTH_SECRET تنظیم نشده است؛ یک کلید موقت فقط برای "
            "همین اجرا ساخته شد — با هر بازراه‌اندازی همه باید دوباره "
            "وارد شوند. (ADR-0013)\n"
        )
    return _GENERATED_AUTH_SECRET.encode("utf-8")


def audit_quiet(action: str, actor_email, detail) -> None:
    """One audit append that never breaks the action it records (T26's
    shared shape): the log records what HAPPENED, so it rides AFTER the
    store said yes — and a broken audit store must not un-issue an
    Account or un-top a Balance. The failure stays loud on stderr,
    never silent, and the action stands."""
    try:
        audit.append(action, actor_email=actor_email, detail=detail)
    except Exception as exc:
        sys.stderr.write(
            f"audit append failed for {action}: {exc!r}\n"
        )


def ensure_first_admin_from_env() -> None:
    """The first Admin from config (T26, GitLab #28 — the bootstrap
    seed command retired): compose env carries ADMIN_EMAIL and
    ADMIN_PASSWORD; the server creates that Admin once at startup and
    records it in the audit log (the deployment's act is history too).
    When an Admin already stands — or either variable is empty, or the
    email is taken — nothing is touched and the skip is loud on
    stderr: a restart must never quietly re-issue the PM's password,
    and the console never mutates silently, at startup included."""
    email = os.environ.get("ADMIN_EMAIL", "").strip()
    password = os.environ.get("ADMIN_PASSWORD", "")
    if not email or not password:
        return
    if ensure_admin(email, password):
        credit_balance(email, 999_999_999_999)
        audit_quiet(audit.ADMIN_SEEDED, actor_email=email, detail={"email": email})
        sys.stderr.write(
            f"مدیر نخستین از ADMIN_EMAIL ساخته شد ({email}) و در "
            "دفتر رخدادها ثبت شد.\n"
        )
    elif not admins_exist():
        sys.stderr.write(
            f"ADMIN_EMAIL ({email}) پیش‌تر به یک حساب دیگر رسیده است؛ "
            "مدیری ساخته نشد.\n"
        )
    else:
        sys.stderr.write(
            "مدیری از پیش وجود دارد؛ ADMIN_EMAIL/ADMIN_PASSWORD نادیده "
            "گرفته شد — گذرواژهٔ کسی بی‌کنش عوض نمی‌شود.\n"
        )


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def issue_token(email: str, role: str, now: float = None) -> str:
    """One signed login token — payload.signature, both URL-safe. The
    expiry rides inside the signed payload so a client cannot extend
    it; `now` is the injected clock the tests pin (the TurnBudget
    pattern), never read from env."""
    payload = {
        "email": email,
        "role": role,
        "exp": int((time.time() if now is None else now) + AUTH_TOKEN_TTL),
    }
    body = _b64url_encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    )
    signature = hmac.new(
        auth_secret(), body.encode("ascii"), hashlib.sha256
    ).hexdigest()
    return f"{body}.{signature}"


def verify_token(token: str):
    """The signed payload {email, role}, or None. An unsigned, tampered,
    malformed, or expired token — and a signature that merely fails to
    compare — all refuse the same way: the caller answers one 401 and
    never distinguishes why."""
    if not isinstance(token, str) or token.count(".") != 1:
        return None
    body, _, signature = token.partition(".")
    expected = hmac.new(
        auth_secret(), body.encode("ascii"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        payload = json.loads(_b64url_decode(body))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or exp < time.time():
        return None
    email, role = payload.get("email"), payload.get("role")
    if not isinstance(email, str) or not email or not isinstance(role, str):
        return None
    return {"email": email, "role": role}


def _request_token(handler):
    """The request's own token (ADR-0020): the HttpOnly cookie first —
    the sheet's credential — then the Authorization: Bearer header,
    the native clients' (the Expo app stores the login token in the
    device's secure store and rides it on every call). One verify path
    for both: the header never authenticates anything the cookie
    wouldn't, and a Bearer string that is unsigned, expired, or
    tampered refuses exactly like a bad cookie."""
    token = handler._cookie_token()
    if token:
        return token
    header = handler.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        return header[len("Bearer ") :].strip()
    return ""


DEV_ACCOUNT_EMAIL = "dev@local"


def is_login_disabled() -> bool:
    """Whether authentication is bypassed for local dev/preview —
    OPT-IN ONLY (DISABLE_LOGIN=1, said out loud in the dev machine's
    own .env). Unset — the production shape — keeps every door gated
    (ADR-0013; F-001 of the 2026-10-24 review): an open default here
    silently maps every anonymous stranger onto the dev Account, which
    carries the admin role and a near-infinite Balance."""
    return os.environ.get("DISABLE_LOGIN") == "1"


def _ensure_dev_account():
    """Ensure a local dev account exists when login is bypassed."""
    try:
        from ui import accounts
    except ImportError:
        import accounts
    acc = accounts.account_by_email(DEV_ACCOUNT_EMAIL)
    if acc is None:
        accounts.create_account(DEV_ACCOUNT_EMAIL, "dev", "09123456789", "admin")
        accounts.credit_balance(DEV_ACCOUNT_EMAIL, 999_999_999_999)
        accounts.save_profile(
            DEV_ACCOUNT_EMAIL,
            {"usage_purpose": "academic", "subscription": {"active": True}},
        )
        acc = accounts.account_by_email(DEV_ACCOUNT_EMAIL)
    return acc


def resolve_identity(handler):
    """The gate flip (ADR-0013), finished (T21, GitLab #23): the
    Account's EMAIL — the identity every store now keys by — derived
    from the cwb_auth cookie, or None after answering the request.

    Every endpoint that once read the client-supplied phone header goes
    through here; the header no longer authenticates anything. An
    absent, invalid, expired, or tampered token (and a token whose
    Account no longer exists) answers 401. The old no-attached-phone
    403 is retired with the phone-keyed stores: an Account without
    attached legacy history is a working Account — it chats, it spends,
    it is bounded by its quota and Balance like any other. The attached
    phone survives as legacy data only: the mapping the Admin's attach
    flow gives ui/migrate.py to carry pre-T21 rows onto their Accounts.
    Neither answer ever crashes: the gate's rejections keep the
    drain-first shape so the response never dies to a reset."""
    claims = verify_token(_request_token(handler))
    if claims is not None:
        account = account_by_email(claims["email"])
    else:
        account = None
    if account is None:
        if is_login_disabled():
            dev = _ensure_dev_account()
            if dev is not None:
                return dev["email"]
        handler._json_error(401, AUTH_LOGIN_401_DETAIL)
        return None
    return account["email"]


def resolve_account(handler):
    """The auth-level identity (no phone required): the Account row
    behind the cookie, or None without answering — /auth/me turns None
    into the 401, the Admin-only account creation turns it into the
    same 401 before its role check."""
    claims = verify_token(_request_token(handler))
    if claims is None:
        if is_login_disabled():
            return _ensure_dev_account()
        return None
    acc = account_by_email(claims["email"])
    if acc is None and is_login_disabled():
        return _ensure_dev_account()
    return acc


# The live line (ADR-0020): one in-process hub — per-Account subscriber
# queues, the turn registry's shape. A restart empties it; the client
# reconnects (EventSource reconnects by itself) and nothing is lost:
# the stores, not the stream, are the truth.
_EVENT_LOCK = threading.Lock()
_EVENT_CLIENTS = {}
_EVENT_HEARTBEAT = 20.0


def _publish_event(account: str, kind: str, **payload) -> None:
    """Fan one settle out to the Account's live lines. Never raises —
    a vanished subscriber must not break the reply that produced the
    news (the store-failure rule)."""
    event = json.dumps({"kind": kind, **payload}, ensure_ascii=False)
    with _EVENT_LOCK:
        clients = list(_EVENT_CLIENTS.get(account, ()))
    for client in clients:
        try:
            client.put_nowait(event)
        except Exception:
            pass


def _eitaa_push(account: str, text: str) -> None:
    """The settle's second bell (ADR-0021): when the env opts in, the
    Account's bound Eita users hear the news through eitaayar.ir's
    sendMessage. Off by default (Eita's daily quota is not ours to
    spend), never raising, never blocking the reply that produced the
    news — a platform outage costs a bell, never the answer."""
    enabled = str(os.environ.get(EITAA_PUSH_ENABLED_ENV, "") or "").strip().lower()
    if enabled not in ("1", "true", "yes", "on"):
        return
    try:
        eitaa.push_to_account(account, text)
    except Exception:
        pass


def _eitaa_refusal_diagnostic(raw: str) -> tuple[str, str]:
    """The refused exchange's verdict: try a battery of check-string
    constructions (raw/decoded pairs, with and without device_id and
    query_id, newline or ampersand joins, canonical re-serialized user
    JSON) against four key derivations, and report ONLY which
    candidate matched the carried hash — never a single value. A
    NO-CANDIDATE verdict after the structure is known-good (the doc
    param set) names the credential itself as the stranger, which is
    exactly what 2026-10-20's wrong-token hunt needed stated in
    writing."""
    from urllib.parse import quote

    pieces = {}
    for p in raw.split("&"):
        if "=" in p:
            key, value = p.split("=", 1)
            pieces[key] = value
    received = pieces.get("hash", "")
    shape = " ".join(
        f"{p.split('=', 1)[0]}:{len(p)}" for p in sorted({p for p in raw.split("&") if p})
    )
    if not received:
        return shape, "no-hash-carried"
    token = eitaa.bot_token()
    decoded = eitaa.parse_init_data(raw)

    forms = {}

    def collect(tag, items):
        forms[f"{tag} nl"] = "\n".join(sorted(items))
        forms[f"{tag} amp"] = "&".join(sorted(items))

    collect("raw", [f"{k}={v}" for k, v in pieces.items() if k != "hash"])
    collect("decoded", [f"{k}={v}" for k, v in decoded.items() if k != "hash"])
    collect(
        "raw-no-device",
        [f"{k}={v}" for k, v in pieces.items() if k not in ("hash", "device_id")],
    )
    collect(
        "raw-no-query",
        [f"{k}={v}" for k, v in pieces.items() if k not in ("hash", "query_id")],
    )
    collect(
        "decoded-no-device",
        [f"{k}={v}" for k, v in decoded.items() if k not in ("hash", "device_id")],
    )
    collect(
        "decoded-no-query",
        [f"{k}={v}" for k, v in decoded.items() if k not in ("hash", "query_id")],
    )
    if "user" in decoded:
        try:
            parsed_user = json.loads(decoded["user"])
        except ValueError:
            parsed_user = None
        if isinstance(parsed_user, dict):
            for ascii_flag, tag in ((False, "utf8"), (True, "ascii")):
                canon = json.dumps(
                    parsed_user, ensure_ascii=ascii_flag, separators=(",", ":")
                )
                others_raw = [f"{k}={v}" for k, v in pieces.items() if k not in ("hash", "user")]
                others_dec = [f"{k}={v}" for k, v in decoded.items() if k not in ("hash", "user")]
                collect(f"raw-user-{tag}", others_raw + ["user=" + quote(canon, safe="")])
                collect(f"dec-user-{tag}", others_dec + [f"user={canon}"])

    keys = {
        "k-webappdata": hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest(),
        "k-rawtoken": token.encode(),
        "k-swapped": hmac.new(token.encode(), b"WebAppData", hashlib.sha256).digest(),
        "k-shatoken": hashlib.sha256(token.encode()).digest(),
    }
    for fname, form in forms.items():
        for kname, key in keys.items():
            hexdigest = hmac.new(key, form.encode("utf-8"), hashlib.sha256).hexdigest()
            if hmac.compare_digest(hexdigest, received):
                return shape, f"MATCH: {fname} with {kname}"
    return shape, "NO-CANDIDATE (the credential itself is the stranger)"


def validated_datasets(raw):
    """The ask's Book selection (ADR-0010): the client's list
    intersected with the Book set, in the set's stable order — a name
    outside the Book set never reaches an upstream. None (missing,
    malformed, or nothing left) means the whole Book set, the shape
    every searcher already treats as the default."""
    if not isinstance(raw, list):
        return None
    picked = {item for item in raw if isinstance(item, str) and item in BOOK_DATASETS}
    if not picked:
        return None
    return [dataset for dataset in BOOK_DATASETS if dataset in picked]


# The follow-up thread's budget (ADR-0015): the sitting's recent turns
# ride as framing only — a short question (at most this many words) is
# what gets rewritten, and each earlier answer contributes a capped
# connective text, so the prompts stay small.
REWRITE_MAX_WORDS = 8
_TAIL_TURNS = 3
_TAIL_ANSWER_CHARS = 400


def _article_connective_text(payload) -> str:
    """A stored assistant payload's own writing — the blocks' text
    parts only. The quote parts are the passages' job (the writer
    re-copies them verbatim from the sources), so they never ride the
    tail; the connective text is what tells the rewriter and the
    phase-2 writer what the sitting has already covered."""
    if not isinstance(payload, dict):
        return ""
    parts: list[str] = []
    for block in payload.get("blocks") or []:
        if not isinstance(block, dict) or block.get("type") != "paragraph":
            continue
        for part in block.get("parts") or []:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"].strip())
    return " ".join(p for p in parts if p)[:_TAIL_ANSWER_CHARS]


def _conversation_tail(account: str, session_id) -> str:
    """The sitting's recent turns (the Session store's own rows, the
    same transcript the resume renders) as one context string — the
    last few ask/answer pairs, oldest first. The follow-up rewrite and
    the phase-2 framing read it; everything about it fails soft: no
    sitting, an unreadable store, or no turns answer an empty string
    and the callers ride without context."""
    if not isinstance(session_id, int):
        return ""
    try:
        session = session_store.get_session(account, session_id)
    except Exception:
        return ""
    if not session:
        return ""
    lines: list[str] = []
    for message in session.get("messages") or []:
        if not isinstance(message, dict):
            continue
        payload = message.get("payload")
        if message.get("role") == "user":
            text = payload.get("text") if isinstance(payload, dict) else None
            if isinstance(text, str) and text.strip():
                lines.append(f"Q: {text.strip()[:_TAIL_ANSWER_CHARS]}")
        else:
            text = _article_connective_text(payload)
            if text:
                lines.append(f"A: {text}")
    return "\n".join(lines[-_TAIL_TURNS * 2 :])


# The pages index's gzip cache (ADR-0017): the per-Book text index
# shrinks ~6x on the wire but re-compressing it per request spends CPU
# on every reader open — the compressed bytes live here keyed by the
# file's mtime, so an unchanged index compresses exactly once. (The
# mtime key makes a re-indexed Book re-compress for free.)
_GZIP_CACHE: dict[tuple[str, int], bytes] = {}


def _gzipped_file(file_path: Path, mtime_ns: int) -> bytes:
    key = (str(file_path), mtime_ns)
    body = _GZIP_CACHE.get(key)
    if body is None:
        body = gzip.compress(file_path.read_bytes(), compresslevel=6)
        _GZIP_CACHE.clear()  # one Book's index at a time — the files are few
        _GZIP_CACHE[key] = body
    return body


# The UI statics' gzip cache: the mobile face rides ~30 small modules and
# styles down a slow path; compressed they ship ~4x smaller, and the
# compressed bytes are cached by mtime so an unchanged file compresses
# once. Capped (unlike the Book index's one-slot cache) because the set
# is many small files that all deserve to stay warm.
_STATIC_GZIP_CACHE: dict[tuple[str, int], bytes] = {}


def _static_gzip(file_path: Path, mtime_ns: int) -> bytes:
    key = (str(file_path), mtime_ns)
    body = _STATIC_GZIP_CACHE.get(key)
    if body is None:
        body = gzip.compress(file_path.read_bytes(), compresslevel=6)
        if len(_STATIC_GZIP_CACHE) >= 64:
            _STATIC_GZIP_CACHE.clear()
        _STATIC_GZIP_CACHE[key] = body
    return body


# modulepreload's list: the STATIC import closure of the page's module
# entry scripts, so the browser learns every module URL at HTML parse
# instead of discovering them wave by wave (the recorded waterfall: five
# serialized rounds, each paying the path's ~1.2s latency — SI 18s).
# Dynamic import() calls are deliberately NOT matched: the PDF engine
# stays off the anonymous boot. The scan is conservative — statements
# that START a line with `import` — matching the hand-written modules;
# a missed import only loses its preload, never its execution.
_MODULE_IMPORT_RE = re.compile(
    r"(?m)^[ \t]*import[ \t]+(?:[^;'\"]*?[ \t]from[ \t]*)?['\"]([^'\"]+)['\"]"
)
_MODULE_SRC_RE = re.compile(
    r"<script[^>]*\btype=\"module\"[^>]*\bsrc=\"([^\"]+)\"[^>]*>"
)


def _module_graph(entry_urls: list[str]) -> tuple[list[str], int]:
    """(preload URLs, fingerprint) for the page's module entries — the
    URLs in document order excluding the entries themselves (the script
    tags already fetch those), plus an mtime fingerprint of every file
    walked so the page's ETag changes when any module in the graph
    changes, not just the HTML."""
    ordered: list[str] = []
    seen: set[str] = set()
    fingerprint = 0

    def scan(url: str) -> None:
        nonlocal fingerprint
        if url in seen:
            return
        seen.add(url)
        file_path = UI_DIR / url.lstrip("/")
        try:
            stat = file_path.stat()
            text = file_path.read_text(encoding="utf-8")
        except OSError:
            return
        fingerprint = (fingerprint + stat.st_mtime_ns) & 0xFFFFFFFFFFFF
        for spec in _MODULE_IMPORT_RE.findall(text):
            if not spec.startswith(("/", "./", "../")) or not spec.endswith(".mjs"):
                continue  # bare specifiers never resolve in the browser
            resolved = urljoin(url, spec)
            if resolved not in seen:
                scan(resolved)

    for entry in entry_urls:
        scan(entry)
    entries = set(entry_urls)
    return [url for url in seen if url not in entries], fingerprint


# The page's own stylesheet links — the render-blocking set _mobile_page
# inlines, so the HTML carries the CSS and first paint waits on ONE
# request instead of six (the 2026-10-24 pass: the 6 CSS files were the
# only FAIL left, ~300ms each under throttling). The files stay the
# source of truth on disk; only the wire shape changes.
_STYLESHEET_LINK_RE = re.compile(
    r'<link rel="stylesheet" href="(/[^"]+\.css)">'
)


def _inline_stylesheets(page: str) -> str:
    """The mobile page with its local stylesheet links replaced by the
    stylesheets themselves. Same-origin absolute paths only — anything
    else (a future CDN link, a query string) stays a link, untouched."""
    pieces: list[str] = []
    cursor = 0
    for match in _STYLESHEET_LINK_RE.finditer(page):
        file_path = UI_DIR / match.group(1).lstrip("/")
        try:
            css = file_path.read_text(encoding="utf-8")
        except OSError:
            continue  # a missing sheet keeps its link and the 404 says so
        pieces.append(page[cursor : match.start()])
        pieces.append(f"<style>{css}</style>")
        cursor = match.end()
    if not pieces:
        return page
    pieces.append(page[cursor:])
    return "".join(pieces)


# The static types worth gzipping (the UI's own text assets; PDFs, MP3s
# and rasters ride their own routes, fonts and bcmaps are already
# compressed payloads).
_GZIP_SUFFIXES = frozenset(
    {".html", ".css", ".js", ".mjs", ".json", ".webmanifest", ".svg", ".txt"}
)


class SessionHandler(SimpleHTTPRequestHandler):
    # The PWA's and the reader's static types, pinned (ADR-0019):
    # SimpleHTTPRequestHandler falls back to mimetypes, and on Windows
    # mimetypes consults the registry — a registry that answers
    # text/plain for .js kills every service-worker registration (the
    # worker must ride a JavaScript type) and a wrong .webmanifest type
    # kills the install. The pinned types leave no registry in the path.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".webmanifest": "application/manifest+json",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(UI_DIR), **kwargs)

    def log_message(self, format, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    # The security headers (F-004 of the 2026-10-24 review): every
    # response carries nosniff, a no-referrer promise, and a CSP — the
    # sheet is same-origin everything (vendored pdf.js, self-hosted
    # fonts, no CDN), so 'self' with 'unsafe-inline' for the inline
    # scripts/styles the single-file pages carry is the honest shape.
    # The برنامک's own surfaces (/mobile, /eitaa) skip the frame
    # protection: a Telegram-style desktop client may open the
    # mini-app in an iframe, and DENY there would blank it — nowhere
    # else frames this server, and the admin console least of all.
    _SECURITY_CSP = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "media-src 'self' blob:; "
        "font-src 'self'; "
        "connect-src 'self'; "
        "worker-src 'self' blob:; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "object-src 'none'"
    )
    _FRAMEABLE_PATHS = ("/mobile", "/eitaa")

    def end_headers(self) -> None:
        # The sheet is an evolving single page: every load must revalidate,
        # never render a stale cached copy after a deploy (a plain refresh
        # kept showing the pre-tab page after the 2026-09-11 switchover).
        # Immutable assets (page rasters) override the policy per response.
        self.send_header(
            "Cache-Control",
            getattr(self, "_cache_policy", None) or "no-cache",
        )
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        path = (self.path or "").split("?", 1)[0]
        if path.startswith(self._FRAMEABLE_PATHS):
            self.send_header("Content-Security-Policy", self._SECURITY_CSP)
        else:
            self.send_header(
                "Content-Security-Policy",
                self._SECURITY_CSP + "; frame-ancestors 'none'",
            )
            self.send_header("X-Frame-Options", "DENY")
        # The CORS stamps (ADR-0020): only for a browser Origin on the
        # env's allowlist, and only ever TO that origin — no allowlist,
        # no stamps, the recorded production shape.
        origin = self.headers.get("Origin", "") if self.headers else ""
        if origin and origin in allowed_origins():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header(
                "Access-Control-Allow-Headers", "Content-Type, Authorization"
            )
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE")
        super().end_headers()

    def do_OPTIONS(self):
        # The browser clients' preflight (ADR-0020): the allowlisted
        # origin's stamps ride end_headers; anything else answers a
        # bare 204 — a preflight is a question about access, not an
        # access itself.
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        # The designed mobile UI is the REAL app (app.mjs: login,
        # sessions, chat, notes, the reader) — the face the Eita
        # برنامک opens too. The old design preview keeps its own door.
        if path.startswith("/docs/design/mobile-preview/"):
            self.path = self.path.replace(
                "/docs/design/mobile-preview/", "/mobile/preview.html", 1
            )
            path = self.path.split("?", 1)[0]
        if path in ("/mobile/", "/mobile/index.html"):
            self._mobile_page("mobile/index.html")
            return
        if path in ("/eitaa", "/eitaa/"):
            # The retired برنامک page's address: a permanent redirect
            # to the mobile face the operator chose instead.
            self.send_response(301)
            self.send_header("Location", "/mobile/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/reader/narration/status":
            if resolve_identity(self) is None:
                return
            try:
                from ui.narration import narration_status
            except ImportError:
                from narration import narration_status
            self._send_json(200, narration_status())
            return
        if path.startswith("/books/") and "/lectures/" in path and path.endswith(".mp3"):
            self._lecture_audio(path)
            return
        if path.startswith("/books/") and "/lectures" in path:
            # Lecture read-along (ui/lectures.py): session timings, page
            # boxes and the recorded audio — the Account's read, like the
            # narration status above.
            if resolve_identity(self) is None:
                return
            try:
                from ui import lectures
            except ImportError:
                import lectures
            if lectures.handle(self, path, BOOKS_DIR, BOOK_DATASETS):
                return
            self.send_error(404, "Not found")
            return
        if path.startswith("/books/") and "/page/" in path:
            self._book_page_image(path)
            return
        if path == "/livez":
            # Local liveness for the container healthcheck — the sheet's
            # /health proxies to Cognee and would couple this container's
            # health to another service's.
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/auth/me":
            # The whoami read (ADR-0013): open to reach — an anonymous
            # call gets the 401 that shows the sheet's login overlay.
            self._auth_me()
            return
        if path == "/health":
            self._proxy("GET")
            return
        if path == "/research/turn":
            self._research_turn_status()
            return
        if path == "/research/state":
            self._research_state()
            return
        if path == "/research/messages":
            self._research_messages()
            return
        if path == "/research/report":
            self._research_report()
            return
        if path == "/usage/live":
            self._usage_live()
            return
        if path == "/chat/latest":
            self._chat_latest()
            return
        if path == "/ota":
            self._ota_manifest()
            return
        if path.startswith("/ota/current/"):
            self._ota_asset(path)
            return
        if path == "/events":
            self._events()
            return
        if path == "/admin":
            # The «میز مدیریت» (T25): the Admin's server-rendered
            # mirror of the system — a read, never a mutation.
            self._admin_console()
            return
        if path == "/admin/requests":
            self._admin_requests_list()
            return
        if path.startswith("/admin/requests/"):
            rest = path[len("/admin/requests/"):]
            if not rest:
                self._json_error(404, "شناسه درخواست یافت نشد")
                return
            if rest.endswith("/trace.json"):
                req_id = rest[:-len("/trace.json")]
                self._admin_request_json(req_id)
            else:
                self._admin_request_detail(rest)
            return
        if path == "/profile/data":
            self._profile_data()
            return
        if path == "/api/user/profile":
            self._user_profile_get()
            return
        if path == "/sessions":
            # The Session store's list (T27 stage 3, GitLab #40): the
            # sidebar's read, the caller's own Sessions only.
            self._sessions_list()
            return
        if path == "/notes":
            # The Notebook's read (the selection map, ticket 08): the
            # panel's list, the caller's own notes only.
            self._notes_list()
            return
        if path.startswith("/sessions/"):
            rest = path[len("/sessions/"):]
            if rest.isdigit():
                self._session_get(int(rest))
                return
        if path == "/agent/chat/history":
            self._agent_chat_history()
            return
        if path.startswith("/books/") and "/lectures/" in path:
            self._lecture_audio(path)
            return
        if path.endswith(".lectures.summary.json"):
            self._lectures_summary(path)
            return
        if path.startswith("/books/"):
            if "/lectures" in path:
                self._book_lectures(path)
                return
            self._book_file(path)
            return
        if self._serve_static(path):
            return
        super().do_GET()

    def _serve_static(self, path: str) -> bool:
        """The UI's own static files (the mobile face's modules and
        styles, the fonts, the icons): gzipped when the client accepts
        it and always revalidatable — the same ETag + 304 pair the Book
        route established (ADR-0017), so a redeploy is picked up on the
        next load (the 2026-09-11 stale-page law) while an unchanged
        file costs one stat and a bodyless 304. Returns False for
        anything that is not a plain file (directories, misses, Range
        requests) so SimpleHTTPRequestHandler keeps its old answer."""
        if path.endswith("/"):
            return False
        file_path = Path(self.translate_path(path))
        try:
            stat = file_path.stat()
        except OSError:
            return False
        if not S_ISREG(stat.st_mode) or self.headers.get("Range"):
            return False
        etag = f'"{stat.st_size:x}-{stat.st_mtime_ns:x}"'
        self._cache_policy = "public, max-age=0, must-revalidate"
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return True
        body = None
        if (
            file_path.suffix.lower() in _GZIP_SUFFIXES
            and stat.st_size >= 600
            and "gzip" in (self.headers.get("Accept-Encoding") or "")
        ):
            body = _static_gzip(file_path, stat.st_mtime_ns)
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(file_path))
        self.send_header("ETag", etag)
        if body is not None:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        else:
            body = file_path.read_bytes()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return True

    def _lectures_summary(self, path: str) -> None:
        """The player's slim index (GET
        /books/<dataset>.lectures.summary.json): one row per session —
        number, audio file, duration, the «بدون مقدمه» boundaries,
        pages — a few KB instead of the 45MB alignment file, which only
        the word-level sync will ever need to download. The dataset
        must be in the Book set; an absent package answers 404.
        Account-gated (F-001 of the 2026-10-24 review): the Book set is
        the paying Customer's content — every /books surface speaks
        only to a logged-in Account now."""
        if resolve_identity(self) is None:
            return
        match = re.fullmatch(r"/books/([A-Za-z0-9_-]+)\.lectures\.summary\.json", path)
        if not match or match.group(1) not in BOOK_DATASETS:
            self._drain_request_body()
            self.send_error(404, "Not found")
            return
        summary = lectures_summary(match.group(1))
        if summary is None:
            self._drain_request_body()
            self.send_error(404, "Not found")
            return
        body = json.dumps(summary, ensure_ascii=False).encode("utf-8")
        self._cache_policy = "private, max-age=300"
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _book_lectures(self, path: str) -> None:
        """Lecture audio manifests, session timing data, and Range-enabled audio streaming."""
        account = resolve_identity(self)
        if account is None:
            return
        lectures_match = re.fullmatch(r"/books/([A-Za-z0-9_-]+)/lectures(?:/(\d+)(?:/(audio))?)?", path)
        if not lectures_match:
            self._drain_request_body()
            self.send_error(404, "Not found")
            return
        book_id = lectures_match.group(1)
        session_str = lectures_match.group(2)
        is_audio = bool(lectures_match.group(3))
        if book_id not in BOOK_DATASETS:
            self._drain_request_body()
            self.send_error(404, "Not found")
            return
        ext_dir = os.environ.get("LECTURE_AUDIO_DIR")
        if not session_str:
            summary = lectures.load_lectures_summary(BOOKS_DIR, book_id, ext_dir)
            if summary is None:
                self._drain_request_body()
                self.send_error(404, "Not found")
                return
            self._send_json(200, summary)
            return
        session_num = int(session_str)
        if not is_audio:
            session_data = lectures.get_session_data(BOOKS_DIR, book_id, session_num, ext_dir)
            if session_data is None:
                self._drain_request_body()
                self.send_error(404, "Not found")
                return
            self._send_json(200, session_data)
            return
        audio_file = lectures.get_session_audio_file(BOOKS_DIR, book_id, session_num, ext_dir)
        if audio_file is None or not audio_file.is_file():
            self._drain_request_body()
            self.send_error(404, "Not found")
            return
        lectures.stream_audio_range(self, audio_file, head=False)

    def _book_file(self, path: str) -> None:
        """One Book asset — ``/books/<dataset>/book`` (the PDF, for the
        reader), ``/books/<dataset>.pdf`` (the download form), or the
        ``.pages.json`` text index (the reader's provenance surface,
        ADR-0007). The dataset must be one of the Book set: the allowlist
        is the path-traversal guard, so no ``..`` or hash directory can
        ever reach the filesystem. HTTP Range is honored byte-for-byte
        (pdf.js fetches a Book's pages lazily with disableAutoFetch,
        ADR-0017), and the full-form answers carry an ETag + 304
        revalidation so reopening a Book never refetches it whole.

        The reader fetches the extension-less ``/book`` form on purpose:
        download managers (IDM among them) intercept requests whose URL
        ends in ``.pdf`` and answer the page with an empty takeover —
        the recorded 204 that left the reader dark (2026-09-13).

        Account-gated (F-001): the Book set is the paying Customer's
        content — the PDF, the full-text index, the lecture alignment —
        so an anonymous caller is the standard 401 before the route
        even looks at a name. The browser clients ride the HttpOnly
        cookie (same-origin fetches carry it, pdf.js's Range requests
        included); the native clients' <img>/<audio> fetches ride the
        cookie /auth/me re-plants for a Bearer holder."""
        if resolve_identity(self) is None:
            return
        book = re.fullmatch(
            r"/books/([A-Za-z0-9_-]+?)(/book|\.pdf|\.lectures\.json)", path
        )
        index = re.fullmatch(r"/books/([A-Za-z0-9_-]+)\.pages\.json", path)
        if book:
            dataset = book.group(1)
            if book.group(2) == ".lectures.json":
                # The lecture index (sessions, word timings, page boxes)
                # rides beside the PDF it aligns to — ~45MB of measured
                # data, box-side only, rsync-excluded like the PDFs.
                suffix, content_type = (
                    "lectures.json",
                    "application/json; charset=utf-8",
                )
            else:
                suffix, content_type = ("pdf", "application/pdf")
        elif index:
            dataset, suffix, content_type = (
                index.group(1),
                "pages.json",
                "application/json; charset=utf-8",
            )
        else:
            dataset = None
        if not dataset or dataset not in BOOK_DATASETS:
            self._drain_request_body()
            self.send_error(404, "Not found")
            return
        file_path = BOOKS_DIR / f"{dataset}.{suffix}"
        try:
            stat = file_path.stat()
            total_size = stat.st_size
        except OSError:
            self._drain_request_body()
            self.send_error(404, "Not found")
            return

        range_header = self.headers.get("Range")
        if range_header and range_header.startswith("bytes="):
            try:
                range_val = range_header[6:].strip()
                if "-" in range_val:
                    part_start, part_end = range_val.split("-", 1)
                    if not part_start:
                        length = int(part_end)
                        start = max(0, total_size - length)
                        end = total_size - 1
                    else:
                        start = int(part_start)
                        end = int(part_end) if part_end else total_size - 1
                else:
                    start = int(range_val)
                    end = total_size - 1

                if start >= total_size or start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{total_size}")
                    self.end_headers()
                    return

                end = min(end, total_size - 1)
                chunk_len = end - start + 1

                self.send_response(206)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Range", f"bytes {start}-{end}/{total_size}")
                self.send_header("Content-Length", str(chunk_len))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("ETag", f'"{total_size:x}-{stat.st_mtime_ns:x}"')
                self.end_headers()

                with file_path.open("rb") as f:
                    f.seek(start)
                    remaining = chunk_len
                    while remaining > 0:
                        chunk = f.read(min(remaining, 64 * 1024))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                return
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception:
                pass

        try:
            # The revalidation pair (ADR-0017): a strong ETag off the
            # file's own stat, and a must-revalidate policy — the
            # browser re-asks on every reader open and a 304 answer
            # costs one stat, where the old unconditioned 200 refetched
            # the whole 16 MB Book each time. Range requests (pdf.js's
            # lazy page fetches with disableAutoFetch) carry the ETag
            # too but never take the 304 short-circuit.
            etag = f'"{total_size:x}-{stat.st_mtime_ns:x}"'
            if (
                not range_header
                and self.headers.get("If-None-Match") == etag
            ):
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header(
                    "Cache-Control", "private, max-age=0, must-revalidate"
                )
                self.end_headers()
                return
            gzip_wanted = (
                suffix == "pages.json"
                and "gzip" in (
                    self.headers.get("Accept-Encoding") or ""
                )
            )
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("ETag", etag)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header(
                "Cache-Control", "private, max-age=0, must-revalidate"
            )
            if suffix == "pdf" and path.endswith(".pdf"):
                self.send_header(
                    "Content-Disposition",
                    f'attachment; filename="{dataset}.pdf"',
                )
            if gzip_wanted:
                body = _gzipped_file(file_path, stat.st_mtime_ns)
                self.send_header("Content-Encoding", "gzip")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_header("Content-Length", str(total_size))
            self.end_headers()

            with file_path.open("rb") as f:
                while chunk := f.read(64 * 1024):
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return

    _PAGE_WIDTH_RE = re.compile(r"/books/([A-Za-z0-9_-]+)/page/(\d{1,4})\.png$")

    def _lecture_audio(self, path: str) -> None:
        """One lecture session's MP3 (the کتاب‌خوان's lecture player).
        The heavy audio lives OUTSIDE the repo and the rsynced tree —
        LECTURE_AUDIO_DIR/<dataset>/<file>, a read-only mount the
        deploy plants; unset, every request answers 404 and the player
        explains itself. The dataset must be in the Book set and the
        file a plain name — the allowlist is the traversal guard, the
        PDF route's law. Range is honored byte-for-byte: seeking IS
        the player, and a hung phone must not pin the thread (the
        copy loop swallows the broken pipe like the page rasters
        do)."""
        audio_dir = lecture_audio_dir()
        if resolve_identity(self) is None:
            return
        match = re.fullmatch(
            r"/books/([A-Za-z0-9_-]+)/lectures/([A-Za-z0-9_.-]+\.mp3)", path
        )
        if audio_dir is None or not match or match.group(1) not in BOOK_DATASETS:
            self._drain_request_body()
            self.send_error(404, "Not found")
            return
        target = (Path(audio_dir) / match.group(1) / match.group(2)).resolve()
        if not str(target).startswith(str(Path(audio_dir).resolve())):
            self._drain_request_body()
            self.send_error(404, "Not found")
            return
        try:
            total_size = target.stat().st_size
        except OSError:
            self._drain_request_body()
            self.send_error(404, "Not found")
            return
        range_header = self.headers.get("Range")
        if range_header and range_header.startswith("bytes="):
            try:
                range_val = range_header[6:].strip()
                if "-" in range_val:
                    part_start, part_end = range_val.split("-", 1)
                    if not part_start:
                        length = int(part_end)
                        start = max(0, total_size - length)
                        end = total_size - 1
                    else:
                        start = int(part_start)
                        end = int(part_end) if part_end else total_size - 1
                else:
                    start = int(range_val)
                    end = total_size - 1
                if start >= total_size or start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{total_size}")
                    self.end_headers()
                    return
                end = min(end, total_size - 1)
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{total_size}")
                self.end_headers()
                return
            status = 206
        else:
            start, end, status = 0, total_size - 1, 200
        self.send_response(status)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total_size}")
        self.end_headers()
        try:
            with target.open("rb") as source:
                source.seek(start)
                remaining = end - start + 1
                while remaining:
                    chunk = source.read(min(remaining, 64 * 1024))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _book_page_image(self, path: str) -> None:
        """One Book page as a PDFium raster — ``/books/<d>/page/<n>.png?w=``.

        The visual pipeline (ADR-0007 rendering addendum): these Persian
        Books' subset fonts defeat pdf.js's canvas, so the pixel truth is
        produced server-side by a real PDF engine and the browser only
        overlays transparent text geometry for selection and highlights.
        Renders are cached on disk keyed by dataset, page, and width
        bucket; the w parameter is clamped and bucketed to bound the
        cache. Account-gated (F-001): the rasters are the Book's own
        pixels."""
        if resolve_identity(self) is None:
            return
        match = self._PAGE_WIDTH_RE.fullmatch(path)
        query = parse_qs(urlparse(self.path).query)
        if not match or match.group(1) not in BOOK_DATASETS:
            self._drain_request_body()
            self.send_error(404, "Not found")
            return
        dataset, page_number = match.group(1), int(match.group(2))
        if page_number < 1:
            self._drain_request_body()
            self.send_error(404, "Not found")
            return
        try:
            width = int((query.get("w") or ["1200"])[0])
        except ValueError:
            width = 1200
        width = min(2400, max(480, round(width / 160) * 160))
        if _pdfium is None:
            self._send_json(
                503,
                {
                    "detail": "موتور رندر PDF روی سرور نصب نیست؛ "
                    "ظرف session را با pip install pypdfium2 بازسازی کنید."
                },
            )
            return
        cache_key = f"{dataset}-p{page_number}-w{width}.png"
        cache_file = RENDER_CACHE_DIR / cache_key
        started = time.monotonic()
        try:
            body = cache_file.read_bytes()
        except OSError:
            body = None
        if body is not None:
            # The fast path's own witness (ADR-0017): a warm cache hit
            # answers here, before the lock, and is logged like a miss.
            sys.stderr.write(
                f"render {dataset} p{page_number} w{width}"
                f" hit {time.monotonic() - started:.3f}s\n"
            )
        else:
            body = self._render_book_page(dataset, page_number, width, cache_file)
            if body is None:
                self._drain_request_body()
                self.send_error(404, "Not found")
                return
        self._cache_policy = "private, max-age=604800, immutable"
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _pdf_doc_handle(source: Path):
        """The reused parsed document (ADR-0017): an LRU of open
        PdfDocuments, closed on eviction. A raster cache miss used to
        pay a full parse of the whole file on EVERY page — under the
        global lock, so every waiting client waited with it. Callers
        hold RENDER_LOCK, so the reuse never widens PDFium's thread
        exposure; the books are read-only mounts, the handle cannot go
        stale under a live file."""
        key = str(source)
        pdf = PDF_DOCS_CACHE.get(key)
        if pdf is not None:
            PDF_DOCS_CACHE[key] = PDF_DOCS_CACHE.pop(key)
            return pdf
        while len(PDF_DOCS_CACHE) >= PDF_DOCS_CACHE_CAP:
            oldest = next(iter(PDF_DOCS_CACHE))
            try:
                PDF_DOCS_CACHE.pop(oldest).close()
            except Exception:
                pass
        pdf = _pdfium.PdfDocument(str(source))
        PDF_DOCS_CACHE[key] = pdf
        return pdf

    @staticmethod
    def _prune_render_cache():
        """The cache's ceiling (ADR-0017): once the rasters outgrow the
        cap the oldest go first. The sweep runs only on the write path
        and only when the cap is crossed — the hit path never pays for
        it."""
        try:
            entries = list(RENDER_CACHE_DIR.glob("*.png"))
            total = sum(e.stat().st_size for e in entries)
            if total <= RENDER_CACHE_CAP:
                return
            entries.sort(key=lambda e: e.stat().st_mtime)
            for entry in entries:
                if total <= RENDER_CACHE_CAP:
                    break
                try:
                    total -= entry.stat().st_size
                except OSError:
                    continue
                entry.unlink(missing_ok=True)
        except OSError:
            pass

    @staticmethod
    def _render_book_page(dataset, page_number, width, cache_file):
        """One page raster, cached atomically; None when the page does
        not exist or the PDF is unreadable. Every answer logs its cost —
        hit/miss and milliseconds — so a slow page has a witness, and a
        miss reuses the open-document cache instead of re-parsing the
        whole file (ADR-0017)."""
        source = BOOKS_DIR / f"{dataset}.pdf"
        if not source.exists():
            return None
        RENDER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        try:
            body = cache_file.read_bytes()
        except OSError:
            body = None
        with RENDER_LOCK:
            if body is None:
                # The double-check: another thread may have rendered
                # this exact page while this one waited on the lock.
                try:
                    body = cache_file.read_bytes()
                except OSError:
                    body = None
            if body is not None:
                sys.stderr.write(
                    f"render {dataset} p{page_number} w{width}"
                    f" hit {time.monotonic() - started:.3f}s\n"
                )
                return body
            try:
                pdf = SessionHandler._pdf_doc_handle(source)
                if page_number > len(pdf):
                    return None
                page = pdf[page_number - 1]
                bitmap = page.render(scale=width / page.get_width())
                image = bitmap.to_pil()
                tmp = cache_file.with_suffix(f".tmp{threading.get_ident()}")
                image.save(tmp, format="PNG")
                os.replace(tmp, cache_file)
                body = cache_file.read_bytes()
            except Exception:
                sys.stderr.write(
                    f"render failed: {dataset} p{page_number}\n"
                )
                return None
        sys.stderr.write(
            f"render {dataset} p{page_number} w{width}"
            f" miss {time.monotonic() - started:.3f}s\n"
        )
        SessionHandler._prune_render_cache()
        return body

    def _drain_request_body(self) -> None:
        """Read the body Content-Length promised before answering and
        closing. Closing with bytes unread makes the kernel answer RST,
        not FIN, and the response we just wrote can be lost to the reset
        (WinError 10054 flaking the gate tests; through nginx the same
        reset can surface as a 502 instead of the gate's 429)."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        while length > 0:
            chunk = self.rfile.read(min(length, 65536))
            if not chunk:
                break
            length -= len(chunk)

    def _json_error(self, status: int, detail: str, extra: dict = None) -> None:
        # extra merges into the error body (issue #23: the 429 refusal
        # carries the window's structured state beside its Farsi prose)
        # without touching the drain every caller relies on.
        self._drain_request_body()
        payload = {"detail": detail}
        if extra:
            payload.update(extra)
        self._send_json(status, payload)

    def _send_json(self, status: int, payload: dict, extra_headers=()) -> None:
        """One JSON reply. The caller must have consumed the request body
        already (or never had one) — unlike _json_error this does not
        drain, so a second read cannot block on bytes already taken.
        extra_headers rides the same header block (the login's
        Set-Cookie); the body stays untouched."""
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in extra_headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _cookie_token(self) -> str:
        """The cwb_auth token out of the Cookie header — '' when absent.
        The only credential the gate reads: the client-supplied phone
        header is retired (ADR-0013), and the cookie is HttpOnly, so
        the sheet's JS cannot forge or read it either."""
        for part in self.headers.get("Cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == AUTH_COOKIE:
                return value
        return ""

    def _behind_tls(self) -> bool:
        """The deploy's TLS signal: nginx terminates Let's Encrypt and
        stamps X-Forwarded-Proto: https on every proxied request
        (ops/nginx/booksai.conf). Only then does the cookie carry
        Secure — a dev or test run over plain HTTP keeps working
        (the ADR-0013 review's TLS law: a Secure cookie on a non-TLS
        app breaks the app, never the reverse)."""
        return (self.headers.get("X-Forwarded-Proto") or "") == "https"

    def _auth_cookie_header(self, token: str) -> tuple:
        """The Set-Cookie pair that logs an Account in: HttpOnly (the
        sheet's JS never holds the token), SameSite=Lax (cross-site
        posts cannot ride it), Max-Age matching the token's own signed
        expiry so the browser and the payload agree — and Secure when
        the request arrived over TLS, so the credential never rides a
        plain-HTTP hop (F-005 of the 2026-10-24 security review)."""
        secure = "; Secure" if self._behind_tls() else ""
        return (
            "Set-Cookie",
            f"{AUTH_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; "
            f"Max-Age={AUTH_TOKEN_TTL}{secure}",
        )

    def _clear_cookie_header(self) -> tuple:
        """The logout's deletion pair — Secure rides the same condition
        as the issue, so the browser matches and clears the cookie it
        actually holds."""
        secure = "; Secure" if self._behind_tls() else ""
        return (
            "Set-Cookie",
            f"{AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}",
        )

    def _balance_gate(self, account: str) -> bool:
        """The prepaid stop (T23, GitLab #25): an Account whose Balance
        (اعتبار) is spent answers 402 with the Farsi fix — the ask and
        the phases each pay for themselves before they run, and a turn
        that cannot be paid for never starts. A turn or phase already
        running finishes; only the NEXT spend is stopped. The daily
        quota still applies on top of the Balance, never instead."""
        acc = account_by_email(account)
        if acc and acc.get("role") == "admin":
            return True
        if get_balance(account) <= 0:
            self._json_error(
                402,
                "اعتبار این حساب تمام شده است؛ از مدیر بخواهید اعتبار را شارژ کند.",
            )
            return False
        return True

    def _gate_account(self):
        """The ask gate (ADR-0013): the Account behind the login
        cookie — resolved, never client-supplied — with chats left
        today; records the chat. The identity resolver answers 401
        itself and returns None when rejected; the quota bounds per
        Account through the email the store keys by (T21)."""
        account = resolve_identity(self)
        if account is None:
            return None
        if not self._balance_gate(account):
            return None
        acc = account_by_email(account)
        is_exempt = (acc and acc.get("role") == "admin") or is_unlimited(account)
        if not is_exempt and chats_today(account) >= DAILY_CHAT_LIMIT:
            self._json_error(
                429, "شمار گفتگوهای امروز این حساب پر شده است؛ فردا بیایید."
            )
            return None
        record_chat(account)
        return account

    def _quoted_account(self):
        """The phase-2 gate: an Account with at least one chat today
        (the quoted answer belongs to a chat that already started)."""
        account = resolve_identity(self)
        if account is None:
            return None
        if not self._balance_gate(account):
            return None
        if chats_today(account) < 1:
            self._json_error(
                429, "پاسخ استنادی بخشی از همان گفتگو است؛ اول یک پرسش بپرسید."
            )
            return None
        return account

    def _research_account(self):
        """The research gate (ADR-0015): the Account behind the login
        cookie with a positive Balance — and nothing else. The old
        minimum-of-one-chat precondition existed because research was
        seeded from a prior ask's Evidence pool; the composer's research
        toggle starts the conversation from the typed question alone
        (the pool seed is optional), so the day's first act may be
        research. The daily chat quota stays the normal ask's quota —
        research turns record no chats and never burn it; the Balance
        is the research spend's own prepaid stop."""
        account = resolve_identity(self)
        if account is None:
            return None
        if not self._balance_gate(account):
            return None
        return account

    # --- the Account endpoints (ADR-0013) -----------------------------------
    # Login is the one door; /auth/logout and /auth/me serve the sheet's
    # overlay; /auth/accounts is the Admin's issuance. All four stay open
    # to REACH (no token needed to be told 401) — the gate itself lives in
    # resolve_identity.

    # ---- The برنامک (the Eita client, ADR-0021) -----------------------------
    # Eita's WebView opens /eitaa carrying the signed initData; the page
    # exchanges it here for the Account's ORDINARY signed token and then
    # speaks the shared API the sheet and the Expo app already speak —
    # no second backend, a third client (ADR-0020's law, extended). The
    # Account stays the only identity: an unlinked initData is shown the
    # ONE login door (/eitaa/link reuses /auth/login's own credential
    # check verbatim), the binding it records is the next open's silent
    # ride, and «خروج» removes only the caller's own row.

    def _mobile_page(self, filename: str = "eitaa_app.html") -> None:
        """The mobile face's page, read from disk per request (the
        index.html rule): a redeployed page lands without a restart.
        The page answers with the modulepreload set — the static import
        closure of its own <script type=module> tags, injected fresh so
        a new import is preloaded the moment it is written, never by
        hand-maintained list — and with its own stylesheets INLINED
        (first paint waits on one request, not six). The ETag covers
        the HTML, every module in the graph, and every inlined sheet's
        mtime, so a revalidated 304 means the whole boot bundle is
        unchanged. Fonts and the description stay in the file itself;
        only what the file CANNOT know (its imports' imports) is
        injected."""
        try:
            raw = (UI_DIR / filename).read_bytes()
            body = raw.decode("utf-8")
        except OSError:
            self._drain_request_body()
            self.send_error(404, "Not found")
            return
        entries = _MODULE_SRC_RE.findall(body)
        links, fingerprint = _module_graph(entries)
        for href in _STYLESHEET_LINK_RE.findall(body):
            try:
                fingerprint = (
                    fingerprint
                    + (UI_DIR / href.lstrip("/")).stat().st_mtime_ns
                ) & 0xFFFFFFFFFFFF
            except OSError:
                pass
        try:
            page_mtime = (UI_DIR / filename).stat().st_mtime_ns
        except OSError:
            page_mtime = 0
        etag = f'"{len(raw):x}-{page_mtime:x}-{fingerprint:x}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        body = _inline_stylesheets(body)
        if links:
            injected = "".join(
                f'<link rel="modulepreload" href="{link}">' for link in links
            )
            body = body.replace("</head>", injected + "</head>", 1)
        payload = body.encode("utf-8")
        encoding_header = None
        # The inlined page is the biggest text asset on the wire now —
        # it gzips like any static (the 2026-10-24 pass measured the
        # inline WITHOUT this line shipping +27KB and losing 0.1s FCP:
        # the win only exists compressed).
        if "gzip" in (self.headers.get("Accept-Encoding") or ""):
            payload = gzip.compress(payload, compresslevel=6)
            encoding_header = ("Content-Encoding", "gzip")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("ETag", etag)
        if encoding_header:
            self.send_header(*encoding_header)
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _eitaa_init_data(self):
        """(fields, payload) — the request body read ONCE, the initData
        validated — or (None, None) after answering: an unconfigured
        bot is the 503, a failed signature or stale stamp is the
        برنامک's one 401, and the caller never learns which. The body
        comes back beside the fields because the drain-first rule
        gives it one read, never two."""
        if not eitaa.bot_token():
            self._send_json(
                503, {"detail": EITAA_NOT_CONFIGURED_503_DETAIL}
            )
            return None, None
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            raw = payload.get("initData")
        except (ValueError, TypeError):
            payload, raw = {}, None
        fields = eitaa.validate_init_data(raw) if isinstance(raw, str) else None
        if fields is None:
            # One diagnostic line per refused exchange: the initData's
            # SHAPE — param names and raw piece lengths, sorted — never
            # a single value (the user field carries the operator's own
            # data). 2026-10-20: Eita's genuine opens were refusing and
            # the shape is the only thing that names the structural
            # difference between their initData and anything the tests
            # can synthesize.
            if eitaa.bot_token() and isinstance(raw, str) and raw:
                shape, verdict = _eitaa_refusal_diagnostic(raw)
                sys.stderr.write(
                    f"eitaa-auth-401 pieces=[{shape}] verdict={verdict}\n"
                )
            self._send_json(401, {"detail": EITAA_AUTH_401_DETAIL})
            return None, None
        return fields, payload

    def _eitaa_auth(self) -> None:
        """The credential exchange: the signed initData in, the bound
        Account's ordinary token out — the same issue_token payload
        /auth/login mints, riding Authorization: Bearer on every call
        after (the ADR-0020 native shape; the page is same-origin, so
        CORS never enters). An unbound user is NOT an error: the 200
        says bound:false and the page shows the one door."""
        fields, _payload = self._eitaa_init_data()
        if fields is None:
            return
        user = eitaa.init_data_user(fields)
        binding = eitaa_store.get_binding(user["id"])
        account = (
            account_by_email(binding["account"]) if binding is not None else None
        )
        if binding is None or account is None:
            # A binding whose Account was deleted rides nowhere: the
            # door shows again, the stale row dies at the next link.
            self._send_json(
                200,
                {"bound": False, "user": user},
            )
            return
        token = issue_token(account["email"], account["role"])
        self._send_json(
            200,
            {
                "bound": True,
                "token": token,
                "email": account["email"],
                "role": account["role"],
                "user": user,
            },
            extra_headers=[self._auth_cookie_header(token)],
        )

    def _eitaa_link(self) -> None:
        """The one door, asked once: the signed initData beside an
        Account's real email and password. The credentials check is
        /auth/login's own path — the identical 401 for an unknown
        email and a wrong password — and the binding it records keys
        every silent open after."""
        fields, payload = self._eitaa_init_data()
        if fields is None:
            return
        email = payload.get("email")
        password = payload.get("password")
        if not isinstance(email, str) or not isinstance(password, str):
            # The body is already read above, so _send_json is safe.
            self._send_json(400, {"detail": AUTH_BAD_LOGIN_BODY_DETAIL})
            return
        account = verify_login(email, password)
        if account is None:
            self._send_json(401, {"detail": AUTH_BAD_CREDENTIALS_DETAIL})
            return
        user = eitaa.init_data_user(fields)
        eitaa_store.bind(
            user["id"],
            account["email"],
            chat_id=user["id"],
            first_name=user["first_name"],
            last_name=user["last_name"],
        )
        token = issue_token(account["email"], account["role"])
        self._send_json(
            200,
            {
                "bound": True,
                "token": token,
                "email": account["email"],
                "role": account["role"],
                "user": user,
            },
            extra_headers=[self._auth_cookie_header(token)],
        )

    def _eitaa_unlink(self) -> None:
        """«خروج از ایتا»: the caller's own binding goes — the caller's
        token names the Account, the initData names the Eita user, and
        only a row belonging to BOTH moves. A foreign id is silently
        not theirs (the store's False), and the answer stays a 200:
        unlinking an unlinked user is a finished act, not an error."""
        account = resolve_identity(self)
        if account is None:
            return
        fields, _payload = self._eitaa_init_data()
        if fields is None:
            return
        user = eitaa.init_data_user(fields)
        deleted = eitaa_store.unbind(user["id"], account)
        self._send_json(200, {"deleted": deleted})

    def _ota_manifest(self) -> None:
        """The OTA handshake (rule 001): the expo-updates client polls
        this on every cold start and foreground return. A published
        manifest serves verbatim (the publish script owns its shape —
        id, createdAt, runtimeVersion, launchAsset, assets); no payload
        yet answers 204 No Content, the protocol's "you are current",
        and the client keeps what it has. The route stays OPEN like
        /health: it leaks nothing the manifest doesn't already name."""
        manifest = OTA_DIR / "manifest.json"
        try:
            body = manifest.read_bytes()
        except OSError:
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _ota_asset(self, path: str) -> None:
        """One OTA bundle file, served immutable (rule 001): every
        publish writes fresh hashed names, so a fetched byte range is
        forever-valid content and the client's cache does the heavy
        lifting. The path is constrained to OTA_DIR/current — a
        traversal outside it is a plain 404."""
        rel = path[len("/ota/current/") :]
        target = (OTA_DIR / "current" / rel).resolve()
        if not str(target).startswith(str((OTA_DIR / "current").resolve())):
            self._drain_request_body()
            self.send_error(404, "Not found")
            return
        try:
            body = target.read_bytes()
        except OSError:
            self._drain_request_body()
            self.send_error(404, "Not found")
            return
        suffix = target.suffix.lower()
        self._cache_policy = "public, max-age=31536000, immutable"
        self.send_response(200)
        self.send_header(
            "Content-Type",
            self.extensions_map.get(suffix, "application/octet-stream"),
        )
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _events(self) -> None:
        """The Account's live line (ADR-0020): a Server-Sent Events
        stream of the settles this backend lands server-side — an ask's
        chat row, the picker's selections, the Quoted answer, the
        widen, a research turn's start, a saved note. The web sheet
        keeps its own rhythms (its phases run in the browser); the
        native clients subscribe here, so an ask on one device opens
        the sitting on the other the moment it settles. The stream
        never ends on its own: heartbeats hold it, a hung-up client
        breaks the write and the finally unregisters it."""
        account = resolve_identity(self)
        if account is None:
            return
        subscriber = queue.Queue()
        with _EVENT_LOCK:
            _EVENT_CLIENTS.setdefault(account, set()).add(subscriber)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    event = subscriber.get(timeout=_EVENT_HEARTBEAT)
                except queue.Empty:
                    self.wfile.write(b": heartbeat\n\n")
                else:
                    self.wfile.write(f"data: {event}\n\n".encode("utf-8"))
                self.wfile.flush()
        except (ConnectionAbortedError, BrokenPipeError, OSError, TimeoutError):
            pass  # the client hung up; the finally unregisters it
        finally:
            with _EVENT_LOCK:
                clients = _EVENT_CLIENTS.get(account)
                if clients is not None:
                    clients.discard(subscriber)
                    if not clients:
                        _EVENT_CLIENTS.pop(account, None)
            self.close_connection = True

    def _auth_login(self) -> None:
        """The one door: email + password in, the signed HttpOnly cookie
        out — plus the whoami body the sheet reloads against. An unknown
        email and a wrong password answer the identical 401: the
        difference is never an attacker's to read.

        The door's throttle (F-002): the per-IP bucket counts REFUSED
        credentials only, and a spent budget refuses before the verify
        runs — ten wrong passwords in fifteen minutes from one address
        buys a quiet door, and a successful login never feeds the
        bucket, so a shared office's honest logins stay free."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            email = payload["email"]
            password = payload["password"]
            if not isinstance(email, str) or not isinstance(password, str):
                raise ValueError("email and password are required")
        except (ValueError, KeyError, TypeError):
            self._send_json(400, {"detail": AUTH_BAD_LOGIN_BODY_DETAIL})
            return
        ip = throttle.client_ip(self)
        if throttle.blocked(throttle.LOGIN_FAILURES, ip):
            self._send_json(429, {"detail": THROTTLE_429_DETAIL})
            return
        account = verify_login(email, password)
        if account is None:
            throttle.record(throttle.LOGIN_FAILURES, ip)
            self._send_json(401, {"detail": AUTH_BAD_CREDENTIALS_DETAIL})
            return
        token = issue_token(account["email"], account["role"])
        self._send_json(
            200,
            {
                "email": account["email"],
                "role": account["role"],
                # The native clients' credential (ADR-0020): the same
                # signed string the cookie carries, for the app's secure
                # store — the web sheet never reads this field (its JS
                # cannot touch the HttpOnly cookie, and shouldn't).
                "token": token,
            },
            extra_headers=[self._auth_cookie_header(token)],
        )

    def _auth_logout(self) -> None:
        """Clear the cookie client-side. The token is stateless, so the
        server has nothing to revoke — its signed expiry ends it."""
        self._drain_request_body()
        self._send_json(
            200, {"detail": AUTH_LOGOUT_DETAIL}, extra_headers=[self._clear_cookie_header()]
        )

    def _auth_me(self) -> None:
        """The whoami read: the Account behind the cookie, or the same
        401 every gated endpoint answers — one shape, so the sheet's
        overlay hook treats it one way.

        The Bearer callers' cookie re-plant (F-001's client half): the
        native app's WebView loses its cookie jar at a restart while
        the token in its secure store survives, and /auth/me is the
        boot call both clients make — a whoami that authenticated by
        Bearer alone re-plants the HttpOnly cookie the Book routes'
        <img>/<audio>/pdf.js fetches ride (they cannot carry an
        Authorization header). A caller already holding the cookie
        gets no second Set-Cookie."""
        account = resolve_account(self)
        if account is None:
            self._json_error(401, AUTH_LOGIN_401_DETAIL)
            return
        extra_headers = []
        if not self._cookie_token():
            req_tok = _request_token(self)
            if req_tok:
                extra_headers.append(self._auth_cookie_header(req_tok))
            elif is_login_disabled():
                token = issue_token(account["email"], account["role"])
                extra_headers.append(self._auth_cookie_header(token))
        elif is_login_disabled() and verify_token(self._cookie_token()) is None:
            token = issue_token(account["email"], account["role"])
            extra_headers.append(self._auth_cookie_header(token))
        self._send_json(
            200,
            {
                "email": account["email"],
                "role": account["role"],
                "phone": account["phone"],
                "profile": account.get("profile"),
                "profile_completed": account.get("profile_completed", False),
            },
            extra_headers=extra_headers,
        )

    def _otp_request(self) -> None:
        """The SMS login's first knock (POST /auth/otp/request): the
        phone in, the code out. A phone no Account carries is the one
        honest 404 (ADR-0013 — Accounts stay Admin-issued, the waitlist
        was retired 2026-10-24): nothing sent, nothing charged. A known
        phone sends the six-digit code down فراز اسمس's pattern wire
        (ui/otp.py owns the cooldown, the daily cap, and the code's
        five-minute life). The two configuration failures never wear a
        user's clothing: the unconfigured panel is the same honest 503
        the برنامک's unconfigured bot answers, and a refused send
        answers 502 having charged nothing against the cooldown
        (ui/otp.py records only after the send succeeds)."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            raw = payload["phone"]
            if not isinstance(raw, str):
                raise ValueError("phone must be a string")
        except (ValueError, KeyError, TypeError):
            self._send_json(400, {"detail": OTP_BAD_BODY_DETAIL})
            return
        phone = normalize_local_phone(raw)
        if not phone:
            self._send_json(400, {"detail": OTP_BAD_PHONE_DETAIL})
            return
        # The request door's per-IP budget (F-003): every knock spends —
        # the no-Account 404 and the code send alike — so number-mining
        # this endpoint's oracle costs the attacker its own window,
        # beside the per-phone cooldown and daily cap.
        if not throttle.allow(throttle.OTP_REQUESTS, throttle.client_ip(self)):
            self._send_json(429, {"detail": THROTTLE_429_DETAIL})
            return
        if account_by_phone(phone) is None:
            self._send_json(404, {"detail": OTP_UNKNOWN_PHONE_404_DETAIL})
            return
        if not otp.configured():
            self._send_json(503, {"detail": OTP_UNCONFIGURED_503_DETAIL})
            return
        try:
            otp.request_otp(phone)
        except otp.OtpRateLimited:
            self._send_json(429, {"detail": OTP_RATE_429_DETAIL})
        except otp.OtpSendFailed:
            self._send_json(502, {"detail": OTP_SEND_502_DETAIL})
        else:
            self._send_json(200, {})

    def _otp_verify(self) -> None:
        """The SMS login's second knock (POST /auth/otp/verify): the
        code against the record — the SAME 401 for a wrong code, an
        expired one, and a phone whose Account vanished between the two
        knocks (the ADR-0013 law: refusals an attacker cannot tell
        apart). Success answers /auth/login's body exactly — email,
        role, the native clients' token (ADR-0020), the HttpOnly cookie
        — because as far as every later endpoint cares, this IS the
        email login, arrived by phone."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            raw = payload["phone"]
            code = payload["code"]
            if not isinstance(raw, str) or not isinstance(code, (str, int)):
                raise ValueError("phone and code are required")
        except (ValueError, KeyError, TypeError):
            self._send_json(400, {"detail": OTP_BAD_BODY_DETAIL})
            return
        phone = normalize_local_phone(raw)
        if not phone:
            self._send_json(400, {"detail": OTP_BAD_PHONE_DETAIL})
            return
        # The verify door's own per-IP budget: the per-phone five-attempt
        # cap prices a guesser who fixes on one number; this prices one
        # that rotates numbers.
        if not throttle.allow(throttle.OTP_VERIFIES, throttle.client_ip(self)):
            self._send_json(429, {"detail": THROTTLE_429_DETAIL})
            return
        account = account_by_phone(phone)
        if account is None or not otp.verify_otp(phone, str(code).strip()):
            self._send_json(401, {"detail": OTP_BAD_CODE_401_DETAIL})
            return
        token = issue_token(account["email"], account["role"])
        self._send_json(
            200,
            {
                "email": account["email"],
                "role": account["role"],
                "token": token,
            },
            extra_headers=[self._auth_cookie_header(token)],
        )

    def _auth_create_account(self) -> None:
        """The Admin issues an operator Account (ADR-0013) — the only
        creation path that exists, no signup page beside it. Anonymous
        gets the standard 401; a logged-in operator gets 403, because
        issuing Accounts is the Admin's act alone. The optional phone is
        the legacy attachment the quota and research stores key by."""
        account = resolve_account(self)
        if account is None:
            self._json_error(401, AUTH_LOGIN_401_DETAIL)
            return
        if account["role"] != "admin":
            self._json_error(403, AUTH_NOT_ADMIN_403_DETAIL)
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            email = payload["email"]
            password = payload["password"]
            phone = payload.get("phone")
            if not isinstance(email, str) or not email.strip():
                raise ValueError("email is required")
            if not isinstance(password, str) or not password:
                raise ValueError("password is required")
            if phone is not None and not isinstance(phone, str):
                raise ValueError("phone must be a string")
        except (ValueError, KeyError, TypeError):
            # The body is already read above, so _send_json is safe —
            # _json_error would drain a second time and block.
            self._send_json(400, {"detail": AUTH_BAD_ACCOUNT_BODY_DETAIL})
            return
        if phone:
            phone = normalize_phone(phone)
            if not phone:
                self._send_json(
                    400, {"detail": "شمارهٔ تلفن همراه را وارد کنید."}
                )
                return
        else:
            phone = None
        created = create_account(email, password, phone=phone, role="operator")
        if created is None:
            self._send_json(409, {"detail": AUTH_EMAIL_TAKEN_DETAIL})
            return
        # The audit's first wired action (ADR-0013, T25): an issuance is
        # the Admin's act and lands in the append-only log — the issuer
        # and the issued, appended only after the creation truly
        # succeeded. A refused creation (the 409 above, the bad body
        # before it) logs nothing: the log records what HAPPENED, never
        # what was attempted.
        audit_quiet(
            audit.ACCOUNT_CREATED,
            actor_email=account["email"],
            detail={"email": created["email"], "phone": created["phone"]},
        )
        self._send_json(
            200,
            {
                "email": created["email"],
                "role": created["role"],
                "phone": created["phone"],
            },
        )

    def do_DELETE(self):
        """DELETE: the Session store's one destructive verb (T27 stage
        3, the list-v1 shape — delete only) and the Notebook's single
        delete. A row that is not the caller's is a 404, never an
        erase."""
        path = self.path.split("?", 1)[0]
        if path.startswith("/sessions/"):
            rest = path[len("/sessions/"):]
            if rest.isdigit():
                self._session_delete(int(rest))
                return
        if path.startswith("/notes/"):
            rest = path[len("/notes/"):]
            if rest.isdigit():
                self._note_delete(int(rest))
                return
        self.send_error(404, "Not found")

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        narration_route = re.fullmatch(r"/books/([A-Za-z0-9_-]+)/narration", path)
        if narration_route:
            self._reader_narration(narration_route.group(1))
            return
        if path == "/auth/login":
            # The one door (ADR-0013): email + password in, the
            # HttpOnly cookie out. Open by design — there is no other
            # way in.
            self._auth_login()
            return
        if path == "/auth/logout":
            self._auth_logout()
            return
        if path == "/auth/otp/request":
            # The SMS login's first knock (2026-10-23): the phone in,
            # the code out — open like /auth/login, there is no other
            # door to protect.
            self._otp_request()
            return
        if path == "/auth/otp/verify":
            self._otp_verify()
            return
        if path == "/auth/accounts":
            self._auth_create_account()
            return
        if path == "/eitaa/auth":
            # The برنامک's credential exchange (ADR-0021): the signed
            # initData in, the Account's ordinary token out.
            self._eitaa_auth()
            return
        if path == "/eitaa/link":
            # The one door, asked once: the initData beside an
            # Account's email and password records the binding.
            self._eitaa_link()
            return
        if path == "/eitaa/unlink":
            self._eitaa_unlink()
            return
        if path == "/ask":
            # The retrieval-only reference ask (ADR-0014): the T27
            # shell's composer does not call this door — production
            # asks through /api/v1/recall's one-door composer (ADR-0015)
            # — but the reference flow keeps its gate and its record.
            account = self._gate_account()
            if account is None:
                return
            # A new ask owns the sheet exactly like the recall proxy
            # before it (issue #26): the Account's in-flight research
            # turns abort cooperatively and their sessions close.
            abort_account_research(account)
            # The ask's own ledger entry (T22): input-side size
            # estimate, like the recall POST always recorded.
            request_id = secrets.token_hex(16)
            record_size_estimate(
                account,
                "ask",
                int(self.headers.get("Content-Length", "0") or "0"),
                request_id=request_id,
            )
            self._ask(account, request_id=request_id)
        if path == "/admin/accounts":
            # The console's issuance form (T26, GitLab #28): the same
            # act as /auth/accounts, wearing the page's shape.
            self._admin_create_account()
            return
        if path == "/admin/topup":
            # The console's top-up form (T26, GitLab #28): Toman lands
            # on a Balance, audited, from the browser.
            self._admin_topup()
            return
        if path == "/admin/attach":
            # The console's attach form (T21, GitLab #23): the legacy
            # phone joins its Account, and the stores' pre-account rows
            # follow the mapping — audited, from the browser.
            self._admin_attach()
            return
        if path == "/api/user/profile":
            self._user_profile_save()
            return
        if path == "/agent/chat":
            account = resolve_identity(self)
            if account is None:
                return
            if not self._balance_gate(account):
                return
            acc = account_by_email(account)
            phone = (acc.get("phone") if acc and acc.get("phone") else account)
            # The Question window (ADR-0017/0018): a Learner message
            # that RECEIVES an agent answer is one Question, inside 30
            # per rolling 5 hours. A full window stops the next message;
            # an answer already in flight finishes and meters on landing.
            # ONE store read feeds both the gate and the refusal (#21
            # fixup): window_state clamps remaining at
            # max(LIMIT - count, 0), so remaining <= 0 holds exactly
            # when questions_in_window(phone) >= QUESTION_WINDOW_LIMIT —
            # the gate's old count compare, equivalent by construction —
            # and the refusal's prose and extra draw from the same state.
            state = window_state(phone)
            if state["remaining"] <= 0:
                # The refusal names when the window reopens (issue #23),
                # from the store's own read — the same reopens_at the
                # sheet's counter will render then, never a bare "try
                # later". The clock is the server's local time, the
                # Learner's clock, in Farsi digits.
                reopen = time.localtime(state["reopens_at"])
                clock = f"{reopen.tm_hour:02d}:{reopen.tm_min:02d}".translate(
                    _PERSIAN_DIGITS
                )
                self._json_error(
                    429,
                    "پنجرهٔ پرسش‌های این حساب در پنج ساعت گذشته پر شده است؛"
                    f" ساعت {clock} دوباره باز می‌شود.",
                    extra={"window": state},
                )
                return
            # A new ask owns the sheet exactly like /ask (issue #26): the
            # phone's in-flight research turns abort cooperatively.
            abort_account_research(account)
            # The Question's own ledger entry (T22's pattern): an
            # input-side size estimate — the model calls happen in the
            # agent service, so the Toman ledger sees the volume, not
            # tokens it never metered.
            request_id = secrets.token_hex(16)
            record_size_estimate(
                account,
                "agent",
                int(self.headers.get("Content-Length", "0") or "0"),
                request_id=request_id,
            )
            self._agent_chat(phone, account=account, request_id=request_id)
            return
        if path == "/agent/recall":
            self._agent_recall()
            return
        if path == "/api/v1/recall":
            account = self._gate_account()
            if account is None:
                return
            # A new ask owns the sheet (issue #26): after the gate has
            # recorded the chat, the Account's in-flight research
            # turns abort — cooperatively; the worker exits at its next
            # boundary — and their sessions close, so the new ask's
            # Research Mode starts from a fresh investigation. Another
            # Account's research is never touched.
            abort_account_research(account)
            # The ask's own entry (T22, GitLab #24): the gate knows the
            # request's size before the relay streams the answer — an
            # input-side estimate, marked estimated like every
            # non-metered entry. The phases' composer calls ride the
            # thread's usage tap and land metered or estimated by the
            # reply's own honesty.
            record_size_estimate(
                account, "ask", int(self.headers.get("Content-Length", "0") or "0")
            )
            self._proxy("POST", account)
            return
        if path == "/sessions":
            # The Session store's create (T27 stage 3): the sheet opens
            # the sitting on its first ask.
            self._session_create()
            return
        if path == "/notes":
            # The Notebook's quick-save (the selection map, ticket 08):
            # the popover's capture lands here with its defaults.
            self._note_create()
            return
        if path == "/notes/bulk-delete":
            self._note_bulk_delete()
            return
        if path.startswith("/notes/"):
            rest = path[len("/notes/"):]
            if rest.isdigit():
                self._note_update(int(rest))
                return
        if path.startswith("/sessions/"):
            rest = path[len("/sessions/"):]
            if rest.endswith("/messages") and rest[: -len("/messages")].isdigit():
                self._session_append(int(rest[: -len("/messages")]))
                return
        if path == "/quoted-answer":
            account = self._quoted_account()
            if account is None:
                return
            # The planner and the writer both ride this thread's composer
            # calls — each upstream call lands its own ledger entry.
            set_meter(
                lambda prompt, reply: record_composer_call(
                    account, "writer", prompt, reply
                )
            )
            try:
                self._quoted_answer(account)
            finally:
                set_meter(None)
            return
        if path == "/quote-selection":
            account = self._quoted_account()
            if account is None:
                return
            set_meter(
                lambda prompt, reply: record_composer_call(
                    account, "picker", prompt, reply
                )
            )
            try:
                self._quote_selection(account)
            finally:
                set_meter(None)
            return
        if path == "/recall-more":
            account = self._quoted_account()
            if account is None:
                return
            set_meter(
                lambda prompt, reply: record_composer_call(
                    account, "composer", prompt, reply
                )
            )
            try:
                self._recall_more(account)
            finally:
                set_meter(None)
            return
        if path == "/evidence-fallback":
            if self._quoted_account() is None:
                return
            self._evidence_fallback()
            return
        if path == "/research/message":
            account = self._research_account()
            if account is None:
                return
            self._research_message(account)
            return
        if path == "/research/decide":
            # The same gate as the message start (ADR-0015): a
            # toggle-first conversation's proposals must be decidable
            # even when no normal ask ran today. Bookkeeping — no
            # upstream call, nothing to meter.
            account = self._research_account()
            if account is None:
                return
            self._research_decide(account)
            return
        if path == "/next-tier-recall":
            if self._quoted_account() is None:
                return
            self._next_tier_recall()
            return
        self._drain_request_body()
        self.send_error(404, "Not found")

    def _reader_narration(self, document: str) -> None:
        """Book-only generation; the reader uses this app's Account identity."""
        account = resolve_identity(self)
        if account is None:
            return
        if document not in BOOK_DATASETS:
            self._json_error(404, "کتاب پیدا نشد.")
            return
        if not self._balance_gate(account):
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            self.close_connection = True
            self._send_json(400, {"detail": "درخواست نادرست است."})
            return
        if length <= 0 or length > 300_000:
            self._json_error(413, "متن این درخواست بیش از حد بلند است.")
            return
        try:
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError
        except (ValueError, UnicodeError):
            self._send_json(400, {"detail": "درخواست نادرست است."})
            return
        try:
            from ui.narration import generate_narration, NarrationError
        except ImportError:
            from narration import generate_narration, NarrationError
        try:
            result = generate_narration(document, body, books_dir=BOOKS_DIR)
        except NarrationError as error:
            self._send_json(error.status, {"code": error.code, "detail": error.messageFa})
            return
        self._send_json(200, result)

    def _quoted_answer(self, account: str) -> None:
        """Compose the Quoted answer; empty blocks = fallback.

        The settled article is also the Account's Session record
        (vanishing-content fix, 2026-09-24): when the body carries the
        sitting's ``session_id`` and this ask's ``ask_key``, the server
        settles the assistant turn ITSELF, before the reply is written —
        a browser that reloads mid-compose leaves the sitting with its
        answer, because the store write no longer waits for the client
        to report it. A re-settle of the same ask_key upgrades the row
        in place, so the transcript keeps ONE answer per ask. A store
        failure never fails the phase reply.

        The reference flow's record (ADR-0014) rides beside it: a body
        carrying the ask-minted ``chat_id`` updates the reference chat
        store's row — the reload's restore read re-renders the guarded
        document there."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            question = payload["question"]
            answer = payload.get("answer")
            sources = [
                {
                    "reference": source["reference"],
                    "passage": source["passage"],
                }
                for source in payload["sources"]
                if isinstance(source, dict)
                and isinstance(source.get("reference"), str)
                and isinstance(source.get("passage"), str)
            ]
            chat_id = payload.get("chat_id")
            if not isinstance(chat_id, str):
                chat_id = ""
            session_id = payload.get("session_id")
            ask_key = payload.get("ask_key")
            if not isinstance(question, str) or not question.strip() or not sources:
                raise ValueError("question and sources are required")
            if not isinstance(answer, str):
                answer = ""
        except (ValueError, KeyError, TypeError):
            self.send_error(400, "Bad request")
            return
        # The sitting's earlier turns ride as framing (the follow-up
        # thread, ADR-0015) — a stored snapshot contributes nothing
        # (its parts are quotes only), so the parallel picker's row,
        # if it settled first, never pollutes the writer's context.
        tail = _conversation_tail(account, session_id)
        blocks, truncated = compose_quoted_answer(
            question, answer, sources, conversation_tail=tail
        )
        # The settle is gated on a written document (the other half of
        # the arrive-order race, 2026-09-27 operator report): a failed
        # phase 2 used to settle empty blocks and erase the snapshot
        # the picker had already stored — the store refuses downgrades
        # too, but the empty write never even starts here.
        if (
            blocks
            and isinstance(session_id, int)
            and isinstance(ask_key, str)
            and ask_key.strip()
        ):
            try:
                session_store.settle_ask(
                    account,
                    session_id,
                    ask_key,
                    {
                        "question": question,
                        "blocks": blocks,
                        "truncated": truncated,
                        "citations": sources[:10],
                    },
                )
            except Exception:
                sys.stderr.write("session settle failed (quoted-answer)\n")
        if blocks and chat_id:
            # The reload's record (ADR-0014): the guarded document that
            # rendered is the document the restore re-renders — a
            # write guarded by the owner's key, so a foreign chat_id
            # lands nowhere.
            chat_store.update_quoted(chat_id, account, blocks, truncated)
        if blocks:
            _publish_event(
                account, "chat.quoted", chat_id=chat_id, blocks=len(blocks)
            )
            # The second bell (ADR-0021): the settled article is the
            # moment the operator away from the برنامک is brought
            # back — opt-in by env, silent without it.
            _eitaa_push(account, EITAA_PUSH_SETTLED_TEXT)
        body = json.dumps(
            {"blocks": blocks, "truncated": truncated}, ensure_ascii=False
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _ask(self, account: str, request_id: str | None = None) -> None:
        """The retrieval-only ask (ADR-0014): the first answer's Evidence
        pool with NO LLM completion in the loop — one only_context search
        per selected Book over the main Cognee service, so the pool is
        the hybrid retrieval's own passages every time, in seconds. The
        sheet's first answer stays retrieval (the Quote selection over
        this pool) and can never arrive as a conclusive essay. The ask
        mints its chat row here — the picker, the Quoted answer, and the
        widen update it by the chat_id this reply carries, and a reload
        restores the whole sheet from it. A malformed body answers 400; a
        searcher that finds nothing answers 200 {"sources": []} — the
        honest empty the sheet's no-citation note consumes, never a
        5xx."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            query = payload["query"]
            if not isinstance(query, str) or not query.strip():
                raise ValueError("query is required")
            datasets = validated_datasets(payload.get("datasets"))
        except (ValueError, KeyError, TypeError):
            # The body is already read above, so _send_json is safe.
            self._send_json(400, {"detail": "پرسش را بنویسید."})
            return
        if not request_id:
            request_id = secrets.token_hex(16)
        sources = ask_pool(query.strip(), datasets, session_id=request_id)
        chat_id = secrets.token_hex(8)
        chat_store.create_chat(
            chat_id, account, query.strip(), datasets, sources, request_id=request_id
        )
        telemetry.write_qa_entry(request_id, query.strip(), "", (datasets or [""])[0])
        _publish_event(
            account,
            "chat.asked",
            chat_id=chat_id,
            query=query.strip(),
            pool_size=len(sources),
        )
        self._send_json(
            200,
            {
                "chat_id": chat_id,
                "sources": sources,
                "pool_size": len(sources),
                "request_id": request_id,
            },
        )

    def _agent_chat(self, phone: str, account: str | None = None, request_id: str | None = None) -> None:
        """The Learner-facing seam (ADR-0018), STREAMED (issue #26): the
        sheet's chat surface — the Learner's message goes to the Mastra
        agent's stream route (its tools are the Book pool through
        /agent/recall and web search), the agent's answer relays to the
        sheet UNBUFFERED as it is composed (the _relay close-delimited
        pattern: one readline at a time onto the socket), and the seam's
        own terminal frame ends the stream — chat-answer-finalized when
        an answer completed, chat-answer-error when it failed, stalled
        past its leash, or carried no answer. Metering and persistence
        stay COMPLETION-ANCHORED: one ANSWERED message records one
        Question and persists one exchange (the guaranteed-marked form
        #24 built, identical in shape to the non-streamed persistence,
        so the reload restores the same transcript); a failed, stalled,
        or abandoned stream records and persists nothing. The gates
        before this handler (identity, Balance, window, the research
        abort, the size estimate) keep today's JSON error shapes. The
        thread is stable per phone, so the agent's own memory carries
        the conversation even though the sheet renders from this
        store."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, KeyError, TypeError):
            # The body is already read above, so _send_json is safe.
            self._send_json(400, {"detail": "پرسش را بنویسید."})
            return
        if not request_id:
            request_id = secrets.token_hex(16)
        try:
            turn = LearnerTurnContext.from_request(
                phone, account, payload, request_id=request_id
            )
        except ValueError as err:
            self._send_json(400, {"detail": "پرسش را بنویسید."})
            return
        stream = AgentStream(turn)
        # Close-delimited SSE (HTTP/1.0): no Content-Length, lines hit
        # the socket as they arrive — the sheet reads the body with
        # getReader() and renders progressively.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.end_headers()
        for line in stream:
            try:
                self.wfile.write(line)
            except OSError:
                # ABANDONED: the Learner's connection died mid-stream —
                # abort the upstream and answer nothing; this Question
                # was never answered, so nothing is metered and nothing
                # persists (the browser gate exercises the disconnect;
                # this branch's ordering is pinned statically in
                # test_session_ui).
                stream.abort()
                stream.close()
                return
        stream.close()
        reply = stream.reply
        if reply is None:
            # The stream already ended with the honest-error frame — no
            # Question, no exchange.
            return
        # The answer COMPLETED: this message is one Question (ADR-0018)
        # — metered here, once, only on completion.
        record_question(phone)
        # The persisted exchange carries the guaranteed-marked form
        # (#24, ADR-0018): the answer text plus the web-sourced flag and
        # sources the seam derived from the streamed tool-result frames
        # — a reload re-renders the «بیرون از کتاب» marking from this
        # stored form with no agent call and no re-billing.
        chat_store.record_agent_exchange(
            phone,
            turn.thread_id,
            turn.query,
            reply["text"],
            reply["web_sourced"],
            reply["sources"],
            request_id=request_id,
        )
        telemetry.write_qa_entry(
            request_id,
            turn.query,
            reply["text"],
            turn.datasets[0] if turn.datasets else "",
        )
        # The finalize frame (issue #26): the full answer with the
        # marking guarantee and the window AFTER this Question landed
        # (issue #23 — the sheet's counter renders from this frame; the
        # first answered message shows 29 remaining). The flag is
        # rendering truth only, never a gate.
        try:
            self.wfile.write(
                sse_frame(
                    {
                        "type": CHAT_ANSWER_FINALIZED,
                        "answer": reply["text"],
                        "web_sourced": reply["web_sourced"],
                        "sources": reply["sources"],
                        "window": window_state(phone),
                    }
                )
            )
        except OSError:
            # The answer completed and persisted — only its delivery
            # failed (the Learner went away between the last delta and
            # the finalize); the reload restores the exchange.
            sys.stderr.write(
                "%s - agent stream client went away at finalize\n"
                % self.address_string()
            )

    def _agent_chat_history(self) -> None:
        """The agent conversation's restore read (ADR-0014/0018): the
        phone's persisted transcript — question/answer exchanges, oldest
        first. No LLM call, no metering: a reload restores without
        re-billing. The identity comes from the login cookie (ADR-0013),
        and one phone's reload never reads another's conversation."""
        account = resolve_identity(self)
        if account is None:
            return
        acc = account_by_email(account)
        phone = (acc.get("phone") if acc and acc.get("phone") else account)
        self._send_json(
            200,
            {
                "thread_id": f"learner-{phone}",
                "messages": chat_store.agent_conversation(phone),
                # The window recomputed fresh (issue #23): the restore
                # read initializes the sheet's counter from the store,
                # never from a reply an earlier visit cached.
                "window": window_state(phone),
            },
        )

    def _agent_recall(self) -> None:
        """The agent seam (ADR-0016/0018): the Mastra chat agent's
        search-books tool calls this for the Book pool — the SAME
        parsed only_context passages /ask builds (ui.ask.ask_pool),
        never duplicated on the TS side. There is no phone gate: the
        caller is the agent service presenting the shared
        AGENT_SERVICE_TOKEN (hmac-compared; a missing token env keeps
        the seam closed). No metering and no chat row here: the
        Question window meters Learner messages on the Learner-facing
        seam, not the agent's tool rounds (ADR-0018). A bad token is
        401; a malformed body 400; a searcher that finds nothing is
        200 {"passages": []} — the honest empty the agent reports."""
        expected = os.environ.get("AGENT_SERVICE_TOKEN", "")
        presented = self.headers.get("X-Agent-Token", "")
        if not expected or not hmac.compare_digest(expected, presented):
            self._drain_request_body()
            self._send_json(401, {"detail": "agent token required"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            query = payload["query"]
            if not isinstance(query, str) or not query.strip():
                raise ValueError("query is required")
            datasets = validated_datasets(payload.get("datasets"))
        except (ValueError, KeyError, TypeError):
            # The body is already read above, so _send_json is safe.
            self._send_json(400, {"detail": "query is required"})
            return
        session_id = payload.get("session_id") if isinstance(payload, dict) else None
        if not isinstance(session_id, str):
            session_id = None
        raw_pool = ask_pool(query.strip(), datasets, session_id=session_id)
        distilled = distill_pool(query.strip(), raw_pool)
        self._send_json(200, {"passages": distilled})

    def _chat_latest(self) -> None:
        """The reload's restore read (ADR-0014): the Account's newest ask
        row — question, Book selection, pool, Quote selection, and the
        Quoted answer's blocks — or null when the Account never asked.
        No LLM, no side effects; the identity comes from the login
        cookie (ADR-0013)."""
        account = resolve_identity(self)
        if account is None:
            return
        self._send_json(200, {"chat": latest_chat(account)})

    def _evidence_fallback(self) -> None:
        """The phase-1 citation fallback (ADR-0011): the first message's
        role is to FIND CITATIONS — when the streamed reply came back
        without an Evidence block, ONE pinned reference-on search over
        the question (the dive kernel's searcher, the ask's selected
        Books) fetches the pool directly so the Quote selection and
        phase 2 still run. The gate is the ask's own shape (an Account
        with a chat today; the ask already recorded it — this never
        counts another). A malformed body answers 400; a searcher that
        finds nothing answers 200 {"sources": []} — the honest empty
        the sheet's no-citation note consumes, never a 5xx."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            question = payload["question"]
            if not isinstance(question, str) or not question.strip():
                raise ValueError("question is required")
            datasets = validated_datasets(payload.get("datasets"))
        except (ValueError, KeyError, TypeError):
            # The body is already read above, so _send_json is safe.
            self._send_json(400, {"detail": "پرسش را بفرستید."})
            return
        sources = dive_recall(question.strip(), datasets)
        self._send_json(200, {"sources": sources})

    def _recall_more(self, account: str) -> None:
        """The «جست‌وجوی بیشتر» operation (ADR-0010): one broaden call
        reasons out the question's not-yet-covered facets, the dive
        kernel's pinned searchers run them on the second service, and
        the pool's NEW passages ride back — the sheet merges them,
        re-picks the Quote selection, and re-runs phase 2. The gate is
        phase 2's shape (belongs to a chat that already started, never
        counts one). The body carries the ask's current pool so the
        merge can return only fresh passages, and the selected Books'
        datasets (validated against the Book set; empty means both). A
        malformed body answers 400 before any upstream call; a broaden
        that finds nothing answers 200 {"sources": []} — the honest
        empty the sheet's no-joy note consumes, never a 5xx."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            question = payload["question"]
            sources = [
                {
                    "reference": source["reference"],
                    "passage": source["passage"],
                }
                for source in payload.get("sources", [])
                if isinstance(source, dict)
                and isinstance(source.get("reference"), str)
                and isinstance(source.get("passage"), str)
            ]
            datasets = validated_datasets(payload.get("datasets"))
            if not isinstance(question, str) or not question.strip():
                raise ValueError("question is required")
        except (ValueError, KeyError, TypeError):
            # The body is already read above, so _send_json is safe —
            # _json_error would drain a second time and block.
            self._send_json(400, {"detail": "پرسش و شواهد فعلی را بفرستید."})
            return
        fresh = recall_more(question.strip(), sources, datasets)
        chat_id = payload.get("chat_id")
        if not isinstance(chat_id, str):
            chat_id = None
        if fresh:
            # The widen's growth is part of the ask's record (ADR-0014):
            # the restored sheet's pool is the merged one, so the store
            # grows by the same fresh passages the reply carries —
            # phone-guarded, keyed by the chat_id the ask minted.
            if chat_id:
                chat_store.update_pool(
                    chat_id, account, sources + fresh
                )
        _publish_event(
            account, "chat.widened", fresh=len(fresh), chat_id=chat_id
        )
        body = json.dumps({"sources": fresh}, ensure_ascii=False).encode(
            "utf-8"
        )
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _quote_selection(self, account: str) -> None:
        """Pick the Quote selection (ADR-0006, issue #28): the pool
        exactly as the sheet parsed it, one picker call, the guarded
        selections back. The gate is phase 2's shape — the picker
        belongs to the chat phase 1 recorded — so it needs an Account
        with at least one chat today and never records or counts one. A
        malformed body or an empty pool answers 400 (a JSON detail, the
        gate's shape) before any upstream call; a picker failure or a
        below-floor selection answers 200 {"selections": []} — the one
        uniform empty shape the sheet's prose fallback consumes, never
        a 5xx.

        With the sitting's ``session_id`` and this ask's ``ask_key`` in
        the body, the kept selections also settle the ask's assistant
        turn SERVER-SIDE (the vanishing-content fix, 2026-09-24): the
        first-answer snapshot rides the same idempotent row the phase-2
        article later upgrades, so a reload after the picker — even
        hours before phase 2 lands — leaves the sitting with the answer
        the operator actually received. The snapshot's blocks are the
        selections rendered as quoting paragraphs, the exact shape the
        resume read draws.

        The reference flow's record (ADR-0014) rides beside it: a body
        carrying the ask-minted ``chat_id`` records the kept selections
        in the reference chat store's row."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            question = payload["question"]
            sources = [
                {
                    "reference": source["reference"],
                    "passage": source["passage"],
                }
                for source in payload["sources"]
                if isinstance(source, dict)
                and isinstance(source.get("reference"), str)
                and isinstance(source.get("passage"), str)
            ]
            chat_id = payload.get("chat_id")
            if not isinstance(chat_id, str):
                chat_id = ""
            session_id = payload.get("session_id")
            ask_key = payload.get("ask_key")
            if not isinstance(question, str) or not question.strip() or not sources:
                raise ValueError("question and sources are required")
        except (ValueError, KeyError, TypeError):
            # The body is already read above, so _send_json is safe —
            # _json_error would drain a second time and block.
            self._send_json(
                400, {"detail": "پرسش و استنادهای بازیابی‌شده را بفرستید."}
            )
            return
        selections = pick_quote_selection(question, sources)
        if (
            selections
            and isinstance(session_id, int)
            and isinstance(ask_key, str)
            and ask_key.strip()
        ):
            snapshot = {
                "question": question,
                "blocks": [
                    {
                        "type": "paragraph",
                        "parts": [
                            {
                                "quote": item["text"],
                                "reference": item["reference"],
                                "pages_label": item.get("pages_label", ""),
                                "first_page_label": item.get(
                                    "first_page_label", ""
                                ),
                                "book_label": item.get("book_label", ""),
                            }
                        ],
                    }
                    for item in selections
                ],
                "citations": sources[:10],
                "selection_snapshot": True,
            }
            try:
                session_store.settle_ask(
                    account, session_id, ask_key, snapshot
                )
            except Exception:
                sys.stderr.write("session settle failed (quote-selection)\n")
        if selections:
            _publish_event(
                account,
                "chat.selected",
                chat_id=chat_id,
                count=len(selections),
            )
        if chat_id and selections:
            chat_store.update_selections(chat_id, account, selections)
        self._send_json(200, {"selections": selections, "pool_size": len(sources)})

    def _research_turn_status(self) -> None:
        """The turn poll surface: the sheet asks for a turn's state,
        Farsi events, and elapsed seconds — and, when the turn settled,
        its outcome. `done` carries the reply payload ({"reply",
        "suggestions", "state"}), `failed` a short Farsi detail, and an
        unknown id (a restart emptied the registry, or a foreign Account)
        answers 404 — the recorded failure surface, never a hang. The
        account must match the turn's: one Account's poll never reads
        another's research. The identity comes from the login cookie
        (ADR-0013): no valid Account, no poll — 401."""
        account = resolve_identity(self)
        if account is None:
            return
        query = parse_qs(urlparse(self.path).query)
        turn_id = (query.get("turn") or [""])[0]
        payload = None
        turn = find_turn(turn_id)
        if turn is not None and turn.account == account:
            payload = turn_status_payload(turn)
        if payload is None:
            self._json_error(404, RESEARCH_TURN_NOT_FOUND_DETAIL)
            return
        self._send_json(200, payload)

    def _research_state(self) -> None:
        """The state panel's read: one session's summary projection —
        the research question and its version count, scope, evidence and
        claim counts, gaps, pending proposals — account matched, straight
        from the SQLite store, never from the in-memory registry. The
        chip set rides beside the summary under ``suggestions`` so a
        refresh re-renders the skip with the map (T10, GitLab #11).
        The sitting's chat Session id rides as ``chat_session_id``
        (ADR-0016's reverse linkage): the refresh reconnect uses it to
        open the WHOLE sitting — chat and research in one thread —
        instead of the bare research hang a reload used to leave; null
        for a pre-linkage conversation. The identity comes from the
        login cookie (ADR-0013)."""
        account = resolve_identity(self)
        if account is None:
            return
        query = parse_qs(urlparse(self.path).query)
        session_id = (query.get("session") or [""])[0]
        if not session_id:
            self._json_error(404, RESEARCH_SESSION_NOT_FOUND_DETAIL)
            return
        payload, error = research_session_state(account, session_id)
        if payload is None:
            self._json_error(error[0], error[1])
            return
        payload["chat_session_id"] = research_store.chat_session_for(
            account, session_id
        )
        self._send_json(200, payload)

    def _research_messages(self) -> None:
        """The transcript read (ADR-0011): one session's messages in
        order, account matched — a browser refresh re-fetches what was
        said instead of an empty chat. No LLM, no research side
        effects. The identity comes from the login cookie (ADR-0013):
        no valid Account, no transcript — 401."""
        account = resolve_identity(self)
        if account is None:
            return
        query = parse_qs(urlparse(self.path).query)
        session_id = (query.get("session") or [""])[0]
        payload, error = research_session_messages(account, session_id)
        if payload is None:
            self._send_json(error[0], {"detail": error[1]})
            return
        self._send_json(200, payload)

    def _usage_live(self) -> None:
        """The sheet header's live read (T22, GitLab #24): the open
        Session's running Toman total — everything since this Account's
        newest `ask` entry inclusive — plus the server-local day's
        spend, and the Account's Balance beside them (2026-09-29): the
        cost chip shows the sitting against the credit it spends, and
        one read answers all three. The tariff is config's business;
        this endpoint only reports what the ledger already recorded."""
        account = resolve_identity(self)
        if account is None:
            return
        self._send_json(
            200,
            {
                "session_toman": session_total(account),
                "today_toman": today_total(account),
                "balance_toman": get_balance(account),
            },
        )

    def _admin_console(self) -> None:
        """The «میز مدیریت» read (T25, GitLab #26): the Admin's
        server-rendered mirror of the system — every Account with its
        Balance (اعتبار), the day's spend off the ledger, the day's
        chats against the daily limit, the live research turns and the
        recently settled ones with their failures called out, and the
        audit log's newest rows. One HTML document, no JS dependency —
        the console reads, it does not run the system from the browser.

        The gate is /auth/accounts' shape exactly (resolve_account plus
        the role check), and deliberately NOT resolve_identity: the
        console is nobody's account view — it mirrors the whole system —
        so the identity an endpoint like /profile/data derives from the
        cookie is beside the point here. Anonymous still gets the
        standard 401; a logged-in operator gets the console's own 403.

        Every read here stays a read: the registry snapshot copies the
        live turns and the recent-settled ring under
        RESEARCH_REGISTRY_LOCK and never writes back, the ledger and
        the quota store answer their per-Account sums (keyed by the
        Account's email, T21), and the audit read
        is a plain SELECT against the append-only table. The page's own
        writes ride the two forms below (T26, GitLab #28) — audited,
        admin-only, never silent."""
        account = resolve_account(self)
        if account is None:
            self._json_error(401, AUTH_LOGIN_401_DETAIL)
            return
        if account["role"] != "admin":
            self._json_error(403, ADMIN_CONSOLE_403_DETAIL)
            return
        yesterday = time.strftime(
            "%Y-%m-%d",
            time.localtime(time.time() - 24 * 60 * 60),
        )
        accounts_rows = []
        for row in list_accounts():
            accounts_rows.append(
                {
                    "email": row["email"],
                    "role": row["role"],
                    # The attached phone is display data now (T21): the
                    # legacy handle the Admin attached history by, never
                    # a key — the spend and quota reads below key by the
                    # Account's own email.
                    "phone": normalize_phone(row.get("phone") or ""),
                    "balance_toman": row["balance_toman"],
                    "yesterday_spend_toman": day_total(row["email"], yesterday),
                    "today_spend_toman": today_total(row["email"]),
                    "chats_today": chats_today(row["email"]),
                    "quota_limit": "نامحدود" if (row.get("role") == "admin" or is_unlimited(row["email"])) else DAILY_CHAT_LIMIT,
                }
            )
        now_mono = time.monotonic()
        with RESEARCH_REGISTRY_LOCK:
            live_turns = [
                {
                    "id": turn.id,
                    "account": turn.account,
                    "state": turn.state,
                    "elapsed": round(now_mono - turn.started_at, 1),
                }
                for turn in RESEARCH_REGISTRY.values()
            ]
            # The ring is appended oldest-first as turns settle; the
            # page renders newest first, so the snapshot hands it over
            # reversed. list() copies before the lock lets go.
            settled_turns = [
                {
                    "id": turn.id,
                    "account": turn.account,
                    "state": turn.state,
                    "error": turn.error,
                }
                for turn in reversed(list(RESEARCH_RECENT_SETTLED))
            ]
        # A refused write redirects back with one whitelisted code
        # (T26): only codes with a Farsi note render — user text never
        # rides a URL into the page.
        error_code = self.path.split("?", 1)[-1] if "?" in self.path else ""
        error_code = dict(
            pair.split("=", 1) for pair in error_code.split("&") if "=" in pair
        ).get("error", "")
        if error_code not in ADMIN_ERROR_NOTES:
            error_code = ""
        body = console_html(
            accounts_rows,
            live_turns,
            settled_turns,
            audit.recent(ADMIN_AUDIT_ROWS),
            quota_limit=DAILY_CHAT_LIMIT,
            generated=time.strftime("%Y-%m-%d %H:%M"),
            error_code=error_code,
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _admin_requests_list(self) -> None:
        account = self._admin_gate()
        if account is None:
            return
        query_string = urlparse(self.path).query
        qs = parse_qs(query_string)
        filters = {k: v[0] for k, v in qs.items() if v}
        reqs = telemetry.recent_requests(
            limit=50,
            day=filters.get("day"),
            phone=filters.get("phone"),
            dataset=filters.get("dataset"),
            status=filters.get("status"),
        )
        body = telemetry.telemetry_list_html(reqs, filters).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _admin_request_detail(self, request_id: str) -> None:
        account = self._admin_gate()
        if account is None:
            return
        view = telemetry.request_view(request_id)
        body = telemetry.telemetry_detail_html(view).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _admin_request_json(self, request_id: str) -> None:
        account = self._admin_gate()
        if account is None:
            return
        data = telemetry.request_json(request_id)
        body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_redirect(self, location: str) -> None:
        """The form posts' answer (T26): 303 See Other — the browser
        re-reads the page it acted from, fresh. Post, redirect, get:
        the console re-renders its own new state."""
        self.send_response(303)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _admin_gate(self):
        """The write forms' gate — the console's own (resolve_account
        plus the role check). Returns the acting Admin's account dict,
        or None after the refusal was sent (401 anonymous, 403
        operator): the console is nobody's account view, so identity
        resolution is beside the point here — the role is the whole
        gate."""
        account = resolve_account(self)
        if account is None:
            self._json_error(401, AUTH_LOGIN_401_DETAIL)
            return None
        if account["role"] != "admin":
            self._json_error(403, ADMIN_CONSOLE_403_DETAIL)
            return None
        return account

    def _read_form(self) -> dict:
        """One form-encoded body as a plain dict (first value wins —
        these forms carry no repeated fields). Empty body → {}."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        parsed = parse_qs(raw.decode("utf-8"), keep_blank_values=True)
        return {key: values[0] for key, values in parsed.items()}

    def _admin_create_account(self) -> None:
        """The console's issuance form (T26, GitLab #28) — account
        creation moves into the console here: email, password, and the
        optional legacy phone attach, posted from the page, audited
        like /auth/accounts, and answered with a redirect back to the
        fresh mirror. A refused write redirects with a whitelisted
        error code and logs nothing."""
        account = self._admin_gate()
        if account is None:
            return
        form = self._read_form()
        email = (form.get("email") or "").strip()
        password = form.get("password") or ""
        phone = (form.get("phone") or "").strip() or None
        if not email or not password:
            self._send_redirect(f"/admin?error={ADMIN_ERROR_BAD_BODY}")
            return
        if phone:
            phone = normalize_phone(phone)
            if not phone:
                self._send_redirect(f"/admin?error={ADMIN_ERROR_BAD_PHONE}")
                return
        created = create_account(email, password, phone=phone, role="operator")
        if created is None:
            self._send_redirect(f"/admin?error={ADMIN_ERROR_EMAIL_TAKEN}")
            return
        audit_quiet(
            audit.ACCOUNT_CREATED,
            actor_email=account["email"],
            detail={"email": created["email"], "phone": created["phone"]},
        )
        self._send_redirect("/admin")

    def _admin_topup(self) -> None:
        """The console's top-up form (T26, GitLab #28): Toman lands on
        the named Account's Balance (credit_balance — email-keyed, the
        same row the operator's own reads answer from), the audit log
        carries the actor, the amount, and the new balance, and the
        redirect re-renders the mirror with the new اعتبار showing."""
        account = self._admin_gate()
        if account is None:
            return
        form = self._read_form()
        email = (form.get("email") or "").strip()
        try:
            amount = int((form.get("amount") or "").strip())
        except ValueError:
            amount = 0
        if amount <= 0:
            self._send_redirect(f"/admin?error={ADMIN_ERROR_BAD_AMOUNT}")
            return
        new_balance = credit_balance(email, amount)
        if new_balance is None:
            self._send_redirect(f"/admin?error={ADMIN_ERROR_UNKNOWN_ACCOUNT}")
            return
        audit_quiet(
            audit.BALANCE_TOPPED,
            actor_email=account["email"],
            detail={
                "email": email,
                "amount_toman": amount,
                "new_balance_toman": new_balance,
            },
        )
        self._send_redirect("/admin")

    def _admin_attach(self) -> None:
        """The console's attach form (T21, GitLab #23): the Admin
        attaches each legacy phone to the Account created for it — the
        mapping ui/migrate.py rekeys the pre-account stores by — and
        the rekey runs immediately, so the demo is attach, redirect,
        and the old rows read under their Account. Audited
        (phone_attached), admin-only, refused with the whitelisted
        codes and logged with nothing."""
        actor = self._admin_gate()
        if actor is None:
            return
        form = self._read_form()
        email = (form.get("email") or "").strip()
        phone = normalize_phone(form.get("phone") or "")
        if not email or not phone:
            self._send_redirect(f"/admin?error={ADMIN_ERROR_BAD_BODY}")
            return
        if not attach_phone(email, phone):
            self._send_redirect(f"/admin?error={ADMIN_ERROR_UNKNOWN_ACCOUNT}")
            return
        report = migrate.rekey_stores()
        audit_quiet(
            audit.PHONE_ATTACHED,
            actor_email=actor["email"],
            detail={"email": email, "phone": phone, "rekeyed": report},
        )
        self._send_redirect("/admin")

    def _profile_data(self) -> None:
        """The profile read (T24, GitLab #27): the Account's own Balance
        (اعتبار) straight from the store, the server-local day's spend,
        and the spend history grouped into Sessions by the ledger's
        session_history — the open Session first. The cookie IS the
        address: there is no id parameter at all, so a caller — whatever
        it sends — can only ever read its own Account's numbers, the
        same shape /usage/live answers with. Each entry's honesty badge
        rides the data (the DRAFT constants above): the sheet renders
        the meter's own verdict, it never judges metered against
        estimated itself, so an estimate can never look measured."""
        account = resolve_identity(self)
        if account is None:
            return
        sessions = session_history(account)
        for session in sessions:
            for entry in session["entries"]:
                entry["badge"] = (
                    PROFILE_METERED_BADGE
                    if entry["metered"]
                    else PROFILE_ESTIMATED_BADGE
                )
        self._send_json(
            200,
            {
                "balance_toman": get_balance(account),
                "today_toman": today_total(account),
                "sessions": sessions,
            },
        )

    def _user_profile_get(self) -> None:
        """The Learner's profile read: the Account's learning preferences
        and onboarding status."""
        account = resolve_identity(self)
        if account is None:
            return
        profile = get_profile(account)
        self._send_json(
            200,
            {
                "email": account,
                "profile": profile,
                "profile_completed": bool(
                    profile
                    and (
                        profile.get("assistant_tone")
                        or profile.get("tone")
                        or profile.get("usage_purpose")
                    )
                ),
            },
        )

    def _user_profile_save(self) -> None:
        """The Learner's profile update: validate and persist learning preferences."""
        account = resolve_identity(self)
        if account is None:
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._send_json(400, {"detail": "داده‌های ورودی نامعتبر است."})
            return
        try:
            saved = save_profile(account, payload)
        except ValueError as err:
            self._send_json(400, {"detail": str(err)})
            return
        self._send_json(
            200,
            {
                "ok": True,
                "profile": saved,
                "profile_completed": True,
            },
        )

    def _sessions_list(self) -> None:
        """The sidebar's read (T27 stage 3, GitLab #40): the caller's
        Sessions, newest activity first. The cookie IS the address, so
        the list is only ever the caller's own; the store caps the
        payload, not the history (the accepted list-v1 shape)."""
        account = resolve_identity(self)
        if account is None:
            return
        self._send_json(200, {"sessions": session_store.list_sessions(account)})

    def _session_get(self, session_id: int) -> None:
        """One Session with its stored messages oldest→newest — the
        resume read. Another Account's Session answers 404, the same
        silence the store gives; the sheet renders the transcript
        read-only. The payload names the sitting's newest research
        session (ADR-0016): the linkage a reload or a sidebar round-trip
        needs to raise the research trail beside the chat again — until
        the linkage landed, the trail's only address lived in the
        browser's sessionStorage and died at the first sidebar click."""
        account = resolve_identity(self)
        if account is None:
            return
        session = session_store.get_session(account, session_id)
        if session is None:
            self._json_error(404, "نشست پیدا نشد.")
            return
        session["research_session_id"] = research_store.latest_for_chat_session(
            account, str(session_id)
        )
        self._send_json(200, session)

    def _session_create(self) -> None:
        """Open one Session (T27 stage 3): the sheet creates it on the
        sitting's first ask, sending the Book and the truncated title.
        The store judges neither — the ledger stays the money truth."""
        account = resolve_identity(self)
        if account is None:
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            book = payload.get("book")
            title = payload.get("title")
            if book is not None and not isinstance(book, str):
                raise ValueError
            if title is not None and not isinstance(title, str):
                raise ValueError
        except (ValueError, TypeError, json.JSONDecodeError):
            self._send_json(400, {"detail": "درخواست نادرست است."})
            return
        session = session_store.create_session(account, book or "", title or "")
        self._send_json(200, session)

    def _session_append(self, session_id: int) -> None:
        """Append one turn to the caller's Session (T27 stage 3): the
        sheet reports its settled turns — the operator's ask, the
        assistant's article — as {role, payload}; the store renders
        nothing and judges nothing. A foreign Session is 404."""
        account = resolve_identity(self)
        if account is None:
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            role = payload["role"]
            body = payload["payload"]
            if role not in ("user", "assistant") or not isinstance(body, dict):
                raise ValueError
        except (ValueError, KeyError, TypeError, json.JSONDecodeError):
            self._send_json(400, {"detail": "درخواست نادرست است."})
            return
        session = session_store.append_message(account, session_id, role, body)
        if session is None:
            # The body is already read above, so _send_json is safe —
            # _json_error would drain again and block on taken bytes
            # (the _evidence_fallback rule).
            self._send_json(404, {"detail": "نشست پیدا نشد."})
            return
        self._send_json(200, session)

    def _session_delete(self, session_id: int) -> None:
        """Delete the caller's Session whole (list-v1: delete only). The
        transcript goes; the ledger's spend rows stay — the profile's
        and the console's numbers never falsify."""
        account = resolve_identity(self)
        if account is None:
            return
        if not session_store.delete_session(account, session_id):
            self._json_error(404, "نشست پیدا نشد.")
            return
        self._send_json(200, {"deleted": True})

    # ---- The Notebook (the selection map, ticket 08) ----
    # The researcher's capture: the popover quick-saves, the panel
    # reads/edits/deletes. Ownership is the cookie, as everywhere.

    @staticmethod
    def _note_fields(payload: dict) -> dict:
        """The create payload's shape: the quote is required; the book
        side (doc/pages/refs/source) and the editable defaults ride
        optional. Anything else the client sends is ignored — the store
        judges the shapes it knows."""
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError
        doc = payload.get("doc")
        if doc is not None and not isinstance(doc, str):
            raise ValueError
        pages = payload.get("pages") or []
        refs = payload.get("refs") or []
        source = payload.get("source") or {}
        category = payload.get("category") or ""
        opinion = payload.get("opinion") or ""
        if not isinstance(pages, list) or not isinstance(refs, list):
            raise ValueError
        if not isinstance(source, dict):
            raise ValueError
        if not isinstance(category, str) or not isinstance(opinion, str):
            raise ValueError
        return {
            "text": text,
            "doc": doc,
            "pages": pages,
            "refs": refs,
            "source": source,
            "category": category,
            "opinion": opinion,
        }

    def _notes_list(self) -> None:
        account = resolve_identity(self)
        if account is None:
            return
        self._send_json(200, {"notes": note_store.list_notes(account)})

    def _note_create(self) -> None:
        account = resolve_identity(self)
        if account is None:
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            fields = self._note_fields(payload)
        except (ValueError, TypeError, json.JSONDecodeError):
            # The body is already read, so _send_json is safe (the
            # _evidence_fallback rule).
            self._send_json(400, {"detail": "درخواست نادرست است."})
            return
        note = note_store.create_note(account, **fields)
        _publish_event(account, "note.saved", id=note.get("id") if isinstance(note, dict) else None)
        self._send_json(200, note)

    def _note_update(self, note_id: int) -> None:
        """Edit the editable fields (category / opinion); the quote is
        fixed. A foreign note is 404."""
        account = resolve_identity(self)
        if account is None:
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            category = payload.get("category")
            opinion = payload.get("opinion")
            if category is not None and not isinstance(category, str):
                raise ValueError
            if opinion is not None and not isinstance(opinion, str):
                raise ValueError
        except (ValueError, TypeError, json.JSONDecodeError):
            self._send_json(400, {"detail": "درخواست نادرست است."})
            return
        note = note_store.update_note(
            account, note_id, category=category, opinion=opinion
        )
        if note is None:
            self._send_json(404, {"detail": "یادداشت پیدا نشد."})
            return
        self._send_json(200, note)

    def _note_delete(self, note_id: int) -> None:
        account = resolve_identity(self)
        if account is None:
            return
        if not note_store.delete_note(account, note_id):
            self._json_error(404, "یادداشت پیدا نشد.")
            return
        self._send_json(200, {"deleted": True})

    def _note_bulk_delete(self) -> None:
        account = resolve_identity(self)
        if account is None:
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            ids = payload.get("ids")
            if not isinstance(ids, list):
                raise ValueError
        except (ValueError, TypeError, json.JSONDecodeError):
            self._send_json(400, {"detail": "درخواست نادرست است."})
            return
        deleted = note_store.delete_notes_many(account, ids)
        self._send_json(200, {"deleted": deleted})


    def _research_report(self) -> None:
        """The Session report's read (T18, GitLab #19): one session's
        walk-away artifact — question, destination, map summary, the
        standing Brief with its quotes and pages, and the server-built
        «منابع», as one self-contained RTL HTML document. Phone matched;
        a CLOSED session still answers (a finished Session's report is
        the deliverable); no Brief sections yet is the Farsi refusal.
        The chat transcript never enters it. The identity comes from
        the login cookie (ADR-0013): no valid Account, no report — 401.

        `format=md` (T19, GitLab #22) serves the Markdown twin of the
        Brief's body instead: `text/markdown; charset=utf-8` as a
        DOWNLOAD attachment named for the artifact — text reuse wants a
        file, not a page — while the default html stays inline for the
        sheet's chip and the print-to-PDF path. Anything but "md" reads
        as the default html."""
        account = resolve_identity(self)
        if account is None:
            return
        query = parse_qs(urlparse(self.path).query)
        session_id = (query.get("session") or [""])[0]
        fmt = (query.get("format") or ["html"])[0]
        document, error = research_session_report(account, session_id, fmt=fmt)
        if document is None:
            self._send_json(error[0], {"detail": error[1]})
            return
        if fmt == "md":
            content_type = "text/markdown; charset=utf-8"
            # The attachment name carries the session's own id; only the
            # id's safe characters ride, so the header can never be
            # shaped by the query string.
            safe_session = re.sub(r"[^A-Za-z0-9._-]", "", session_id)
            disposition = f'attachment; filename="gonzarsh-seshat-{safe_session}.md"'
        else:
            content_type = "text/html; charset=utf-8"
            disposition = None
        body = document.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        if disposition:
            self.send_header("Content-Disposition", disposition)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _research_message(self, account: str) -> None:
        """The Research Mode message start (ADR-0008; gate per ADR-0015):
        the Balance is the prepaid stop and nothing else — the research
        conversation may be the sitting's (or the day's) first act, the
        composer toggle routes the typed question straight here. It
        never counts or checks the daily chat limit. The creating
        call carries the question (the session's founding goal) and —
        when a prior ask seeded one — its phase-1 Evidence pool; later
        calls carry only the text. The turn runs on its own registry
        job and this handler answers the turn identity immediately:
        202 {"turn_id", "session_id"} — the sheet polls /research/turn
        for state, events, and the reply. Nothing is ever queued: a
        busy Account (or a full registry) is rejected, not deferred."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            text = payload["text"]
            if not isinstance(text, str) or not text.strip():
                raise ValueError("text is required")
            session_id = payload.get("session_id")
            if session_id is not None and not isinstance(session_id, str):
                raise ValueError("session_id must be a string")
            question = payload.get("question")
            if not session_id and (
                not isinstance(question, str) or not question.strip()
            ):
                raise ValueError("question is required to start a session")
            sources = payload.get("sources")
            if sources is not None and not isinstance(sources, list):
                raise ValueError("sources must be a list")
            datasets = validated_datasets(payload.get("datasets"))
            # The Session-store linkage (ADR-0016): the sheet reports
            # which chat Session this research conversation belongs to,
            # so the trail survives a reload and a sidebar round-trip.
            # A malformed or foreign id never fails the ask — the
            # research is the user's act; the linkage is bookkeeping.
            chat_session_id = payload.get("chat_session_id")
            if chat_session_id is not None and not isinstance(
                chat_session_id, (int, str)
            ):
                chat_session_id = None
        except (ValueError, KeyError, TypeError):
            # The body is already read above, so _send_json is safe —
            # _json_error would drain a second time and block.
            self._send_json(400, {"detail": "پیام پژوهش را بفرستید."})
            return
        session, error = ensure_session(
            account, session_id, text.strip(), question, sources, datasets
        )
        if session is None:
            self._send_json(error[0], {"detail": error[1]})
            return
        if chat_session_id and not session_id:
            # The creating call only: a live session keeps whatever
            # sitting founded it, and the id rides only after the
            # ownership check — another Account's Session is invisible.
            try:
                owned = session_store.get_session(
                    account, int(chat_session_id)
                )
            except (TypeError, ValueError):
                owned = None
            if owned is not None:
                research_store.attach_chat_session(
                    session["id"], account, str(chat_session_id)
                )
        turn, busy_detail = start_research_turn(account, session, text.strip())
        if turn is None:
            self._send_json(429, {"detail": busy_detail})
            return
        _publish_event(
            account, "research.started", turn_id=turn.id, session_id=session["id"]
        )
        self._send_json(202, {"turn_id": turn.id, "session_id": session["id"]})

    def _research_decide(self, account: str) -> None:
        """The checkpoint resolution: one pending proposal applied or
        dropped — the only path a research question or scope change
        lands through. Synchronous (no LLM, no registry job): the
        decision is bookkeeping, and its answer carries the updated
        summary and chip set the same shape a settled turn does."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            session_id = payload["session_id"]
            proposal_id = payload["proposal_id"]
            accept = payload["accept"]
            # The adjustment checkpoint (T6) decides a choice, not a
            # yes/no — the chosen adjustment rides along when present.
            choice = payload.get("choice")
            if not isinstance(session_id, str) or not session_id.strip():
                raise ValueError("session_id is required")
            if not isinstance(proposal_id, str) or not proposal_id.strip():
                raise ValueError("proposal_id is required")
            if not isinstance(accept, bool):
                raise ValueError("accept must be a boolean")
            if choice is not None and not isinstance(choice, str):
                raise ValueError("choice must be a string")
        except (ValueError, KeyError, TypeError):
            self._send_json(400, {"detail": "تصمیم پیشنهاد را بفرستید."})
            return
        result, error = decide_proposal(
            account,
            session_id.strip(),
            proposal_id.strip(),
            accept,
            choice=(choice or None),
        )
        if result is None:
            self._send_json(error[0], {"detail": error[1]})
            return
        self._send_json(200, result)

    def _next_tier_recall(self) -> None:
        """The recorded Next-tier COT relay (ADR-0005), kept live as the
        Session operator's probe of the second service — the sheet no
        longer calls it (the dive replaced the auto-start). The search
        shape is pinned here, never chosen in the browser:
        GRAPH_COMPLETION_COT over the Book set, references on, not
        streamed (the operator waits for the JSON). Same chat as phase 1
        — the gate only checks a chat happened today and never counts."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            query = payload["query"]
            if not isinstance(query, str) or not query.strip():
                raise ValueError("query is required")
        except (ValueError, KeyError, TypeError):
            # The body is already read above, so _send_json is safe —
            # _json_error would drain a second time and block.
            self._send_json(400, {"detail": "پرسش را بنویسید."})
            return
        body = json.dumps(
            {
                "searchType": NEXT_TIER_SEARCH_TYPE,
                "query": query.strip(),
                "datasets": list(BOOK_DATASETS),
                "includeReferences": True,
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = Request(
            f"{NEXT_TIER_URL}/api/v1/recall",
            data=body,
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        self._relay(request, "next-tier", timeout=NEXT_TIER_TIMEOUT)

    def _relay(self, request: Request, service: str, timeout: int = PROXY_TIMEOUT) -> None:
        """Relay one upstream reply — JSON as-is, text/event-stream
        unbuffered — with the unreachable contract (504 + detail)."""
        try:
            with urlopen(request, timeout=timeout) as resp:
                content_type = resp.headers.get("Content-Type", "application/json")
                if "text/event-stream" in content_type:
                    # Close-delimited relay (HTTP/1.0): no Content-Length, lines
                    # hit the socket as they arrive. readline() because read(n)
                    # would block until n bytes collect.
                    self.send_response(resp.status)
                    self.send_header("Content-Type", content_type)
                    self.end_headers()
                    try:
                        while True:
                            line = resp.readline()
                            if not line:
                                break
                            self.wfile.write(line)
                    except OSError:
                        sys.stderr.write(
                            "%s - stream client went away\n" % self.address_string()
                        )
                    return
                payload = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except HTTPError as exc:
            payload = exc.read()
            self.send_response(exc.code)
            self.send_header("Content-Type", exc.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (URLError, TimeoutError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            message = json.dumps(
                {"detail": f"{service} unreachable: {reason}"},
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(504)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(message)))
            self.end_headers()
            self.wfile.write(message)

    def _proxy(self, method: str, account: str = "") -> None:
        path = self.path.split("?", 1)[0]
        sys.stderr.write("%s - proxy %s %s\n" % (self.address_string(), method, path))
        sys.stderr.flush()
        if path not in ALLOWED_PROXY:
            self._drain_request_body()
            self.send_error(404, "Not found")
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length else None
        if method == "POST" and path == "/api/v1/recall":
            # The recall body is validated, not forwarded blind
            # (ADR-0010): the query is required and the datasets are the
            # ask's Book selection intersected with the Book set — a
            # browser never names an upstream dataset outside it. The
            # account rides for the follow-up rewrite; the meter taps
            # that one composer call (a rewrite is real spend and the
            # ledger watches it like every other).
            set_meter(
                lambda prompt, reply: record_composer_call(
                    account, "composer", prompt, reply
                )
            )
            try:
                patched = self._validated_recall_body(body, account)
            finally:
                set_meter(None)
            if patched is None:
                return
            body = patched
            headers = {"Content-Type": "application/json; charset=utf-8"}
            request = Request(
                f"{COGNEE_URL}{path}",
                data=body,
                headers=headers,
                method=method,
            )
            self._relay(request, "cognee")
            return
        headers = {}
        content_type = self.headers.get("Content-Type")
        if content_type:
            headers["Content-Type"] = content_type
        request = Request(
            f"{COGNEE_URL}{path}",
            data=body,
            headers=headers,
            method=method,
        )
        self._relay(request, "cognee")

    def _validated_recall_body(self, raw: bytes, account: str = ""):
        """The recall POST's patched body bytes, or None after answering
        400. The body is already read here, so rejections use _send_json
        (never the draining _json_error — a second read would block).
        The sitting's id rides to the Session store, never to Cognee;
        a short follow-up over an existing sitting is rewritten into a
        self-contained query before the relay (ADR-0015) — any failure
        answers the raw question."""
        try:
            payload = json.loads(raw or b"{}")
            query = payload["query"]
            if not isinstance(query, str) or not query.strip():
                raise ValueError("query is required")
        except (ValueError, KeyError, TypeError):
            self._send_json(400, {"detail": "پرسش را بنویسید."})
            return None
        session_id = payload.pop("session_id", None)
        payload.pop("history", None)
        query = self._contextual_query(account, session_id, query)
        payload["query"] = query
        datasets = validated_datasets(payload.get("datasets"))
        if datasets is not None:
            payload["datasets"] = datasets
        return json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def _contextual_query(self, account: str, session_id, query: str) -> str:
        """A follow-up's self-contained search query (ADR-0015): when
        the sitting has earlier turns and the question is short, ONE
        fast glm-5.3-flash call rewrites it over the sitting's recent
        turns — «بیشتر توضیح بده» alone retrieves noise, the rewritten
        form retrieves the subject under discussion. Every failure is
        the raw question: the store silent, the endpoint down, the
        short timeout — the rewrite is a retrieval hint, never a gate,
        and the sheet's displayed question is always the user's own
        words."""
        history = _conversation_tail(account, session_id)
        if not history or len(query.split()) > REWRITE_MAX_WORDS:
            return query
        try:
            return rewrite_followup_query(query, history)
        except Exception:
            sys.stderr.write("follow-up rewrite failed; raw query rides\n")
            return query


# The embedder is frozen into the stored vectors (ADR-0004). The 2026-09-12
# VPS incident: a recreated stack whose .env drifted to the wrong pins —
# health stayed green and every search died. Present-but-wrong pins refuse
# the start here, loudly; absent pins (a bare dev run outside compose)
# cannot contradict the data and pass.
FROZEN_EMBEDDING_MODEL = os.environ.get("FROZEN_EMBEDDING_MODEL", "text-embedding-3-large")
FROZEN_EMBEDDING_DIMENSIONS = os.environ.get("FROZEN_EMBEDDING_DIMENSIONS", "3072")


def check_embedding_pin() -> None:
    """The drift guard (T17, GitLab #18): refuse a start whose embedding
    config contradicts the frozen vectors — a crash with the Farsi operator
    fix, never green-but-broken."""
    drifted = []
    for name, frozen in (
        ("EMBEDDING_MODEL", FROZEN_EMBEDDING_MODEL),
        ("EMBEDDING_DIMENSIONS", FROZEN_EMBEDDING_DIMENSIONS),
    ):
        value = os.environ.get(name)
        if value is not None and value != frozen:
            drifted.append(f"{name}={value} (ثابت: {frozen})")
    if drifted:
        sys.exit(
            "پیکربندی امبدینگ با بردارهای ذخیره‌شده نمی‌خواند: "
            + " ، ".join(drifted)
            + " — سرویس اجرا نمی‌شود. مقدارهای ثابت را در .env بگذارید: "
            + f"EMBEDDING_MODEL={FROZEN_EMBEDDING_MODEL} ، EMBEDDING_DIMENSIONS={FROZEN_EMBEDDING_DIMENSIONS} (ADR-0004)."
        )


class SheetServer(ThreadingHTTPServer):
    # The capacity bar is 100 concurrent chat asks (ADR-0017) — now 100
    # concurrent agent answers (ADR-0018). The default listen backlog of
    # 5 resets simultaneous connects outright; the first capacity
    # rehearsal caught exactly that (39/100 WinError 10054 resets).
    request_queue_size = 256


def main() -> None:
    # The drift guard runs before anything binds: a drifted stack must not
    # come up even briefly.
    check_embedding_pin()
    # The true-page resolver (ADR-0011): kept quotes' labels name the
    # passage's actual page, not the locator's drifted estimate.
    install_page_resolver()
    # The first Admin from compose env (T26, GitLab #28): the seed
    # command is retired — the deployment itself plants the PM's
    # Account, once, loudly.
    ensure_first_admin_from_env()
    # The store migration (T21, GitLab #23): every attached phone's
    # legacy rows rekey to their Account before the first request —
    # ADR-0013's contract step, run loudly.
    report = migrate.rekey_stores()
    sys.stderr.write(f"store migration: {report}\n")
    # The Book PDFs' presence at boot (the 09-28 regression: a deploy
    # swap dropped the gitignored PDFs and every cold page render 404'd
    # while the warm render-cache pages kept drawing — say so loudly).
    for dataset in BOOK_DATASETS:
        if (BOOKS_DIR / f"{dataset}.pdf").exists():
            sys.stderr.write(f"book pdf ok: {dataset}\n")
        else:
            sys.stderr.write(
                f"BOOK PDF MISSING: {dataset} — the reader can draw only already-cached pages\n"
            )
    server = SheetServer((HOST, PORT), SessionHandler)
    print(f"Session sheet http://{HOST}:{PORT}", flush=True)
    if HOST in ("0.0.0.0", ""):
        lan_ip = "127.0.0.1"
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                lan_ip = s.getsockname()[0]
        except Exception:
            pass
        if lan_ip and lan_ip != "127.0.0.1":
            print(f"  Local access:   http://localhost:{PORT}/", flush=True)
            print(f"  Network access: http://{lan_ip}:{PORT}/", flush=True)
            print(f"  Mobile UI:      http://{lan_ip}:{PORT}/mobile/", flush=True)
    print(f"Proxying /api/v1/recall and /health to {COGNEE_URL}", flush=True)
    print(f"Relaying /next-tier-recall to {NEXT_TIER_URL}", flush=True)
    print(f"Running Research Mode turns against {NEXT_TIER_URL}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
