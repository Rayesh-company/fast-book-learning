"""The anonymous doors' per-IP throttle (F-002/F-003 of the 2026-10-24
security review): /auth/login and the two OTP knocks are the only
endpoints an unauthenticated stranger can reach, so they are the only
ones a per-IP bound protects.

Two shapes, because the doors differ:
- The login's bucket counts FAILURES only (blocked() before the
  verify, record() after a refused credential) — a successful login
  never feeds it, so a shared machine's honest users never lock each
  other out and the test suite's many logins stay free.
- The OTP request's and verify's buckets count EVERY attempt — the
  phone-account oracle (the no-Account 404 against the code send) is
  itself one honest-looking request, so the budget must spend on all
  of them.

Fixed-window counters in process memory: one server process serves
the sheet (the compose shape), so a shared store buys nothing yet; a
restart empties the buckets, which only widens a window by a
restart's worth.

The key is X-Real-IP when present — nginx stamps it
(ops/nginx/booksai.conf) and the deployed server binds 127.0.0.1
only (compose.production.yaml), so every direct client IS the proxy;
a dev machine without nginx falls back to the socket address.
"""

from __future__ import annotations

import threading
import time

_LOCK = threading.Lock()
_BUCKETS: dict[tuple[str, str], tuple[int, float]] = {}

# The buckets: (name, budget, window seconds). The login's ten
# failures per fifteen minutes is the recorded AppSec floor; the OTP
# request's thirty covers a family of phones sharing one address
# while still pricing out number-mining; the verify's thirty prices a
# guesser that rotates numbers against the per-phone five-try cap.
LOGIN_FAILURES = ("login-fail", 10, 15 * 60)
OTP_REQUESTS = ("otp-request", 30, 15 * 60)
OTP_VERIFIES = ("otp-verify", 30, 15 * 60)


def client_ip(handler) -> str:
    """The throttling address: nginx's X-Real-IP when the proxy stamped
    it, else the socket's own address."""
    forwarded = (handler.headers.get("X-Real-IP") or "").strip()
    if forwarded:
        return forwarded
    address = getattr(handler, "client_address", None)
    return address[0] if address else "unknown"


def blocked(bucket, ip: str) -> bool:
    """Whether this IP's bucket has already spent its window's budget —
    the caller refuses BEFORE doing the thing the bound protects."""
    name, limit, _window = bucket
    now = time.monotonic()
    with _LOCK:
        entry = _BUCKETS.get((name, ip))
        return entry is not None and entry[1] > now and entry[0] >= limit


def record(bucket, ip: str) -> None:
    """One more unit into the bucket (a failed login, one OTP knock)."""
    name, _limit, window = bucket
    now = time.monotonic()
    with _LOCK:
        key = (name, ip)
        entry = _BUCKETS.get(key)
        if entry is None or entry[1] <= now:
            _BUCKETS[key] = (1, now + window)
        else:
            _BUCKETS[key] = (entry[0] + 1, entry[1])


def allow(bucket, ip: str) -> bool:
    """One attempt against the bucket: False when the window's budget
    is spent (the caller answers the 429), True with the slot consumed
    otherwise."""
    if blocked(bucket, ip):
        return False
    record(bucket, ip)
    return True


def reset() -> None:
    """Empty every bucket — the tests' isolation seam (the ledger's
    per-test patch shape): one test's hammering must never spend the
    next test's budget."""
    with _LOCK:
        _BUCKETS.clear()
