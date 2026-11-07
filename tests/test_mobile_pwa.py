"""The mobile face's installable-PWA contract (ADR-0026), pinned the
way test_pwa_docs.py pins the sheet's: the manifest's shape, the
worker's shell-only whitelist, the page's head marks, the serve.py
allowance, and one wire test — the manifest and the worker must answer
with the types and the header the install actually requires."""

import json
import struct
import urllib.request

from tests.conftest import REPO_ROOT
from tests.helpers import stop_gate, with_gate

UI = REPO_ROOT / "ui"
MOBILE = UI / "mobile"
MANIFEST = MOBILE / "manifest.webmanifest"
SW = MOBILE / "sw.js"
PAGE = MOBILE / "index.html"
PWA = MOBILE / "pwa.mjs"


def _png_size(path):
    head = path.read_bytes()[:24]
    assert head[:8] == b"\x89PNG\r\n\x1a\n", f"{path.name} is not a PNG"
    width, height = struct.unpack(">II", head[16:24])
    return width, height


class EmptyUpstream:
    """The seam answering an empty context doc list — enough to boot
    the gate server for the wire test. Callable, the seam's shape."""

    def __call__(self, request, timeout=None):
        class _Body:
            def read(self):
                return b"[]"

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        return _Body()


def test_manifest_is_an_rtl_farsi_standalone_app():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert manifest["dir"] == "rtl"
    assert manifest["lang"] == "fa"
    assert manifest["display"] == "standalone"
    # The installed app opens at the bare root — the fahva face's whole
    # point (ADR-0025): the URL bar never carries a path.
    assert manifest["start_url"] == "/"
    assert manifest["scope"] == "/"
    assert manifest["id"] == "/mobile/"
    # The name is the mobile face's own product word — its page title.
    assert manifest["name"] == "کتاب و همراه"
    assert manifest["short_name"] == "کتاب و همراه"
    # The splash and the chrome ride the mobile page's own light paper.
    assert manifest["theme_color"] == "#faf8f3"
    assert manifest["background_color"] == "#faf8f3"


def test_manifest_icons_exist_and_dimensions_match_the_claim():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    icons = manifest["icons"]
    assert any(icon.get("purpose") == "maskable" for icon in icons), (
        "an OS mask of any shape must keep the mark whole"
    )
    assert len(icons) >= 3
    for icon in icons:
        path = UI / icon["src"].lstrip("/")
        assert path.exists(), f"manifest names {icon['src']}, which is not on disk"
        width, height = _png_size(path)
        claimed_w, claimed_h = (int(v) for v in icon["sizes"].split("x"))
        assert (width, height) == (claimed_w, claimed_h), (
            f"{icon['src']} is {width}x{height}, the manifest claims {icon['sizes']}"
        )
        assert icon["type"] == "image/png"


def test_worker_owns_only_the_shell_whitelist_and_never_the_product():
    source = SW.read_text(encoding="utf-8")
    # One versioned cache — a bump is the update story (v2, 2026-11-06:
    # the shell era turned the static families network-first, and the
    # bump discarded the stale-while-revalidate v1 home of modules the
    # operator's phone kept serving one restart behind the deploys).
    assert 'const SHELL_CACHE = "cwb-mobile-shell-v2"' in source
    # The worker only ever speaks GET.
    assert 'request.method !== "GET"' in source
    # Navigations AND the shell's static families are network-first:
    # the 2026-09-11 freshness contract now covers the modules too —
    # the app IS the web, so a deploy must never leave a stale face
    # one restart behind. The navigate check comes BEFORE the
    # whitelist: the page itself lives under /mobile/ and must never
    # be served stale.
    assert 'request.mode === "navigate"' in source
    assert source.index('request.mode === "navigate"') < source.index(
        "if (isShellAsset(url))"
    )
    # The shell assets fall back to the cache only when the wire
    # fails — never as the freshness source.
    assert "fetch(request)" in source
    assert "caches.match(request)" in source
    # The whitelist is the whole contract: only static families are
    # owned, everything else passes through untouched.
    for prefix in ('"/mobile/"', '"/vendor/"', '"/book-reader/"', '"/icons/"'):
        assert f"url.pathname.startsWith({prefix})" in source, (
            f"the whitelist must name {prefix}"
        )
    # No metered, per-Account family is ever named as an owner.
    for forbidden in ('"/auth', '"/research', '"/events', '"/ota'):
        assert forbidden not in source
    # The pdf engine stays out of the install (ADR-0026): several MB
    # down the Iran-to-box path at install time is a tax on everyone.
    assert "pdf.min.mjs" not in source


def test_page_links_the_manifest_and_marks_the_ios_doors():
    source = PAGE.read_text(encoding="utf-8")
    assert '<link rel="manifest" href="/mobile/manifest.webmanifest">' in source
    assert 'href="/icons/apple-touch-icon.png"' in source
    assert 'name="apple-mobile-web-app-capable"' in source
    assert 'name="apple-mobile-web-app-title"' in source


def test_registration_rides_the_allowance_scope():
    source = PWA.read_text(encoding="utf-8")
    assert 'register("/mobile/sw.js", { scope: "/" })' in source
    boot = (MOBILE / "app.mjs").read_text(encoding="utf-8")
    assert "registerServiceWorker" in boot


def test_serve_grants_the_worker_its_scope():
    source = (UI / "serve.py").read_text(encoding="utf-8")
    assert '"/mobile/sw.js"' in source
    assert '"Service-Worker-Allowed", "/"' in source


def test_the_wire_answers_the_install_requirements(tmp_path):
    base, server, original = with_gate(tmp_path, EmptyUpstream())
    try:
        with urllib.request.urlopen(base + "/mobile/sw.js") as response:
            assert response.status == 200
            assert response.headers["Service-Worker-Allowed"] == "/"
            assert response.headers["Content-Type"].startswith("text/javascript")
        with urllib.request.urlopen(base + "/mobile/manifest.webmanifest") as response:
            assert response.status == 200
            assert response.headers["Content-Type"] == "application/manifest+json"
            body = json.loads(response.read().decode("utf-8"))
            assert body["name"] == "کتاب و همراه"
    finally:
        stop_gate(server, original)
