"""The PWA shell's recorded contract (ADR-0019), pinned as docs tests:
the manifest's shape, the worker's never-cache promise, the pinned
content types, the shipping lock, and the icons' real dimensions —
the install must not depend on a registry, a CDN, or a lucky guess."""

import json
import struct

from tests.conftest import REPO_ROOT

UI = REPO_ROOT / "ui"
MANIFEST = UI / "manifest.webmanifest"
SW = UI / "sw.js"
SHEET = UI / "index.html"
ICONS = UI / "icons"
DOCKERFILE = UI / "Dockerfile"


def _png_size(path):
    head = path.read_bytes()[:24]
    assert head[:8] == b"\x89PNG\r\n\x1a\n", f"{path.name} is not a PNG"
    width, height = struct.unpack(">II", head[16:24])
    return width, height


def test_manifest_is_an_rtl_farsi_standalone_shell():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert manifest["dir"] == "rtl"
    assert manifest["lang"] == "fa"
    assert manifest["display"] == "standalone"
    assert manifest["start_url"] == "/"
    assert manifest["scope"] == "/"
    # The splash and the chrome ride the sheet's own light paper.
    assert manifest["theme_color"] == "#d8cbae"
    assert manifest["background_color"] == "#d8cbae"
    # The names are DRAFT pending PM approval (CONTEXT.md's roster) —
    # the short name is the product word the sheet already carries.
    assert manifest["short_name"] == "نشست"
    assert manifest["name"].startswith("نشست")


def test_manifest_icons_exist_and_dimensions_match_the_claim():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    icons = manifest["icons"]
    assert any(icon.get("purpose") == "maskable" for icon in icons), (
        "an OS mask of any shape must keep the mark whole"
    )
    for icon in icons:
        path = UI / icon["src"].lstrip("/")
        assert path.exists(), f"manifest names {icon['src']}, which is not on disk"
        width, height = _png_size(path)
        claimed_w, claimed_h = (int(v) for v in icon["sizes"].split("x"))
        assert (width, height) == (claimed_w, claimed_h), (
            f"{icon['src']} is {width}x{height}, the manifest claims {icon['sizes']}"
        )
        assert icon["type"] == "image/png"


def test_worker_owns_the_shell_and_never_the_product():
    source = SW.read_text(encoding="utf-8")
    # One versioned cache — a bump is the update story.
    assert 'const SHELL_CACHE = "cwb-shell-v1"' in source
    # Navigations network-first: the 2026-09-11 freshness contract
    # stands — the cached shell is the OFFLINE answer, never the deploy's.
    assert 'request.mode === "navigate"' in source
    assert "fetch(request)" in source
    assert "ignoreSearch: true" in source
    # The worker only ever speaks GET; every metered, per-Account route
    # passes through untouched.
    assert 'request.method !== "GET"' in source


def test_worker_precaches_the_offline_shell():
    source = SW.read_text(encoding="utf-8")
    for asset in (
        '"/"',
        '"/manifest.webmanifest"',
        '"/icons/icon-192.png"',
        '"/icons/icon-512.png"',
        '"/vendor/fonts/Vazirmatn-Regular.woff2"',
        '"/vendor/pdf.min.mjs"',
    ):
        assert asset in source, f"the shell cache must name {asset}"


def test_sheet_links_the_shell_and_registers_the_worker():
    source = SHEET.read_text(encoding="utf-8")
    assert '<link rel="manifest" href="/manifest.webmanifest" />' in source
    assert 'navigator.serviceWorker.register("/sw.js")' in source
    # The head marks: the favicon and the iOS metas Safari still reads.
    assert 'href="/icons/apple-touch-icon.png"' in source
    assert 'name="apple-mobile-web-app-capable"' in source
    assert 'name="apple-mobile-web-app-title"' in source
    # The install chip: string-free markup, the pinned label rides JS.
    assert 'id="pwa-install"' in source
    assert 'PWA_INSTALL_LABEL = "نصب برنامه"' in source
    assert "beforeinstallprompt" in source
    assert "appinstalled" in source
    # The hidden attribute must hide whatever the element's display —
    # .browse-btn's display used to beat the UA rule and the toggled
    # doors (the admin link, the install chip) showed themselves.
    assert "[hidden] {\n        display: none !important;\n      }" in source


def test_serve_pins_the_static_types_no_registry_in_the_path():
    source = (UI / "serve.py").read_text(encoding="utf-8")
    assert '".webmanifest": "application/manifest+json"' in source
    assert '".js": "text/javascript; charset=utf-8"' in source
    assert '".mjs": "text/javascript; charset=utf-8"' in source
    assert '".woff2": "font/woff2"' in source


def test_dockerfile_ships_the_shell():
    source = DOCKERFILE.read_text(encoding="utf-8")
    copy_line = next(
        line for line in source.splitlines() if line.startswith("COPY serve.py")
    )
    assert "manifest.webmanifest" in copy_line
    assert "sw.js" in copy_line
    assert "COPY icons /app/icons" in source


def test_icons_are_generated_from_source():
    generator = REPO_ROOT / "tools" / "make_pwa_icons.py"
    assert generator.exists()
    source = generator.read_text(encoding="utf-8")
    # The mark is the sheet's palette — the generator names its colors.
    assert "PAPER" in source and "INK" in source
    # The committed set is exactly what the generator writes.
    names = {path.name for path in ICONS.glob("*.png")}
    assert names == {
        "icon-192.png",
        "icon-512.png",
        "icon-maskable-192.png",
        "icon-maskable-512.png",
        "apple-touch-icon.png",
    }
    assert _png_size(ICONS / "apple-touch-icon.png") == (180, 180)
