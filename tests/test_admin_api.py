"""Tests for the Admin JSON API (/api/admin/accounts, /api/admin/topup)."""

import json
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from tests.helpers import (
    ADMIN_EMAIL,
    TEST_PASSWORD,
    cookie_for,
    ensure_account,
    stop_gate,
    with_gate,
)
from ui import accounts as accounts_store
from ui import audit, ledger


def json_get(base, path, cookie=None):
    headers = {"Cookie": cookie} if cookie is not None else {}
    request = urllib.request.Request(base + path, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def json_post(base, path, payload, cookie=None):
    headers = {"Content-Type": "application/json"}
    if cookie is not None:
        headers["Cookie"] = cookie
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(base + path, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def test_api_admin_accounts_requires_admin():
    tmp = Path(tempfile.mkdtemp())
    base, server, originals = with_gate(tmp, None)
    try:
        # Anonymous -> 401
        status, body = json_get(base, "/api/admin/accounts")
        assert status == 401

        # Operator -> 403
        operator_phone = "09120000099"
        ensure_account(operator_phone)
        op_cookie = cookie_for(base, f"{operator_phone}@sheet.test")
        status, body = json_get(base, "/api/admin/accounts", cookie=op_cookie)
        assert status == 403

        # Admin -> 200 with list
        admin_cookie = cookie_for(base, ADMIN_EMAIL)
        status, body = json_get(base, "/api/admin/accounts", cookie=admin_cookie)
        assert status == 200
        assert "accounts" in body
        emails = [a["email"] for a in body["accounts"]]
        assert ADMIN_EMAIL in emails
        assert f"{operator_phone}@sheet.test" in emails
    finally:
        stop_gate(server, originals)


def test_api_admin_create_account_and_topup():
    tmp = Path(tempfile.mkdtemp())
    base, server, originals = with_gate(tmp, None)
    try:
        admin_cookie = cookie_for(base, ADMIN_EMAIL)

        # 1. Create a new operator account with initial credit
        new_email = "newoperator@example.com"
        status, body = json_post(
            base,
            "/api/admin/accounts",
            {
                "email": new_email,
                "password": "Password123!",
                "phone": "09123456789",
                "role": "operator",
                "initial_credit": 50000,
            },
            cookie=admin_cookie,
        )
        assert status == 200
        assert body["email"] == new_email
        assert body["role"] == "operator"
        assert body["phone"] == "09123456789"
        assert body["balance_toman"] == 50000

        # Duplicate email -> 409
        status, body = json_post(
            base,
            "/api/admin/accounts",
            {
                "email": new_email,
                "password": "Password123!",
            },
            cookie=admin_cookie,
        )
        assert status == 409

        # 2. Top up balance
        status, body = json_post(
            base,
            "/api/admin/topup",
            {
                "email": new_email,
                "amount": 25000,
            },
            cookie=admin_cookie,
        )
        assert status == 200
        assert body["email"] == new_email
        assert body["amount_toman"] == 25000
        assert body["new_balance_toman"] == 75000

        # Check balance directly from accounts store
        assert accounts_store.get_balance(new_email) == 75000

        # Verify in accounts list
        status, body = json_get(base, "/api/admin/accounts", cookie=admin_cookie)
        assert status == 200
        created_row = next(a for a in body["accounts"] if a["email"] == new_email)
        assert created_row["balance_toman"] == 75000
        assert created_row["role"] == "operator"

        # 3. Create another admin account
        second_admin_email = "secondadmin@example.com"
        status, body = json_post(
            base,
            "/api/admin/accounts",
            {
                "email": second_admin_email,
                "password": "AdminPassword123!",
                "role": "admin",
            },
            cookie=admin_cookie,
        )
        assert status == 200
        assert body["email"] == second_admin_email
        assert body["role"] == "admin"
    finally:
        stop_gate(server, originals)
