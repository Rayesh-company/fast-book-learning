"""F-020 of the 2026-11-01 mobile review: the token generation.

The login token carries the Account's ``token_epoch``; the identity
resolver refuses any token minted below the Account's current one, and
the admin API bumps the epoch — the kill switch the 30-day stateless
token never had. Old-shape tokens (no epoch claim) validate against
epoch 0, so the migration invalidates nobody until the first bump.
"""

import base64
import json
import sys
import urllib.request

from tests.conftest import REPO_ROOT

sys.path.insert(0, str(REPO_ROOT))

from tests.helpers import ADMIN_EMAIL, TEST_PASSWORD, stop_gate, with_gate  # noqa: E402
from ui import accounts, serve  # noqa: E402


class NoUpstream:
    def __call__(self, request, timeout=None):
        raise AssertionError("the epoch tests must never phone an upstream")


def _old_shape_token(email: str, role: str = "operator") -> str:
    """A pre-epoch token: the payload exactly as it looked before F-020 —
    no ``epoch`` claim — signed with the same secret."""
    import hashlib
    import hmac
    import os
    import time

    payload = {
        "email": email,
        "role": role,
        "exp": int(time.time()) + 3600,
    }
    body = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).rstrip(b"=").decode("ascii")
    signature = hmac.new(
        os.environ["AUTH_SECRET"].encode("utf-8"),
        body.encode("ascii"),
        hashlib.sha256,
    ).hexdigest()
    return f"{body}.{signature}"


def _login(base: str, email: str, password: str):
    request = urllib.request.Request(
        base + "/auth/login",
        data=json.dumps({"email": email, "password": password}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def _gated_get(base: str, token: str, path: str = "/sessions"):
    request = urllib.request.Request(
        base + path, headers={"Authorization": f"Bearer {token}"}
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        return exc.code, json.load(exc)


def test_epoch_bump_invalidates_outstanding_tokens_and_admin_gate_holds(tmp_path):
    base, server, original = with_gate(tmp_path, NoUpstream())
    try:
        created = _login(base, ADMIN_EMAIL, TEST_PASSWORD)
        assert created["token"], "the seeded admin must log in"

        # The gate seeds the Admin only; the operator's Account is the
        # admin's issuance, as in production.
        assert accounts.create_account("sara@sheet.test", TEST_PASSWORD)
        sara = _login(base, "sara@sheet.test", TEST_PASSWORD)
        assert sara["email"] == "sara@sheet.test"
        status, _ = _gated_get(base, sara["token"])
        assert status == 200
        assert serve.verify_token(sara["token"])["epoch"] == 0

        # Only an admin bumps: an operator's credential refuses.
        status, _ = _admin_bump(base, sara["token"], "sara@sheet.test")
        assert status in (401, 403)

        # The bump is the kill switch: the outstanding token — signed,
        # unexpired — refuses like a bad one from the next request on.
        status, _ = _admin_bump(base, created["token"], "sara@sheet.test")
        assert status == 200
        status, _ = _gated_get(base, sara["token"])
        assert status == 401
        assert accounts.get_token_epoch("sara@sheet.test") == 1

        # A token minted after the bump carries the new epoch and works.
        fresh = _login(base, "sara@sheet.test", TEST_PASSWORD)
        assert serve.verify_token(fresh["token"])["epoch"] == 1
        status, _ = _gated_get(base, fresh["token"])
        assert status == 200

        # Unknown Accounts and unknown emails stay silent.
        status, _ = _admin_bump(base, created["token"], "no-one@sheet.test")
        assert status == 404
    finally:
        stop_gate(server, original)


def test_pre_epoch_tokens_validate_until_the_first_bump(tmp_path):
    """The migration must invalidate nobody: a token with no epoch claim
    — every token shipped before F-020 — keeps working while the
    Account's epoch sits at 0, and dies at the first bump."""
    base, server, original = with_gate(tmp_path, NoUpstream())
    try:
        admin = _login(base, ADMIN_EMAIL, TEST_PASSWORD)
        assert accounts.create_account("sara@sheet.test", TEST_PASSWORD)
        _login(base, "sara@sheet.test", TEST_PASSWORD)

        legacy = _old_shape_token("sara@sheet.test")
        status, _ = _gated_get(base, legacy)
        assert status == 200

        _admin_bump(base, admin["token"], "sara@sheet.test")
        status, _ = _gated_get(base, legacy)
        assert status == 401
    finally:
        stop_gate(server, original)


def _admin_bump(base: str, admin_token: str, email: str):
    request = urllib.request.Request(
        base + "/api/admin/token-epoch",
        data=json.dumps({"email": email}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {admin_token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        return exc.code, json.load(exc)
