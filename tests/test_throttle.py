"""The anonymous doors' per-IP throttle (F-002/F-003 of the 2026-10-24
review): the login's bucket counts refused credentials only and blocks
before the verify, the OTP doors' buckets spend on every attempt, and
the buckets are per-address — one attacker's spent budget never locks
out another address."""

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


def test_the_otp_request_budget_spends_on_every_knock(tmp_path, monkeypatch):
    # The open door (2026-10-25): every knock now SENDS — the per-IP
    # budget still spends per attempt. The panel is faked so the thirty
    # sends are cheap and quiet.
    class _Panel:
        def __call__(self, request, timeout=None):
            class _Reply:
                def read(inner_self):
                    return b'{"status": "success", "data": {"id": 1}}'

            return _Reply()

    from ui import otp

    monkeypatch.setattr(otp, "CODES", otp._Codes())
    monkeypatch.setattr(otp, "FARAZ_API_KEY", "test-panel-key")
    monkeypatch.setattr(otp, "FARAZ_PATTERN_CODE", "otp-pattern-1")
    monkeypatch.setattr(otp, "FARAZ_FROM_NUMBER", "50002178584000")
    monkeypatch.setattr(otp, "urlopen", _Panel())
    base, server, original = with_gate(tmp_path, NoUpstream())
    headers = {"X-Real-IP": "203.0.113.10"}
    try:
        # Thirty distinct phones — the per-phone cooldown and daily cap
        # never fire; the per-IP budget is what runs out.
        for i in range(30):
            status, _ = raw_post(
                base,
                "/auth/otp/request",
                {"phone": f"0935{i:07d}"},
                extra_headers=headers,
            )
            assert status == 200, i
        status, payload = raw_post(
            base,
            "/auth/otp/request",
            {"phone": "09350099999"},
            extra_headers=headers,
        )
        assert status == 429
        assert payload["detail"] == serve.THROTTLE_429_DETAIL
    finally:
        stop_gate(server, original)


def test_reset_empties_every_bucket(tmp_path):
    throttle.record(throttle.LOGIN_FAILURES, "203.0.113.12")
    throttle.record(throttle.OTP_REQUESTS, "203.0.113.12")
    assert throttle.blocked(throttle.LOGIN_FAILURES, "203.0.113.12") is False
    for _ in range(9):
        throttle.record(throttle.LOGIN_FAILURES, "203.0.113.12")
    assert throttle.blocked(throttle.LOGIN_FAILURES, "203.0.113.12") is True
    throttle.reset()
    assert throttle.blocked(throttle.LOGIN_FAILURES, "203.0.113.12") is False
    assert throttle.allow(throttle.OTP_REQUESTS, "203.0.113.12") is True
