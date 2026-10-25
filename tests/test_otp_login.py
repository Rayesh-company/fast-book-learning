"""The SMS login's laws (the OTP layer ADR-0013 parked, landed
2026-10-23; the door opened 2026-10-25): the phone-first flow the
mobile UI always had, wired to فراز اسمس's pattern wire through
ui/otp.py. These tests pin the four behaviors the door must never
lose:

- The open door (the PM's law, 2026-10-25): every Iranian phone gets
  the code, known Account or not, and a verified unknown phone issues
  its own Account — the whitelist's 404 is gone and no
  account-existence oracle survives; a send records only after the
  panel accepts it.
- The panel's exact dialect: Edge webservice, Authorization header, the
  recipient as ONE E.164 number, the code inside the pattern's own
  variable.
- The refusals: cooldown, daily cap, wrong/expired code — and the
  unconfigured 503 that never wears a user error's clothing.
- The success: /auth/login's own body and cookie, workable on /auth/me
  by both the cookie and the Bearer token (ADR-0020)."""

import json
import time
import urllib.error
import urllib.request

import pytest

from tests.helpers import stop_gate, with_gate
from ui import accounts, otp, serve


@pytest.fixture(autouse=True)
def _fresh_codes(monkeypatch):
    """The pending-code store is module-level memory; without this, an
    earlier test's record (sent under ITS clock) leaks into the next
    test's freshly-reset clock and answers a bogus cooldown."""
    monkeypatch.setattr(otp, "CODES", otp._Codes())


class FakePanel:
    """The فراز اسمس wire as the tests see it: every send recorded,
    success unless the test arms a refusal. The reply is the panel's
    verified shape — {"status": "success", "data": {"id": …}} — and
    body_status lets a test arm the panel's 200-with-error answer."""

    def __init__(self):
        self.sent = []
        self.fail_with = None
        self.body_status = "success"

    def __call__(self, request, timeout=None):
        if self.fail_with is not None:
            raise self.fail_with
        entry = json.loads(request.data.decode("utf-8"))
        self.sent.append(
            {"url": request.full_url, "headers": dict(request.headers), "body": entry}
        )
        reply = json.dumps(
            {"status": self.body_status, "data": {"id": 1}}
        ).encode("utf-8")

        class _Reply:
            def read(inner_self):
                return reply

        return _Reply()


def _ok_upstream(url, *args, **kwargs):  # OTP tests never proxy upstream
    raise AssertionError(f"unexpected upstream call: {url}")


def _otp_post(base, path, payload):
    request = urllib.request.Request(
        base + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        return exc.code, json.load(exc)


def _patched_panel(monkeypatch):
    """A configured panel + a test clock: env-shaped facts on the OTP
    module, the send seam on urlopen, and time.time behind a mutable
    tick so the cooldown and the TTL are deterministic. The pattern
    param is pinned too: serve.py's import-time load_env() pours the
    local .env into os.environ (FARAZSMS_PATTERN_PARAM rides a live
    panel's own name, 'codes'), and the tests must not see the
    machine's panel — they assert the fixture's 'codeotp' dialect."""
    panel = FakePanel()
    clock = {"t": 1_800_000_000.0}
    monkeypatch.setattr(otp, "FARAZ_API_KEY", "test-panel-key")
    monkeypatch.setattr(otp, "FARAZ_PATTERN_CODE", "otp-pattern-1")
    monkeypatch.setattr(otp, "FARAZ_FROM_NUMBER", "50002178584000")
    monkeypatch.setattr(otp, "FARAZ_PATTERN_PARAM", "codeotp")
    monkeypatch.setattr(otp, "urlopen", panel)
    monkeypatch.setattr(time, "time", lambda: clock["t"])
    return panel, clock


def test_unknown_phone_signs_itself_in(tmp_path, monkeypatch):
    panel, clock = _patched_panel(monkeypatch)
    base, server, originals = with_gate(tmp_path, _ok_upstream)
    try:
        # The open door (the PM's law, 2026-10-25): a phone no Account
        # carries gets the code like any other — no 404, no oracle.
        status, payload = _otp_post(
            base, "/auth/otp/request", {"phone": "09350000001"}
        )
        assert status == 200
        assert payload == {}
        assert len(panel.sent) == 1
        code = panel.sent[0]["body"]["attributes"]["codeotp"]

        # A wrong code refuses exactly as it does a known phone.
        status, _ = _otp_post(
            base, "/auth/otp/verify", {"phone": "09350000001", "code": "000000"}
        )
        assert status == 401

        # The right code issues the Account: the phone's own email, the
        # login body, the token live on /auth/me.
        status, payload = _otp_post(
            base, "/auth/otp/verify", {"phone": "09350000001", "code": code}
        )
        assert status == 200
        assert payload["email"] == "09350000001@phone.local"
        assert payload["role"] == "operator"
        assert payload["token"]
        request = urllib.request.Request(
            base + "/auth/me", headers={"Authorization": f"Bearer {payload['token']}"}
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            assert response.status == 200
            assert json.load(response)["email"] == "09350000001@phone.local"
        assert accounts.account_by_phone("09350000001") is not None

        # A second round logs the SAME Account in — no duplicate issues
        # itself behind the first.
        clock["t"] += otp.OTP_RESEND_SECONDS + 1
        assert _otp_post(base, "/auth/otp/request", {"phone": "09350000001"})[0] == 200
        code2 = panel.sent[1]["body"]["attributes"]["codeotp"]
        status, payload = _otp_post(
            base, "/auth/otp/verify", {"phone": "09350000001", "code": code2}
        )
        assert status == 200
        assert payload["email"] == "09350000001@phone.local"
        assert accounts.account_by_email("09350000001@phone.local") is not None
    finally:
        stop_gate(server, originals)


def test_known_phone_sends_the_pattern_and_verifies_into_login(
    tmp_path, monkeypatch
):
    panel, _ = _patched_panel(monkeypatch)
    base, server, originals = with_gate(tmp_path, _ok_upstream)
    try:
        # with_gate's patch_accounts already owns the store; the phone
        # rides attached in its E.164 dressing — the ten-digit match
        # must see through it.
        accounts.create_account("reader@book.ir", "pass-word-1", phone="+989121112233")

        status, payload = _otp_post(base, "/auth/otp/request", {"phone": "۰۹۱۲۱۱۱۲۲۳۳"})
        assert status == 200
        assert payload == {}
        assert len(panel.sent) == 1
        send = panel.sent[0]
        # The panel's own dialect, verified live 2026-10-23.
        assert send["url"] == "https://api.iranpayamak.com/ws/v1/sms/pattern"
        # The API key rides the Api-Key header RAW (urllib title-cases).
        assert send["headers"].get("Api-key") == "test-panel-key"
        assert send["body"]["code"] == "otp-pattern-1"
        assert send["body"]["line_number"] == "50002178584000"
        assert send["body"]["number_format"] == "english"
        # The recipient stays in its LOCAL shape — the panel's own
        # validation rejects the E.164 dressing.
        assert send["body"]["recipient"] == "09121112233"
        code = send["body"]["attributes"]["codeotp"]
        assert isinstance(code, str) and len(code) == 6 and code.isdigit()

        # A wrong code refuses; the RIGHT one answers the email login's
        # own body, and the token works on /auth/me through Bearer.
        status, payload = _otp_post(
            base, "/auth/otp/verify", {"phone": "09121112233", "code": "000000"}
        )
        assert status == 401
        status, payload = _otp_post(
            base, "/auth/otp/verify", {"phone": "09121112233", "code": code}
        )
        assert status == 200
        assert payload["email"] == "reader@book.ir"
        assert payload["role"] == "operator"
        assert payload["token"]
        request = urllib.request.Request(
            base + "/auth/me", headers={"Authorization": f"Bearer {payload['token']}"}
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            assert response.status == 200
            assert json.load(response)["email"] == "reader@book.ir"

        # The code is consumed: a replay answers like any wrong guess.
        status, _ = _otp_post(
            base, "/auth/otp/verify", {"phone": "09121112233", "code": code}
        )
        assert status == 401
    finally:
        stop_gate(server, originals)


def test_the_cooldown_and_the_failed_send(tmp_path, monkeypatch):
    panel, clock = _patched_panel(monkeypatch)
    base, server, originals = with_gate(tmp_path, _ok_upstream)
    try:
        accounts.create_account("a@book.ir", "pass-word-1", phone="09120001111")

        assert _otp_post(base, "/auth/otp/request", {"phone": "09120001111"})[0] == 200
        status, payload = _otp_post(base, "/auth/otp/request", {"phone": "09120001111"})
        assert status == 429
        assert "صبر" in payload["detail"]

        # A refused send answers 502 and charges NOTHING against the
        # cooldown: past the cooldown, a failed attempt must leave the
        # next one free to try.
        clock["t"] += otp.OTP_RESEND_SECONDS + 1
        panel.fail_with = OSError("panel silent")
        status, payload = _otp_post(base, "/auth/otp/request", {"phone": "09120001111"})
        assert status == 502
        assert len(panel.sent) == 1  # the failed attempt never recorded
        panel.fail_with = None
        assert _otp_post(base, "/auth/otp/request", {"phone": "09120001111"})[0] == 200
    finally:
        stop_gate(server, originals)


def test_the_days_cap(tmp_path, monkeypatch):
    panel, clock = _patched_panel(monkeypatch)
    base, server, originals = with_gate(tmp_path, _ok_upstream)
    try:
        accounts.create_account("a@book.ir", "pass-word-1", phone="09120001111")
        for _ in range(otp.OTP_DAILY_PER_PHONE):
            assert _otp_post(base, "/auth/otp/request", {"phone": "09120001111"})[0] == 200
            clock["t"] += otp.OTP_RESEND_SECONDS + 1
        status, payload = _otp_post(base, "/auth/otp/request", {"phone": "09120001111"})
        assert status == 429
        assert len(panel.sent) == otp.OTP_DAILY_PER_PHONE
        # A new day resets the cap.
        clock["t"] += 24 * 3600
        assert _otp_post(base, "/auth/otp/request", {"phone": "09120001111"})[0] == 200
    finally:
        stop_gate(server, originals)


def test_expired_code_never_verifies(tmp_path, monkeypatch):
    panel, clock = _patched_panel(monkeypatch)
    base, server, originals = with_gate(tmp_path, _ok_upstream)
    try:
        accounts.create_account("a@book.ir", "pass-word-1", phone="09120001111")
        assert _otp_post(base, "/auth/otp/request", {"phone": "09120001111"})[0] == 200
        code = panel.sent[0]["body"]["attributes"]["codeotp"]
        clock["t"] += otp.OTP_TTL_SECONDS + 1
        status, _ = _otp_post(
            base, "/auth/otp/verify", {"phone": "09120001111", "code": code}
        )
        assert status == 401
    finally:
        stop_gate(server, originals)


def test_unconfigured_panel_is_the_honest_503(tmp_path, monkeypatch):
    panel, _ = _patched_panel(monkeypatch)
    monkeypatch.setattr(otp, "FARAZ_API_KEY", "")  # half-configured door
    base, server, originals = with_gate(tmp_path, _ok_upstream)
    try:
        accounts.create_account("a@book.ir", "pass-word-1", phone="09120002222")
        status, payload = _otp_post(base, "/auth/otp/request", {"phone": "09120002222"})
        assert status == 503
        assert "تنظیم نشده" in payload["detail"]
        assert panel.sent == []
    finally:
        stop_gate(server, originals)


def test_bad_phones_refuse_their_own_400(tmp_path, monkeypatch):
    _patched_panel(monkeypatch)
    base, server, originals = with_gate(tmp_path, _ok_upstream)
    try:
        for bad in ("9120003333", "0912000333", "0091212345678", "+441234567890"):
            status, payload = _otp_post(base, "/auth/otp/request", {"phone": bad})
            assert status == 400, bad
            assert "۱۱ رقم" in payload["detail"]
        status, _ = _otp_post(base, "/auth/otp/request", {"phone": ""})
        assert status == 400
    finally:
        stop_gate(server, originals)


def test_a_200_that_says_error_is_still_a_failed_send(tmp_path, monkeypatch):
    panel, clock = _patched_panel(monkeypatch)
    base, server, originals = with_gate(tmp_path, _ok_upstream)
    try:
        accounts.create_account("a@book.ir", "pass-word-1", phone="09120007777")
        # The panel answers HTTP 200 with {"status":"error"} for some
        # refusals — the login never queued, so it must answer 502 and
        # charge nothing (the record happens only after a real send).
        panel.body_status = "error"
        status, payload = _otp_post(base, "/auth/otp/request", {"phone": "09120007777"})
        assert status == 502
        assert len(panel.sent) == 1
        panel.body_status = "success"
        clock["t"] += otp.OTP_RESEND_SECONDS + 1
        assert _otp_post(base, "/auth/otp/request", {"phone": "09120007777"})[0] == 200
    finally:
        stop_gate(server, originals)


def test_five_wrong_guesses_kill_the_code(tmp_path, monkeypatch):
    panel, _ = _patched_panel(monkeypatch)
    base, server, originals = with_gate(tmp_path, _ok_upstream)
    try:
        accounts.create_account("a@book.ir", "pass-word-1", phone="09120006666")
        assert _otp_post(base, "/auth/otp/request", {"phone": "09120006666"})[0] == 200
        code = panel.sent[0]["body"]["attributes"]["codeotp"]
        for _ in range(otp.OTP_MAX_ATTEMPTS):
            status, _ = _otp_post(
                base, "/auth/otp/verify", {"phone": "09120006666", "code": "313131"}
            )
            assert status == 401
        # The sixth guess loses even the RIGHT code: the record is dead.
        status, _ = _otp_post(
            base, "/auth/otp/verify", {"phone": "09120006666", "code": code}
        )
        assert status == 401
    finally:
        stop_gate(server, originals)
