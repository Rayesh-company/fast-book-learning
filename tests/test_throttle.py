"""The anonymous doors' per-IP throttle (F-002/F-003 of the 2026-10-24
review): the login's bucket counts refused credentials only and blocks
before the verify, the OTP request's and the waitlist's buckets spend
on every attempt, and the buckets are per-address — one attacker's
spent budget never locks out another address."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.conftest import REPO_ROOT
from tests.helpers import (
    ADMIN_EMAIL,
    TEST_PASSWORD,
    ensure_account,
    raw_post,
    stop_gate,
    with_gate,
)

sys.path.insert(0, REPO_ROOT)

from ui import serve, throttle  # noqa: E402


class NoUpstream:
    def __call__(self, request, timeout=None):
        raise AssertionError(f"upstream called: {request.full_url}")


def test_login_bucket_counts_failures_and_blocks_before_the_verify(tmp_path):
    base, server, original = with_gate(tmp_path, NoUpstream())
    attacker = {"X-Real-IP": "203.0.113.7"}
    try:
        # Ten refused credentials spend the window's budget.
        for _ in range(10):
            status, payload = raw_post(
                base,
                "/auth/login",
                {"email": ADMIN_EMAIL, "password": "اشتباه"},
                extra_headers=attacker,
            )
            assert status == 401
            assert payload["detail"] == serve.AUTH_BAD_CREDENTIALS_DETAIL
        # The eleventh attempt — even with CORRECT credentials — is
        # refused before the verify runs: the door went quiet.
        status, payload = raw_post(
            base,
            "/auth/login",
            {"email": ADMIN_EMAIL, "password": TEST_PASSWORD},
            extra_headers=attacker,
        )
        assert status == 429
        assert payload["detail"] == serve.THROTTLE_429_DETAIL
        # Another address never felt the hammering: its first login
        # with the same credentials opens the door.
        status, payload = raw_post(
            base,
            "/auth/login",
            {"email": ADMIN_EMAIL, "password": TEST_PASSWORD},
            extra_headers={"X-Real-IP": "198.51.100.9"},
        )
        assert status == 200
    finally:
        stop_gate(server, original)


def test_successful_logins_never_feed_the_login_bucket(tmp_path):
    base, server, original = with_gate(tmp_path, NoUpstream())
    headers = {"X-Real-IP": "203.0.113.8"}
    try:
        # A shared machine's honest users log in repeatedly — the
        # bucket stays empty, the door keeps opening.
        for _ in range(12):
            status, _ = raw_post(
                base,
                "/auth/login",
                {"email": ADMIN_EMAIL, "password": TEST_PASSWORD},
                extra_headers=headers,
            )
            assert status == 200
    finally:
        stop_gate(server, original)


def test_the_otp_request_budget_spends_on_every_knock(tmp_path):
    base, server, original = with_gate(tmp_path, NoUpstream())
    headers = {"X-Real-IP": "203.0.113.10"}
    try:
        phone = "09350000001"  # no Account — the waitlist fork's 200
        for _ in range(30):
            status, payload = raw_post(
                base,
                "/auth/otp/request",
                {"phone": phone},
                extra_headers=headers,
            )
            assert status == 200
            assert payload == {"waitlist": True}
        status, payload = raw_post(
            base,
            "/auth/otp/request",
            {"phone": phone},
            extra_headers=headers,
        )
        assert status == 429
        assert payload["detail"] == serve.THROTTLE_429_DETAIL
    finally:
        stop_gate(server, original)


def test_the_waitlist_budget_prices_the_form_spam(tmp_path, monkeypatch):
    monkeypatch.setattr(
        serve.otp, "WAITLIST_DB", tmp_path / "waitlist.sqlite3"
    )
    base, server, original = with_gate(tmp_path, NoUpstream())
    headers = {"X-Real-IP": "203.0.113.11"}
    try:
        for _ in range(10):
            status, _ = raw_post(
                base,
                "/waitlist",
                {"phone": "09350000002"},
                extra_headers=headers,
            )
            assert status == 200
        status, payload = raw_post(
            base,
            "/waitlist",
            {"phone": "09350000002"},
            extra_headers=headers,
        )
        assert status == 429
        assert payload["detail"] == serve.THROTTLE_429_DETAIL
    finally:
        stop_gate(server, original)


def test_reset_empties_every_bucket(tmp_path):
    throttle.record(throttle.LOGIN_FAILURES, "203.0.113.12")
    throttle.record(throttle.WAITLIST_JOINS, "203.0.113.12")
    assert throttle.blocked(throttle.LOGIN_FAILURES, "203.0.113.12") is False
    for _ in range(9):
        throttle.record(throttle.LOGIN_FAILURES, "203.0.113.12")
    assert throttle.blocked(throttle.LOGIN_FAILURES, "203.0.113.12") is True
    throttle.reset()
    assert throttle.blocked(throttle.LOGIN_FAILURES, "203.0.113.12") is False
    assert throttle.allow(throttle.WAITLIST_JOINS, "203.0.113.12") is True
