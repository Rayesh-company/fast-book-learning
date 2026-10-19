"""Rule 001's recorded contract (docs/rules/001-no-new-apks.md): no new
APKs — every mobile change ships over-the-air, and each installed app
updates itself on its next launch with zero user action. The pins below
hold the whole chain: the law, the AGENTS.md enforcement, the client
config, the /ota routes, the publish script, and the skill."""

import json
import sys

from tests.conftest import REPO_ROOT

sys.path.insert(0, str(REPO_ROOT))

from tests.helpers import stop_gate, with_gate  # noqa: E402
from ui import serve  # noqa: E402


class NoUpstream:
    def __call__(self, request, timeout=None):
        raise AssertionError("the OTA routes must never phone an upstream")


def test_the_law_exists_and_binds_every_session():
    law = (REPO_ROOT / "docs" / "rules" / "001-no-new-apks.md").read_text(encoding="utf-8")
    # The two clauses, in the PM's own words.
    assert "ساخت فایل APK جدید ممنوع است" in law
    assert "بدون اینکه کاربر کوچک‌ترین کاری بکند" in law
    # The forbidden commands are named.
    for forbidden in ("assembleRelease", "expo run:android", "EAS Build"):
        assert forbidden in law
    # The single exception is explicit and gated on the PM's writing.
    assert "تأیید کتبی مدیر محصول" in law
    # The rules index carries it and names the root exceptions.
    index = (REPO_ROOT / "docs" / "rules" / "README.md").read_text(encoding="utf-8")
    assert "001-no-new-apks.md" in index
    assert "AGENTS.md" in index  # the tooling exception is recorded, not accidental


def test_agents_md_points_at_the_laws():
    agents = (REPO_ROOT / "AGENTS.md").read_text(encoding="utf-8")
    assert "docs/rules/" in agents
    assert "No new APKs" in agents
    assert "publish_ota.py" in agents


def test_the_app_carries_the_updates_client():
    app_json = json.loads(
        (REPO_ROOT / "mobile" / "app.json").read_text(encoding="utf-8")
    )
    expo = app_json["expo"]
    assert expo["updates"]["url"] == "https://booksai.rayesh-team.ir/ota"
    assert expo["updates"]["checkAutomatically"] == "ON_LOAD"
    assert expo["runtimeVersion"] == {"policy": "appVersion"}
    package = (REPO_ROOT / "mobile" / "package.json").read_text(encoding="utf-8")
    assert "expo-updates" in package
    # The native manifest carries the config plugin's stamps — the
    # binary checks on every launch.
    manifest = (
        REPO_ROOT / "mobile" / "android" / "app" / "src" / "main" / "AndroidManifest.xml"
    ).read_text(encoding="utf-8")
    assert "expo.modules.updates.ENABLED" in manifest
    assert 'EXPO_UPDATES_CHECK_ON_LAUNCH" android:value="ALWAYS"' in manifest


def test_the_sheets_backend_serves_the_ota_routes(tmp_path, monkeypatch):
    ota_dir = tmp_path / "ota"
    (ota_dir / "current").mkdir(parents=True)
    monkeypatch.setattr(serve, "OTA_DIR", ota_dir)
    base, server, original = with_gate(tmp_path, NoUpstream())
    try:
        import urllib.request

        # No payload yet: the protocol's "you are current" — 204.
        request = urllib.request.Request(base + "/ota?runtimeVersion=1.0.0")
        with urllib.request.urlopen(request, timeout=10) as response:
            assert response.status == 204
            assert response.read() == b""
        # A published manifest serves verbatim.
        manifest = {"id": "test-update", "runtimeVersion": "1.0.0",
                    "launchAsset": {"url": f"{base}/ota/current/bundle.js"},
                    "assets": []}
        (ota_dir / "manifest.json").write_text(
            json.dumps(manifest), encoding="utf-8"
        )
        with urllib.request.urlopen(
            urllib.request.Request(base + "/ota"), timeout=10
        ) as response:
            assert response.status == 200
            assert json.load(response) == manifest
        # Bundle files ride immutable, and traversal stays out.
        (ota_dir / "current" / "bundle.js").write_bytes(b"// bundle")
        with urllib.request.urlopen(
            urllib.request.Request(base + "/ota/current/bundle.js"), timeout=10
        ) as response:
            assert response.status == 200
            assert response.headers["Cache-Control"] == (
                "public, max-age=31536000, immutable"
            )
            assert response.read() == b"// bundle"
        import urllib.error

        escaped = urllib.request.Request(
            base + "/ota/current/..%2f..%2fserve.py"
        )
        try:
            urllib.request.urlopen(escaped, timeout=10)
            raised = False
        except urllib.error.HTTPError as exc:
            raised = exc.code == 404
        assert raised, "a traversal outside current/ must answer 404"
    finally:
        stop_gate(server, original)


def test_the_publish_script_and_the_skill_exist():
    script = (REPO_ROOT / "scripts" / "publish_ota.py").read_text(encoding="utf-8")
    assert "manifest.json" in script
    assert "runtimeVersion" in script
    assert "launchAsset" in script
    skill = (
        REPO_ROOT / "docs" / "skills" / "ship-mobile-update" / "SKILL.md"
    ).read_text(encoding="utf-8")
    assert "publish_ota.py" in skill
    assert "assembleRelease" in skill  # the forbidden list is in the skill too
    assert "expo export" in skill


def test_the_shipping_lock_carries_the_payload():
    dockerfile = (REPO_ROOT / "ui" / "Dockerfile").read_text(encoding="utf-8")
    assert "COPY ota /app/ota" in dockerfile
    assert (REPO_ROOT / "ui" / "ota" / ".gitkeep").exists()
    gitignore = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "ui/ota/manifest.json" in gitignore  # build output, never git's
