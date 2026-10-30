"""The SMS login (2026-10-23): the OTP layer ADR-0013 parked as
"layerable later without rework" — the mobile UI's phone-first flow
(requestOtp → verifyOtp) already spoke its shape, and this module is
the server half that was never wired.

Two pieces:

- The one-time codes: a six-digit secret per phone, five minutes of
  life, at most five wrong tries, one (re)send every two minutes and
  ten a day per phone — every bound the sheet's own flows hold the
  client to, enforced where the client cannot be trusted. The codes
  live in memory only: a restart drops pending logins (the user asks
  for a new code), and no code ever touches disk.
- The فراز اسمس sender: the panel's own webservice
  (api.iranpayamak.com — the API farazsms.com documents as its own),
  one POST with the API key in the Api-Key header, the code inside a
  pre-approved PATTERN (الگو). Iranian delivery law: OTP text may only
  ride a registered الگو, so the message itself lives in the operator's
  panel, never in this repo. Verified live 2026-10-23: pattern list,
  balance, and a probe send all answered on this dialect.

(The waitlist store this module once carried was retired 2026-10-24,
and the whitelist left with it — the PM's open door, 2026-10-25: the
request door sends to every Iranian phone and a verified unknown phone
issues its own Account (serve.py's signup_phone_account). ADR-0013's
Admin-issued-only posture is superseded by ADR-0017's self-signup.)

The urlopen seam is module-level exactly like serve.py's other
upstreams: tests patch otp.urlopen and never touch the network.
"""

from __future__ import annotations

import datetime
import json
import os
import secrets
import threading
import time
from urllib.request import Request, urlopen

# The panel's webservice (farazsms.com's documented API, verified live
# 2026-10-23): one pattern-send endpoint, the API key RAW in the Api-Key
# header, the recipient in its LOCAL 09… shape (NOT E.164 — the panel's
# own validation rejects +98), the sender as one of the account's
# accessible lines.
FARAZ_SEND_URL = "https://api.iranpayamak.com/ws/v1/sms/pattern"

# The panel's configuration (env, never source): the API key (پنل ←
# تنظیمات ← دسترسی API), the login الگو's code, one of the account's
# accessible sender lines (GET /ws/v1/lines/accessible lists them), and
# the pattern's own variable name for the code (ours names it codeotp,
# the panel account's house style).
FARAZ_API_KEY = os.environ.get("FARAZSMS_API_KEY", "")
FARAZ_PATTERN_CODE = os.environ.get("FARAZSMS_PATTERN_CODE", "")
FARAZ_FROM_NUMBER = os.environ.get("FARAZSMS_FROM_NUMBER", "")
FARAZ_PATTERN_PARAM = os.environ.get("FARAZSMS_PATTERN_PARAM", "codeotp")

OTP_TTL_SECONDS = 300
# The PM's two-minute law (2026-10-25): one code, then a two-minute
# wait before the next — the sheet counts it down and holds the same
# line here for a caller that skips the client.
OTP_RESEND_SECONDS = 120
OTP_MAX_ATTEMPTS = 5
OTP_DAILY_PER_PHONE = 10


class OtpRateLimited(Exception):
    """A resend faster than the cooldown, or the day's tenth code — the
    honest refusal, never a silent no-op."""


class OtpSendFailed(Exception):
    """The panel refused or never answered — the login did not happen;
    nothing was charged to the resend budget (the send precedes the
    bookkeeping, so a failed send records nothing)."""


def configured() -> bool:
    """Whether the panel's three required facts are set — the door's
    honest 503 depends on it, exactly like the برنامک's unconfigured
    503: a half-configured sender must refuse loudly, never send
    garbage."""
    return bool(FARAZ_API_KEY and FARAZ_PATTERN_CODE and FARAZ_FROM_NUMBER)


class _Codes:
    """The in-memory pending codes, one per phone — a lock and a dict,
    the whole store: codes are minutes-lived by design."""

    def __init__(self):
        self._lock = threading.Lock()
        self._pending: dict[str, dict] = {}

    def reserve(self, phone: str, now: float):
        """The cooldown/cap check and the slot's occupation under ONE
        lock — the old check-then-record left the wire's own send
        window (up to the panel timeout) between them, and a second
        request inside it found the store still empty and sent its own
        SMS: the PM's two codes in one instant (2026-10-30). The
        reservation is born unverifiable (no code, never in TTL) so a
        racer's verify during the send answers like any wrong guess,
        and the previous record rides back as the return value for a
        failed send to restore."""
        day = datetime.date.fromtimestamp(now).isoformat()
        with self._lock:
            previous = self._pending.get(phone)
            if previous is not None:
                if now - previous["sent_at"] < OTP_RESEND_SECONDS:
                    raise OtpRateLimited("resend cooldown")
                if (
                    previous["day"] == day
                    and previous["sent_today"] >= OTP_DAILY_PER_PHONE
                ):
                    raise OtpRateLimited("daily cap")
            self._pending[phone] = {
                "code": None,
                "expires_at": 0,
                "attempts": 0,
                "sent_at": now,
                "day": day,
                "sent_today": (
                    1
                    if previous is None or previous["day"] != day
                    else previous["sent_today"] + 1
                ),
            }
            return previous

    def confirm(self, phone: str, code: str, now: float) -> None:
        """The send landed on the wire: the reserved slot becomes the
        live code with its five-minute life."""
        with self._lock:
            record = self._pending.get(phone)
            if record is None:
                return
            record["code"] = code
            record["expires_at"] = now + OTP_TTL_SECONDS

    def restore(self, phone: str, previous) -> None:
        """A failed send charges nothing (the law the 502 answers
        under): the reservation unwinds to exactly the record that
        stood before it, so the next attempt starts free."""
        with self._lock:
            record = self._pending.get(phone)
            if record is None or record["code"] is not None:
                return  # already confirmed (or gone) — never touch it
            if previous is None:
                self._pending.pop(phone, None)
            else:
                self._pending[phone] = previous

    def verify(self, phone: str, code: str, now: float) -> bool:
        with self._lock:
            record = self._pending.get(phone)
            if record is not None and record["code"] is None:
                return False  # a reservation: the send is still on the wire —
                # refuse WITHOUT popping, the code the wire is carrying must live
            if record is None or now > record["expires_at"]:
                self._pending.pop(phone, None)
                return False
            if record["attempts"] >= OTP_MAX_ATTEMPTS:
                self._pending.pop(phone, None)
                return False
            if not secrets.compare_digest(record["code"], str(code or "")):
                record["attempts"] += 1
                if record["attempts"] >= OTP_MAX_ATTEMPTS:
                    self._pending.pop(phone, None)
                return False
            self._pending.pop(phone, None)
            return True


CODES = _Codes()


def send_otp_sms(phone: str, code: str) -> None:
    """One login code down the panel — the pattern send as verified
    live: Api-Key header, the recipient in its LOCAL shape, the sender
    as the configured line, the code inside the pattern's own variable.
    A non-2XX raises (urlopen's own behavior); a 2XX whose body says
    error raises too — the panel answers 200 for some refusals, and a
    login that never queued must never look sent."""
    payload = json.dumps(
        {
            "code": FARAZ_PATTERN_CODE,
            "attributes": {FARAZ_PATTERN_PARAM: code},
            "recipient": phone,
            "line_number": FARAZ_FROM_NUMBER,
            "number_format": "english",
        }
    ).encode("utf-8")
    request = Request(
        FARAZ_SEND_URL,
        data=payload,
        headers={
            "Api-Key": FARAZ_API_KEY,
            "Accept": "application/json",
            "Content-Type": "application/json; charset=utf-8",
        },
        method="POST",
    )
    body = urlopen(request, timeout=15).read()
    try:
        verdict = json.loads(body).get("status")
    except (ValueError, AttributeError):
        verdict = None
    if verdict == "error":
        raise OtpSendFailed(body[:200].decode("utf-8", "replace"))


def request_otp(phone: str, now: float = None) -> str:
    """The request/verify pair's request half: reserve, send, then
    confirm — the cooldown/cap check and the slot's occupation are one
    atomic step (CODES.reserve), so a second request racing the first's
    in-flight send meets the cooldown instead of a second SMS, and a
    send that fails (OtpSendFailed from the panel's refusal or silence)
    unwinds its reservation — it charges nothing against the cooldown
    or the day. Returns nothing the caller may show: the code goes only
    down the SMS wire."""
    now = time.time() if now is None else now
    code = f"{secrets.randbelow(1_000_000):06d}"
    previous = CODES.reserve(phone, now)
    try:
        send_otp_sms(phone, code)
    except Exception as error:  # URLError, HTTPError, timeout, OSError
        CODES.restore(phone, previous)
        raise OtpSendFailed(str(error)) from error
    CODES.confirm(phone, code, now)


def verify_otp(phone: str, code: str, now: float = None) -> bool:
    """The pair's verify half: constant-time compare inside the lock,
    consumed on success, five wrong tries and the code is dead — a
    sixth guess is a new code's job, and expiry answers identically to
    a wrong guess (the guesser learns nothing from the difference)."""
    now = time.time() if now is None else now
    return CODES.verify(phone, code, now)
