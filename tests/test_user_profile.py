"""Test suite for User Profile Onboarding and Preferences (ADR-0018 / Mastra Agent personal directives).

Tests cover:
- Store operations (ui.accounts): get_profile, save_profile, validation of Q1 (required) and Q2-Q7 (optional),
  and verify_login / account_by_email inclusion of profile and profile_completed flag.
- Server HTTP endpoints (ui.serve):
  - GET /api/user/profile (auth required, returns profile and profile_completed)
  - POST /api/user/profile (auth required, validation error handling, persistence)
  - GET /auth/me (returns profile and profile_completed)
- Agent chat stream context (ui.serve / ui.agent_client):
  - Injects resource_id and user_profile into requestContext for the Mastra agent.
"""

import json
from pathlib import Path
import pytest

from tests.helpers import (
    account_email_for_phone,
    ensure_account,
    get,
    post,
    raw_get,
    raw_post,
    stop_gate,
    with_gate,
)
from ui import accounts, serve

TEST_PHONE = "09121112233"
ACCOUNT_EMAIL = account_email_for_phone(TEST_PHONE)


# --- 1. Store Layer Unit Tests (ui.accounts) ---------------------------------


def test_fresh_account_has_no_profile(tmp_path, monkeypatch):
    monkeypatch.setattr(accounts, "ACCOUNTS_DB", tmp_path / "accounts.sqlite3")
    ensure_account(TEST_PHONE)

    profile = accounts.get_profile(ACCOUNT_EMAIL)
    assert profile is None

    acc = accounts.account_by_email(ACCOUNT_EMAIL)
    assert acc["profile"] is None
    assert acc["profile_completed"] is False


def test_save_profile_requires_usage_purpose(tmp_path, monkeypatch):
    monkeypatch.setattr(accounts, "ACCOUNTS_DB", tmp_path / "accounts.sqlite3")
    ensure_account(TEST_PHONE)

    with pytest.raises(ValueError, match="استفاده الزامی است"):
        accounts.save_profile(ACCOUNT_EMAIL, {})

    with pytest.raises(ValueError, match="استفاده الزامی است"):
        accounts.save_profile(ACCOUNT_EMAIL, {"usage_purpose": ""})

    with pytest.raises(ValueError, match="استفاده نامعتبر است"):
        accounts.save_profile(ACCOUNT_EMAIL, {"usage_purpose": "invalid_choice"})


def test_save_profile_minimal_valid(tmp_path, monkeypatch):
    """Q1 is required, Q2-Q7 are completely optional."""
    monkeypatch.setattr(accounts, "ACCOUNTS_DB", tmp_path / "accounts.sqlite3")
    ensure_account(TEST_PHONE)

    saved = accounts.save_profile(ACCOUNT_EMAIL, {"usage_purpose": "learning"})
    assert saved["usage_purpose"] == "یادگیری"

    retrieved = accounts.get_profile(ACCOUNT_EMAIL)
    assert retrieved == saved

    acc = accounts.account_by_email(ACCOUNT_EMAIL)
    assert acc["profile_completed"] is True
    assert acc["profile"]["usage_purpose"] == "یادگیری"


def test_save_profile_full_valid_and_normalization(tmp_path, monkeypatch):
    monkeypatch.setattr(accounts, "ACCOUNTS_DB", tmp_path / "accounts.sqlite3")
    ensure_account(TEST_PHONE)

    data = {
        "usage_purpose": "اکادمیک",
        "martyr_works_familiarity": "high",  # maps to زیاد
        "age": "28",
        "political_familiarity": "medium",   # maps to متوسط
        "religious_familiarity": "زیاد",
        "occupation": "پژوهشگر تاریخ",
        "assistant_tone": "آموزشی",
    }

    saved = accounts.save_profile(ACCOUNT_EMAIL, data)
    assert saved["usage_purpose"] == "اکادمیک"
    assert saved["martyr_works_familiarity"] == "زیاد"
    assert saved["age"] == "28"
    assert saved["political_familiarity"] == "متوسط"
    assert saved["religious_familiarity"] == "زیاد"
    assert saved["occupation"] == "پژوهشگر تاریخ"
    assert saved["assistant_tone"] == "آموزشی"


def test_save_profile_validates_optional_fields(tmp_path, monkeypatch):
    monkeypatch.setattr(accounts, "ACCOUNTS_DB", tmp_path / "accounts.sqlite3")
    ensure_account(TEST_PHONE)

    with pytest.raises(ValueError, match="آشنایی با آثار"):
        accounts.save_profile(
            ACCOUNT_EMAIL,
            {"usage_purpose": "academic", "martyr_works_familiarity": "invalid"},
        )

    with pytest.raises(ValueError, match="سن"):
        accounts.save_profile(
            ACCOUNT_EMAIL,
            {"usage_purpose": "academic", "age": -5},
        )

    with pytest.raises(ValueError, match="سیاست"):
        accounts.save_profile(
            ACCOUNT_EMAIL,
            {"usage_purpose": "academic", "political_familiarity": "unknown"},
        )

    with pytest.raises(ValueError, match="مباحث دینی"):
        accounts.save_profile(
            ACCOUNT_EMAIL,
            {"usage_purpose": "academic", "religious_familiarity": "unknown"},
        )

    with pytest.raises(ValueError, match="لحن"):
        accounts.save_profile(
            ACCOUNT_EMAIL,
            {"usage_purpose": "academic", "assistant_tone": "aggressive"},
        )


# --- 2. HTTP Server Endpoints (/api/user/profile & /auth/me) ------------------


def test_anonymous_profile_endpoints_rejected(tmp_path):
    base, server, originals = with_gate(tmp_path, None)
    try:
        status, _ = raw_get(base, "/api/user/profile")
        assert status == 401

        status, _ = raw_post(
            base,
            "/api/user/profile",
            {"usage_purpose": "learning"},
        )
        assert status == 401
    finally:
        stop_gate(server, originals)


def test_get_and_post_user_profile_lifecycle(tmp_path):
    base, server, originals = with_gate(tmp_path, None)
    try:
        # 1. Before setting profile
        status, body = get(base, "/api/user/profile", phone=TEST_PHONE)
        assert status == 200
        assert body["profile"] is None
        assert body["profile_completed"] is False

        # 2. Check /auth/me reflects incomplete profile
        status, me_body = get(base, "/auth/me", phone=TEST_PHONE)
        assert status == 200
        assert me_body["profile"] is None
        assert me_body["profile_completed"] is False

        # 3. Post with validation error
        status, err_body = post(
            base,
            "/api/user/profile",
            {"usage_purpose": "not_valid"},
            phone=TEST_PHONE,
        )
        assert status == 400
        assert "استفاده" in err_body["detail"]

        # 4. Post valid profile (required + some optional)
        valid_profile = {
            "usage_purpose": "leisure",
            "assistant_tone": "simple",
            "occupation": "دانش‌آموز",
        }
        status, post_body = post(
            base,
            "/api/user/profile",
            valid_profile,
            phone=TEST_PHONE,
        )
        assert status == 200
        assert post_body["profile_completed"] is True
        assert post_body["profile"]["usage_purpose"] == "مطالعه آزاد"
        assert post_body["profile"]["assistant_tone"] == "ساده و روان"
        assert post_body["profile"]["occupation"] == "دانش‌آموز"

        # 5. Subsequent GET /api/user/profile
        status, get_body = get(base, "/api/user/profile", phone=TEST_PHONE)
        assert status == 200
        assert get_body["profile_completed"] is True
        assert get_body["profile"] == post_body["profile"]

        # 6. Subsequent GET /auth/me
        status, me_after = get(base, "/auth/me", phone=TEST_PHONE)
        assert status == 200
        assert me_after["profile_completed"] is True
        assert me_after["profile"]["usage_purpose"] == "مطالعه آزاد"
    finally:
        stop_gate(server, originals)


# --- 3. Agent Client Seam Tests (ui.agent_client) ----------------------------


def test_agent_client_request_body_includes_user_profile_and_resource_id():
    from ui import agent_client

    profile = {
        "usage_purpose": "اکادمیک",
        "tone": "حرفه‌ای",
        "job": "استاد دانشگاه",
    }
    body = agent_client._request_body(
        query="سؤال نمونه",
        datasets=["tarhe-kolli"],
        thread_id="thread-123",
        resource_id="learner-09121112233",
        user_profile=profile,
    )

    assert body["messages"] == [{"role": "user", "content": "سؤال نمونه"}]
    assert body["memory"]["thread"] == "thread-123"
    assert body["memory"]["resource"] == "learner-09121112233"
    assert body["requestContext"]["datasets"] == ["tarhe-kolli"]
    assert body["requestContext"]["userProfile"] == profile

