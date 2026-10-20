"""The برنامک's contract (ADR-0021): the Eita client of the one
backend. The initData the Eita WebView stamps must pass the
documented HMAC check before anything answers; the exchange mints the
Account's ordinary token; the link is the ONE login door asked once;
unlinking moves only the caller's own row; and the settle's push is
opt-in, bell-shaped, and never a record."""

import json
import hashlib
import hmac
import sys
import time
import urllib.parse
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from tests.helpers import (
    ADMIN_EMAIL,
    TEST_PASSWORD,
    account_email_for_phone,
    ensure_account,
    stop_gate,
    with_gate,
)
from tests.conftest import REPO_ROOT

sys.path.insert(0, str(REPO_ROOT))

from ui import eitaa, eitaa_store, serve  # noqa: E402


# The test bot token: the برنامک's credential the initData's signature
# is checked against. Every server in this module boots with it set.
TEST_TOKEN = "5768337691:test-eitaa-bot-token"

PHONE = "09130000000"


class _Body:
    """The urlopen seam's reply: a context manager whose read() is the
    bytes — the shape ask.py's searcher unpacks."""

    def __init__(self, body):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class EmptyUpstream:
    """The upstream seam that answers an empty context doc list: the
    ask's honest {"sources": []} is a settled reply, and the chat it
    records is all the phase gate needs."""

    def __call__(self, request, timeout=None):
        return _Body(b"[]")


def _sign(check_string: str, token: str = TEST_TOKEN) -> str:
    """The documented two-step signature, test-side: the same six
    steps eitaa.validate_init_data runs, written independently so a
    bug on either side cannot hide behind the other."""
    secret = hmac.new(b"WebAppData", token.encode("utf-8"), hashlib.sha256).digest()
    return hmac.new(
        secret, check_string.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def _init_data(
    user_id=279058397,
    first_name="مهدی",
    token=TEST_TOKEN,
    auth_date=None,
    omit_hash=False,
):
    """One minted initData string, the Eita client's shape."""
    user = json.dumps(
        {
            "id": user_id,
            "first_name": first_name,
            "last_name": "",
            "language_code": "fa",
            "allows_write_to_pm": True,
        },
        ensure_ascii=False,
    )
    pairs = [
        ("auth_date", str(int(auth_date if auth_date is not None else time.time()))),
        ("chat_instance", "-3788475317572404878"),
        ("chat_type", "private"),
        ("user", user),
    ]
    encoded = urllib.parse.urlencode(pairs)
    check = "\n".join(f"{key}={value}" for key, value in sorted(pairs))
    suffix = "" if omit_hash else "&hash=" + _sign(check, token)
    return encoded + suffix


def _tamper(raw: str) -> str:
    """A deterministic one-hex-digit change on the trailing hash."""
    return raw[:-1] + ("1" if raw[-1] != "1" else "2")


def _post(base, path, payload, token_value=None):
    headers = {"Content-Type": "application/json"}
    if token_value is not None:
        headers["Authorization"] = f"Bearer {token_value}"
    request = Request(
        base + path, data=json.dumps(payload).encode("utf-8"), headers=headers
    )
    try:
        with urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read() or b"{}")
    except HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def _get(base, path, token_value=None):
    headers = {"Authorization": f"Bearer {token_value}"} if token_value else {}
    request = Request(base + path, headers=headers)
    try:
        with urlopen(request, timeout=10) as response:
            body = response.read()
            return response.status, json.loads(body) if body else {}
    except HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def _gate(tmp_path, monkeypatch, upstream=None):
    """The gated server with the Eita env and the binding store
    pointed into the test's own tmp_path — the with_gate pattern plus
    the two patches this store's contract rides on."""
    monkeypatch.setenv("EITAA_BOT_TOKEN", TEST_TOKEN)
    monkeypatch.delenv(serve.EITAA_PUSH_ENABLED_ENV, raising=False)
    eitaa_store.EITAA_DB = tmp_path / "eitaa.sqlite3"
    return with_gate(tmp_path, upstream or EmptyUpstream())


def _login_token(base):
    status, payload = _post(
        base,
        "/auth/login",
        {"email": ADMIN_EMAIL, "password": TEST_PASSWORD},
    )
    assert status == 200, payload
    return payload["token"]


def test_the_token_prefers_the_file_over_the_env(tmp_path, monkeypatch):
    # The deploy path: the panel's token carries `$` sequences the env
    # layer interpolates, so deploys write the raw bytes to a file and
    # point EITAA_BOT_TOKEN_FILE at it. The file wins when it holds
    # anything; a missing or empty file falls back to the env — and a
    # poisoned env value behind a live file can never leak through.
    env_token = "123:env-token"
    file_token = "BqZ7/with-$dollar-and-@at"
    token_file = tmp_path / "eitaa-bot-token"
    monkeypatch.setenv("EITAA_BOT_TOKEN", env_token)
    monkeypatch.setenv("EITAA_BOT_TOKEN_FILE", str(token_file))
    assert eitaa.bot_token() == env_token  # no file yet: the env path
    token_file.write_text(file_token + "\n", encoding="utf-8")
    assert eitaa.bot_token() == file_token  # the file wins, stripped
    token_file.write_text("", encoding="utf-8")
    assert eitaa.bot_token() == env_token  # empty file: the env path
    monkeypatch.setenv("EITAA_BOT_TOKEN_FILE", str(tmp_path / "missing"))
    assert eitaa.bot_token() == env_token  # unreadable file: env path


def test_init_data_hmac_accepts_and_refuses(monkeypatch):
    monkeypatch.setenv("EITAA_BOT_TOKEN", TEST_TOKEN)
    fields = eitaa.validate_init_data(_init_data())
    assert fields is not None
    assert fields["user"]["id"] == 279058397
    assert eitaa.init_data_user(fields)["id"] == 279058397
    assert eitaa.init_data_user(fields)["first_name"] == "مهدی"
    # A tampered field, an unknown signer, a stale stamp, a missing
    # hash, and an unconfigured bot all refuse the same None — the
    # caller answers one 401 and never distinguishes why.
    assert eitaa.validate_init_data(_tamper(_init_data())) is None
    assert eitaa.validate_init_data(_init_data(token="1:other-token")) is None
    assert eitaa.validate_init_data(
        _init_data(auth_date=int(time.time()) - 7201)
    ) is None
    assert eitaa.validate_init_data(_init_data(omit_hash=True)) is None
    monkeypatch.setenv("EITAA_BOT_TOKEN", "")
    assert eitaa.validate_init_data(_init_data()) is None


def test_the_exchange_mints_the_shared_token(tmp_path, monkeypatch):
    base, server, original = _gate(tmp_path, monkeypatch)
    try:
        # An unbound user is not an error: bound:false names the door.
        status, payload = _post(base, "/eitaa/auth", {"initData": _init_data()})
        assert status == 200
        assert payload["bound"] is False
        assert payload["user"]["first_name"] == "مهدی"
        # The one door asked once: the real credential check, the
        # identical 401 an unknown email and a wrong password share.
        email = ensure_account(PHONE)
        status, payload = _post(
            base,
            "/eitaa/link",
            {"initData": _init_data(), "email": email, "password": "wrong"},
        )
        assert status == 401
        assert payload["detail"] == serve.AUTH_BAD_CREDENTIALS_DETAIL
        status, payload = _post(
            base,
            "/eitaa/link",
            {"initData": _init_data(), "email": email, "password": TEST_PASSWORD},
        )
        assert status == 200 and payload["bound"] is True
        # The token is the platform's ordinary signed payload — the
        # shared API opens to it exactly as to a login's.
        claims = serve.verify_token(payload["token"])
        assert claims["email"] == email
        status, payload = _get(base, "/sessions", payload["token"])
        assert status == 200 and payload == {"sessions": []}
        # The next open rides silently: no credentials anywhere.
        status, payload = _post(base, "/eitaa/auth", {"initData": _init_data()})
        assert status == 200 and payload["bound"] is True
        assert serve.verify_token(payload["token"])["email"] == email
    finally:
        stop_gate(server, original)


def test_a_tampered_or_stale_init_data_refuses_everywhere(tmp_path, monkeypatch):
    base, server, original = _gate(tmp_path, monkeypatch)
    try:
        for raw in (_tamper(_init_data()), _init_data(auth_date=int(time.time()) - 7201)):
            status, payload = _post(base, "/eitaa/auth", {"initData": raw})
            assert status == 401
            assert payload["detail"] == serve.EITAA_AUTH_401_DETAIL
            status, payload = _post(
                base,
                "/eitaa/link",
                {"initData": raw, "email": ADMIN_EMAIL, "password": TEST_PASSWORD},
            )
            assert status == 401
            assert payload["detail"] == serve.EITAA_AUTH_401_DETAIL
            assert eitaa_store.get_binding(279058397) is None
    finally:
        stop_gate(server, original)


def test_unlink_moves_only_the_callers_own_row(tmp_path, monkeypatch):
    base, server, original = _gate(tmp_path, monkeypatch)
    try:
        email = ensure_account(PHONE)
        status, payload = _post(
            base,
            "/eitaa/link",
            {"initData": _init_data(), "email": email, "password": TEST_PASSWORD},
        )
        assert status == 200 and payload["bound"] is True
        own_token = payload["token"]
        # A foreign Bearer with a real initData moves nothing.
        status, payload = _post(
            base,
            "/eitaa/unlink",
            {"initData": _init_data()},
            token_value=_login_token(base),
        )
        assert status == 200 and payload["deleted"] is False
        assert eitaa_store.get_binding(279058397)["account"] == email
        # The caller's own act moves the caller's own row.
        status, payload = _post(
            base, "/eitaa/unlink", {"initData": _init_data()}, token_value=own_token
        )
        assert status == 200 and payload["deleted"] is True
        status, payload = _post(base, "/eitaa/auth", {"initData": _init_data()})
        assert status == 200 and payload["bound"] is False
    finally:
        stop_gate(server, original)


def test_the_push_is_opt_in_and_never_a_record(tmp_path, monkeypatch):
    base, server, original = _gate(tmp_path, monkeypatch)
    try:
        email = ensure_account(PHONE)
        eitaa_store.bind(279058397, email, chat_id=279058397)
        sent = []
        monkeypatch.setattr(
            eitaa,
            "send_message",
            lambda chat_id, text, token=None: sent.append((chat_id, text)) or True,
        )
        # Off by default: the settle's bell spends no quota.
        serve._eitaa_push(email, "پیام")
        assert sent == []
        monkeypatch.setenv(serve.EITAA_PUSH_ENABLED_ENV, "1")
        serve._eitaa_push(email, "پیام")
        assert sent == [(279058397, "پیام")]
        # A foreign Account's bindings never hear another's news.
        serve._eitaa_push("nobody@sheet.test", "پیام")
        assert sent == [(279058397, "پیام")]
        # An unreachable platform fails soft — no raise, no crash.
        def dead(chat_id, text, token=None):
            raise OSError("eitaayar unreachable")

        monkeypatch.setattr(eitaa, "send_message", dead)
        serve._eitaa_push(email, "پیام")
    finally:
        stop_gate(server, original)


def test_the_settled_answer_fires_the_opted_in_push(tmp_path, monkeypatch):
    base, server, original = _gate(tmp_path, monkeypatch)
    try:
        email = ensure_account(PHONE)
        eitaa_store.bind(279058397, email, chat_id=279058397)
        monkeypatch.setenv(serve.EITAA_PUSH_ENABLED_ENV, "1")
        sent = []
        monkeypatch.setattr(
            eitaa,
            "send_message",
            lambda chat_id, text, token=None: sent.append((chat_id, text)) or True,
        )
        # The composer seam: the writer's canned article, the real
        # settle path — the push rides the blocks' landing, beside the
        # live line's chat.quoted.
        monkeypatch.setattr(
            serve,
            "compose_quoted_answer",
            lambda question, answer, sources, conversation_tail=None: (
                [{"type": "paragraph", "parts": [{"text": "متن پیوند.", "quote": "نقل"}]}],
                False,
            ),
        )
        token = _post(base, "/eitaa/auth", {"initData": _init_data()})[1]["token"]
        # The phase gate needs one chat today; the ask records it.
        status, payload = _post(
            base, "/ask", {"query": "پرسشِ فشار؟"}, token_value=token
        )
        assert status == 200
        status, payload = _post(
            base,
            "/quoted-answer",
            {
                "question": "پرسشِ فشار؟",
                "answer": "",
                "sources": [
                    {"reference": "chunk 1 of document tarhe-kolli", "passage": "نقل"}
                ],
                "session_id": 1,
                "ask_key": "ask-1",
                "chat_id": payload["chat_id"],
            },
            token_value=token,
        )
        assert status == 200 and payload["blocks"]
        assert sent == [(279058397, serve.EITAA_PUSH_SETTLED_TEXT)]
    finally:
        stop_gate(server, original)


def test_the_page_and_its_routes_are_the_sheets_own():
    # The برنامک speaks the shared API (ADR-0020's law, extended):
    # every path the page fetches is a route serve.py serves, and the
    # page loads the official SDK from its own URL — never vendored.
    page = (REPO_ROOT / "ui" / "eitaa_app.html").read_text(encoding="utf-8")
    server = (REPO_ROOT / "ui" / "serve.py").read_text(encoding="utf-8")
    assert "https://developer.eitaa.com/eitaa-web-app.js" in page
    for route in (
        "/eitaa/auth",
        "/eitaa/link",
        "/eitaa/unlink",
        "/sessions",
        "/ask",
        "/quote-selection",
        "/quoted-answer",
        "/usage/live",
    ):
        assert route in page, f"the page never calls {route}"
        assert f'"{route}"' in server, f"the page calls {route}, which no route serves"
    # The dynamic read rides the sessions' own path shape.
    assert 'api(`/sessions/${currentSitting}`)' in page
    assert '"/sessions/"' in server
    # The push is wired beside the settle, and opt-in by env.
    assert "_eitaa_push(account, EITAA_PUSH_SETTLED_TEXT)" in server
    assert serve.EITAA_PUSH_ENABLED_ENV == "EITAA_PUSH_ENABLED"
