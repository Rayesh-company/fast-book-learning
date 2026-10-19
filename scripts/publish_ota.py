#!/usr/bin/env python3
"""Publish one over-the-air update for the mobile app (rule 001,
docs/rules/001-no-new-apks.md — the ONLY way a change ships to phones).

Input: an `expo export` directory (``npx expo export --platform android
--output-dir <dir>`` run in ``mobile/`` with the target server's
``EXPO_PUBLIC_API_URL`` in the env — the URL bakes into the bundle at
export time, exactly as it did at build time).

Output: ``ui/ota/`` (or ``$SESSION_OTA_DIR``) holding:
  - ``manifest.json``  — the expo-updates protocol manifest the sheet's
    ``GET /ota`` serves verbatim: id, createdAt, runtimeVersion, one
    launchAsset (the JS bundle), and the asset list (fonts, images);
  - ``current/``       — the bundle's files, served immutable under
    ``GET /ota/current/…``.

Every publish REPLACES the previous payload wholesale — one live update,
no history on the server (git holds the source history; the runtime
keeps the update it already downloaded).

Usage:
    py scripts/publish_ota.py <export-dir> [--base https://booksai.rayesh-team.ir] \
        [--runtime 1.0.0] [--out ui/ota]
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# The launch bundle's known shapes across expo-export versions: the
# classic flat name, and the modern hashed _expo/static/js layout.
BUNDLE_HINTS = ("index.android.bundle", "index.android.js")
BUNDLE_DIR_HINT = "_expo/static/js/android"

CONTENT_TYPES = {
    ".js": "application/javascript",
    ".bundle": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ttf": "application/font-ttf",
    ".otf": "application/font-otf",
    ".woff": "application/font-woff",
    ".woff2": "application/font-woff2",
    ".hbc": "application/octet-stream",
}


def find_launch_asset(export: Path) -> Path | None:
    for hint in BUNDLE_HINTS:
        candidate = export / hint
        if candidate.is_file():
            return candidate
    bundle_dir = export / BUNDLE_DIR_HINT
    if bundle_dir.is_dir():
        bundles = sorted(bundle_dir.glob("*.js")) + sorted(bundle_dir.glob("*.hbc"))
        if bundles:
            return bundles[0]
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("export_dir", help="the expo export output directory")
    parser.add_argument("--base", default="https://booksai.rayesh-team.ir",
                        help="the public base the app resolves asset URLs against")
    parser.add_argument("--runtime", default=None,
                        help="runtimeVersion (default: app.json's expo.version)")
    parser.add_argument("--out", default=None,
                        help="output dir (default: ui/ota, or $SESSION_OTA_DIR)")
    args = parser.parse_args()

    export = Path(args.export_dir).resolve()
    if not export.is_dir():
        print(f"no export dir at {export}", file=sys.stderr)
        return 1

    app_json = json.loads((REPO_ROOT / "mobile" / "app.json").read_text(encoding="utf-8"))
    expo = app_json["expo"]
    runtime = args.runtime or expo["version"]
    out_dir = Path(args.out) if args.out else Path(
        __import__("os").environ.get("SESSION_OTA_DIR", str(REPO_ROOT / "ui" / "ota"))
    )
    out_dir.mkdir(parents=True, exist_ok=True)

    launch = find_launch_asset(export)
    if launch is None:
        print("no launch bundle found in the export (looked for "
              f"{BUNDLE_HINTS} and {BUNDLE_DIR_HINT}/*.js)", file=sys.stderr)
        return 1

    current = out_dir / "current"
    if current.exists():
        shutil.rmtree(current)
    shutil.copytree(export, current)
    # The export's metadata is the exporter's own bookkeeping, not a
    # servable asset.
    (current / "metadata.json").unlink(missing_ok=True)

    def asset_entry(path: Path, is_launch: bool) -> dict:
        rel = path.relative_to(export).as_posix()
        suffix = "".join(path.suffixes[-1:])
        return {
            "key": rel if not is_launch else "index.android.bundle",
            "url": f"{args.base.rstrip('/')}/ota/current/{rel}",
            "contentType": CONTENT_TYPES.get(suffix, "application/octet-stream"),
            **({"type": "bundle"} if is_launch else {}),
        }

    assets = []
    for path in sorted(current.rglob("*")):
        if not path.is_file():
            continue
        if path == current / launch.relative_to(export):
            continue
        assets.append(asset_entry(path, is_launch=False))

    manifest = {
        "id": str(uuid.uuid4()),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "runtimeVersion": runtime,
        "launchAsset": asset_entry(launch, is_launch=True),
        "assets": assets,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"published OTA update {manifest['id']} (runtime {runtime}): "
          f"{len(assets)} assets + launch bundle -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
