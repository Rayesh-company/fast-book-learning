"""The security headers' contract (F-004 of the 2026-10-24 review):
every response carries X-Content-Type-Options: nosniff, a
Referrer-Policy, and a Content-Security-Policy rooted at 'self'; the
frame protection (CSP frame-ancestors 'none' + X-Frame-Options: DENY)
covers everything except the برنامک's own surfaces — /mobile and
/eitaa skip it, because a Telegram-style desktop client may open the
mini-app in an iframe."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import urllib.request

from tests.conftest import REPO_ROOT
from tests.helpers import ADMIN_EMAIL, TEST_PASSWORD, cookie_for, stop_gate, with_gate

sys.path.insert(0, REPO_ROOT)

import ui.serve as serve  # noqa: E402


class NoUpstream:
    def __call__(self, request, timeout=None):
        raise AssertionError(f"upstream called: {request.full_url}")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _get_headers(base, path, cookie=None):
    headers = {"Cookie": cookie} if cookie else {}
    request = urllib.request.Request(base + path, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers)


def test_every_response_carries_nosniff_referrer_and_csp(tmp_path):
    base, server, original = with_gate(tmp_path, NoUpstream())
    try:
        # The public sheet page...
        status, headers = _get_headers(base, "/")
        assert status == 200
        assert headers["X-Content-Type-Options"] == "nosniff"
        assert headers["Referrer-Policy"] == "no-referrer"
        csp = headers["Content-Security-Policy"]
        assert csp.startswith("default-src 'self'")
        assert "script-src 'self' 'unsafe-inline'" in csp
        assert "frame-ancestors 'none'" in csp
        assert headers["X-Frame-Options"] == "DENY"
        # ...and an anonymous JSON refusal ride the same stamps.
        status, headers = _get_headers(base, "/auth/me")
        assert status == 401
        assert headers["X-Content-Type-Options"] == "nosniff"
        assert "Content-Security-Policy" in headers
    finally:
        stop_gate(server, original)


def test_the_admin_console_is_framed_by_nothing(tmp_path):
    base, server, original = with_gate(tmp_path, NoUpstream())
    try:
        cookie = cookie_for(base, ADMIN_EMAIL, TEST_PASSWORD)
        status, headers = _get_headers(base, "/admin", cookie=cookie)
        assert status == 200
        assert headers["X-Frame-Options"] == "DENY"
        assert "frame-ancestors 'none'" in headers["Content-Security-Policy"]
    finally:
        stop_gate(server, original)


def test_the_bernamek_surfaces_skip_the_frame_protection(tmp_path):
    base, server, original = with_gate(tmp_path, NoUpstream())
    try:
        # The mobile face: CSP rides, the frame headers do not — Eita's
        # own desktop clients may iframe the mini-app.
        status, headers = _get_headers(base, "/mobile/")
        assert status == 200
        assert "Content-Security-Policy" in headers
        assert "frame-ancestors" not in headers["Content-Security-Policy"]
        assert "X-Frame-Options" not in headers

        # The 301 itself: urllib would follow it (and a no-redirect
        # opener raises the redirect as an HTTPError carrying the
        # response's own headers — exactly what we want to read).
        try:
            urllib.request.build_opener(_NoRedirect()).open(
                base + "/eitaa", timeout=10
            )
            raise AssertionError("/eitaa did not redirect")
        except urllib.error.HTTPError as exc:
            assert exc.code == 301
            assert "X-Frame-Options" not in dict(exc.headers)
    finally:
        stop_gate(server, original)
