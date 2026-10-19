---
name: ship-mobile-update
description: Use when shipping ANY change to the mobile/ Expo app — code, strings, UI, or assets — or when asked to "release/update/build" the mobile app. Publishes the change OVER-THE-AIR so every installed app updates itself on its next launch, with zero user action. NEVER builds a new APK (docs/rules/001-no-new-apks.md — a hard PM law). Also use when tempted to run gradlew/expo run:android — that is the forbidden path.
---

# Ship a mobile update — OTA, never a new APK

**The law (docs/rules/001-no-new-apks.md):** the existing binary is the LAST APK. Every
change ships over-the-air; the app checks on launch (`checkAutomatically: ON_LOAD`),
downloads silently, and runs the new bundle on its next restart. The user does nothing.

## When NOT to use

- Web sheet changes (`ui/`) — normal server deploy + browser refresh (ADR-0019); no OTA.
- Backend changes — deploy `serve.py`; both clients pick it up on their own rhythms.
- A NATIVE change (new native module, new permission, native app.json fields) — OTA
  cannot carry it. STOP, state the exception, and ask the PM for an explicit written go
  for the one-off binary build. Never decide this alone.

## Steps

1. **Type-check** in `mobile/`: `npx tsc --noEmit` — a red typecheck never ships.

2. **Export the bundle** (in `mobile/`, with the TARGET server baked in — the URL is
   frozen into the export exactly as it was into the APK):
   ```bash
   EXPO_PUBLIC_API_URL=https://booksai.rayesh-team.ir \
     npx expo export --platform android --output-dir ../.scratch/ota-export
   ```

3. **Publish**: `py scripts/publish_ota.py ../.scratch/ota-export` — writes
   `ui/ota/manifest.json` + `ui/ota/current/` (one live update; replaces the previous).

4. **Deploy**: the payload rides the tree to the server (tarball swap carries `ui/ota`,
   like `books/` and `render-cache/`); a container deploy rebuilds the session image
   (the Dockerfile COPYs `ota`). The host-process sheet picks it up on restart.

5. **Verify** (no phone needed):
   ```bash
   curl -s "https://booksai.rayesh-team.ir/ota?runtimeVersion=1.0.0"   # the manifest JSON
   curl -sI "https://booksai.rayesh-team.ir/ota/current/<bundle-file>" # 200, immutable
   ```
   `204` means no payload — the publish or the deploy didn't land.

6. **Runtime version discipline**: updates apply while `expo.version` (1.0.0) matches
   the binary. Bump `expo.version` ONLY with an approved native build — never casually.

## Forbidden — no exceptions without written PM approval

- `gradlew assembleRelease` / `assembleDebug`, `npx expo run:android`, `eas build`
- Creating, copying, or shipping any `*.apk` / `*.aab`
- Committing `ui/ota/current/` or `ui/ota/manifest.json` (build output; the publish
  script + deploy own them)
