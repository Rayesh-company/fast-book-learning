# نشست — the mobile client (Expo)

The product's Android client (ADR-0020): Expo + TypeScript, speaking the
**same backend's** wire protocol as the web sheet — one server, one API,
both clients. The base URL rides `EXPO_PUBLIC_API_URL` (default
`https://booksai.rayesh-team.ir`); against a dev machine's stack, point
it at the host (the Android emulator's loopback alias is
`10.0.2.2:8765`):

```bash
cd mobile
npm install
EXPO_PUBLIC_API_URL=http://10.0.2.2:8765 npx expo start
# then press a (Android) — or:
npx expo run:android        # a dev build on a connected device
```

An Account issues from the Admin console (the web sheet's «میز مدیریت»);
the login token lives in the device's secure store and rides
`Authorization: Bearer` on every call — the same signed token the web
cookie carries. The live line (`GET /events`) is the real-time surface:
an ask that settles on the web re-renders this app's Sessions list the
moment it lands.

Scope (v1, recorded in ADR-0020): login, the Sessions list, a sitting's
thread (the Quote selection, the Quoted answer's blocks, the research
conversation with its turn progress), and the composer. The Book
reader's raster pipeline, the full Notebook panel, and the Admin
console stay web-first. The strings are Farsi DRAFT
(`src/strings.ts`), the palette is the sheet's own tokens
(`src/theme.ts`).

## Release builds & distribution

Distribution is sideload; release APKs are signed with the private
upload key `cwb-upload` (keystore outside the repo at `~/.cwb-keys/`) —
the certificate fingerprint, the `CWB_UPLOAD_*` env vars and the
fail-closed build guard are documented in [`KEYS.md`](KEYS.md). A
release build refuses to run without those env vars, so nothing ships
under the public debug key again (F-018, the 2026-11-01 security
review).

The current wave is three single-ABI splits (versionCode 2,
versionName 1.0.0), built per-ABI with no universal:
`cwb-arm64-v8a-release.apk`, `cwb-armeabi-v7a-release.apk` and
`cwb-x86_64-release.apk`, copied out of
`android/app/build/outputs/apk/release/` (every `mobile/*.apk` is
gitignored).

One-time migration: devices still on the old debug-signed APK cannot
update in place — Android rejects the new signature — so those installs
uninstall + reinstall once (the stored token is wiped; the user signs
in again). After that wave every next APK updates in place, and content
changes ship as OTA updates on top of these APKs (Rule 001). OTA
publishes must run with `CWB_OTA_PRIVATE_KEY` set — these APKs carry
the OTA code-signing certificate in their manifest and reject unsigned
manifests; until the first signed publish lands they stay on their
bundled bundle (F-019).
