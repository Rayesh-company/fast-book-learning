"""The Eita platform side of the برنامک (ADR-0021): the initData
signature the Eita client stamps on every app open, the server→user
message call, and the push that carries a settle to the Account's
bound Eita user.

The WebView opens our /eitaa page with the app's query-string initData
— ``user``, ``auth_date``, ``chat_instance``, … and the ``hash``. The
signature is the Telegram WebApp scheme Eita documents verbatim
(developer.eitaa.com/docs/Develop/AuthorizationViaHash): the pairs but
the hash sorted alphabetically and joined with newlines, signed twice —
HMAC-SHA256(key="WebAppData", message=bot_token) makes the key, that
key over the joined string makes the hexdigest. A match means Eita's
client minted the data and nobody tampered with it in between; the
auth_date beside it bounds how long a stolen string stays acceptable.

Messaging back runs through eitaayar.ir's ``sendMessage`` — token,
chat_id (the Eita user id), markdown text — and only reaches a user
who opened the app or pressed start (the documented write-access
rule); the daily quota is Eita's, not ours. Every call here fails
soft: a platform outage must never break the reply that produced the
news."""

from __future__ import annotations

import datetime
import hmac
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import parse_qsl
from urllib.request import Request, urlopen

# The bot token from the Eitaayar panel — the برنامک's credential on
# both sides: the initData's signing key and sendMessage's token. Read
# per call, the auth_secret() rule, so a test's monkeypatch.setenv is
# enough and a running server needs no restart to pick a new value up.
EITAA_BOT_TOKEN_ENV = "EITAA_BOT_TOKEN"

# The deploy path: the panel's token carries `$` sequences (a real one
# carried `$iDmYpyQ`), and the env layer mangles them — compose
# interpolates .env VALUES (an undefined `$VAR` amputates silently)
# and offers no escape there. So deploys write the token to a FILE on
# the persisted volume (docker exec, no interpolation anywhere) and
# point EITAA_BOT_TOKEN_FILE at it; the file wins over the env, and a
# token rotation is a file rewrite — no restart, no env layer.
EITAA_BOT_TOKEN_FILE_ENV = "EITAA_BOT_TOKEN_FILE"

# A minted initData is accepted for one hour. Eita's own verify API is
# stricter (one minute, single use) but that endpoint spends a round
# trip and a rate-limit budget on every open; the local signature plus
# a bounded auth_date is the documented offline check, and the bound
# token the exchange mints carries its own expiry beside it.
INITDATA_MAX_AGE = 3600

# The push's leash: eitaayar.ir is an external service on the reply
# path of nothing — the push is fired after the settle lands — but a
# hung connection must not pin a server thread.
SEND_TIMEOUT = 10

SEND_URL = "https://eitaayar.ir/api/app/sendMessage"


def bot_token() -> str:
    """The credential: the token FILE when one is configured and
    readable (the deploy path — raw bytes, no env layer to mangle
    them), else the plain env var (tests, dev). Empty answers empty —
    the server answers the برنامک's honest 503."""
    file_path = str(os.environ.get(EITAA_BOT_TOKEN_FILE_ENV, "") or "").strip()
    if file_path:
        try:
            value = Path(file_path).read_text(encoding="utf-8").strip()
        except OSError:
            value = ""
        if value:
            return value
    return str(os.environ.get(EITAA_BOT_TOKEN_ENV, "") or "").strip()


def parse_init_data(raw: str) -> dict:
    """The initData's pairs, order kept — ``hash`` beside the signed
    fields, values still URL-encoded exactly as they arrived (the
    ``user`` JSON must not be decoded before the signature check: the
    joined string is built from the raw encoded form)."""
    if not isinstance(raw, str) or not raw.strip():
        return {}
    return dict(parse_qsl(raw, keep_blank_values=True))


def validate_init_data(
    raw: str,
    token: str | None = None,
    max_age: int = INITDATA_MAX_AGE,
    now: float | None = None,
) -> dict | None:
    """The fields behind a genuine, fresh initData — or None. The
    documented check signs the pairs EXACTLY as they travel: the raw
    ``key=value`` pieces, percent-encoding and all, sorted and
    newline-joined, keyed by HMAC-SHA256("WebAppData", bot_token) and
    compared to the carried hash. 2026-10-20's live 401s taught the
    sharp edge: decoding first (parse_qsl) and signing the decoded
    form is self-consistent with a client that does the same — and
    can NEVER validate the real client, which signs the encoded form
    (every user JSON carries ``%7B%22...``). Decoding happens only
    AFTER the signature, for the payload's own extraction. A missing
    hash, an unknown signer, a tampered field, a stale auth_date, and
    an unconfigured bot all refuse the same None — the caller answers
    one 401 and never distinguishes why (the verify_token rule)."""
    token = bot_token() if token is None else token
    if not token or not isinstance(raw, str) or not raw.strip():
        return None
    received_hash = ""
    signed_pieces = []
    for piece in raw.split("&"):
        if piece.startswith("hash="):
            received_hash = piece[len("hash=") :]
        else:
            signed_pieces.append(piece)
    if not received_hash or not signed_pieces:
        return None
    check_string = "\n".join(sorted(signed_pieces))
    secret = hmac.new(b"WebAppData", token.encode("utf-8"), hashlib.sha256).digest()
    expected = hmac.new(secret, check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, received_hash):
        return None
    # The signature vouches for the RAW string; only now do the fields
    # get decoded — extraction, never signing.
    fields = parse_init_data(raw)
    try:
        auth_date = int(fields.get("auth_date", ""))
    except ValueError:
        return None
    moment = time_now() if now is None else now
    if abs(moment - auth_date) > max_age:
        return None
    try:
        fields["user"] = json.loads(fields.get("user", ""))
    except ValueError:
        return None
    if not isinstance(fields.get("user"), dict):
        return None
    user = fields["user"]
    if not isinstance(user.get("id"), int):
        return None
    fields.pop("hash", None)
    fields["auth_date"] = auth_date
    return fields


def init_data_user(fields: dict) -> dict:
    """The validated user row: the Eita id the stores key by, the
    names the برنامک greets with, and the write-access flag the
    push's reach rides on."""
    user = fields.get("user") or {}
    return {
        "id": user.get("id"),
        "first_name": str(user.get("first_name", "") or ""),
        "last_name": str(user.get("last_name", "") or ""),
        "language_code": str(user.get("language_code", "") or ""),
        "allows_write_to_pm": bool(user.get("allows_write_to_pm")),
    }


def send_message(chat_id, text: str, token: str | None = None) -> bool:
    """One server→user message through eitaayar.ir; True only on the
    documented ``{"ok": true}`` reply. A user who never opened the
    app, a spent daily quota, and a dead network all answer False —
    the push is a bell, never a record (ADR-0020's events law) and
    never a failure on the settle that fired it."""
    token = bot_token() if token is None else token
    if not token or not isinstance(chat_id, (int, str)) or not str(chat_id).strip():
        return False
    try:
        body = json.dumps(
            {"token": token, "chat_id": chat_id, "text": str(text)},
            ensure_ascii=False,
        ).encode("utf-8")
        request = Request(
            SEND_URL,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=SEND_TIMEOUT) as response:
            payload = json.loads(response.read() or b"{}")
        return payload.get("ok") is True
    except Exception:
        return False


def push_to_account(account: str, text: str) -> int:
    """Carry one settle to every Eita user bound to the Account.
    Returns the deliveries that answered ok — the console's future
    read, and the tests' assertion point."""
    try:
        from ui import eitaa_store
    except ImportError:  # the container runs this file beside the modules
        import eitaa_store

    sent = 0
    for binding in eitaa_store.bindings_for_account(account):
        if send_message(binding["chat_id"], text):
            sent += 1
    return sent


def time_now() -> float:
    return datetime.datetime.now(datetime.timezone.utc).timestamp()
