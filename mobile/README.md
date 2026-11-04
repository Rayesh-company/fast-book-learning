# فحوا — the mobile client (Expo)

The product's Android client (ADR-0020): Expo + TypeScript, speaking the
**same backend's** wire protocol as the web sheet — one server, one API,
both clients. The base URL rides `EXPO_PUBLIC_API_URL` (default
`https://fahva.rayesh-team.ir` — the app's home, its bare root; against a
dev machine's stack, point it at the host (the Android emulator's loopback
alias is `10.0.2.2:8765`):

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
reader's raster pipeline, the full Notebook panel, and the Admin console
stay web-first. The strings are Farsi DRAFT (`src/strings.ts`); the
palette is **the web face's own tokens, verbatim** (`src/theme.ts`,
2026-11-04 — the paper `#faf8f3` world and the teal `#16786e` accent,
dark included) so the two clients speak one visual language, color for
color. The native `app.json` background/splash still carry the retired
sand tone — that layer only moves with an APK.

## Shipping — what moves without an APK, and what never does

Rule 001 (`docs/rules/001-no-new-apks.md`) is the law: **every content
change ships over-the-air** — a feature, a screen, a button, a color.
`npx expo export` + `py scripts/publish_ota.py <export-dir>` writes the
signed wave into `ui/ota/` (deploy = the usual static deploy, no
restart). The phone re-checks on every background→active return and
applies a verified wave the moment the user comes back
(`src/updates.ts`, 2026-11-04) — no store, no manual update, no
next-launch wait. `logcat` names the truth per device:
`[cwb-updates] bundle <manifest-id>` plus the check/fetch decision
lines; a `restartCount=` that CLIMBS is the reload-loop smell (it was
the 2026-11-04 createdAt-format bug, fixed in the publish script — the
manifest's `createdAt` must stay `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'`, the one
shape expo-updates' parser reads; anything else poisons the commitTime
and the running wave looks forever-newer). The manifest answers must
also carry `expo-protocol-version: 1` and the `expo-signature` header —
both live on prod since 2026-11-04; without them the channel refuses
silently (the protocol refusal wears a misleading code-signing error).

What OTA can never carry: the app's NAME on the launcher, the icon, the
permissions, any native module or `app.json` native field — those are
APK territory (the PM's written go per rule 001; the «نشست» → brand
rename is parked there).

## Release APKs & distribution

Distribution is sideload; release APKs are signed with the private
upload key `cwb-upload` (keystore outside the repo at `~/.cwb-keys/`) —
the certificate fingerprint, the `CWB_UPLOAD_*` env vars and the
fail-closed build guard are documented in [`KEYS.md`](KEYS.md). A
release build refuses to run without those env vars, so nothing ships
under the public debug key again (F-018, the 2026-11-01 security
review).

The current install base is three single-ABI splits (versionCode 2,
versionName 1.0.0), built per-ABI with no universal; the public door is
the **GitHub Release v1.0.0** (`cwb-release-v2-arm64.apk`,
`cwb-release-v2-armeabi-v7a.apk`, `cwb-x86_64-release.apk` — verified
from the outside, 2026-11-04). Every `mobile/*.apk` is gitignored; the
APKs' baked base URL is fahva and their OTA door is `fahva/ota`.

One-time migration: devices still on the old debug-signed APK cannot
update in place — Android rejects the new signature — so those installs
uninstall + reinstall once (the stored token is wiped; the user signs
in again). After that, every APK is permanent infrastructure: the
content rides OTA above it, and the OTA code-signing chain
(`CWB_OTA_PRIVATE_KEY` at every publish, the embedded certificate, the
signature header — F-019) was proven end-to-end on a device on
2026-11-04; before that day the channel answered but no install ever
accepted a wave (the two holes named above).
