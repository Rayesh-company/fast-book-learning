# ADR 0026 — The mobile face becomes an installable PWA

Date: 2026-11-03
Status: accepted
Context for: the operator's «خوب یک دکمه پاپ بزار که pwa نصب بشه» — asked the
day the door split was explained to them (the sheet is a PWA, the fahva face
is not), and chose «فاهوا (موبایل)» when asked where the install button
belongs.

## Context

The mobile face has three doors and only one of them installs. Android
installs the native APK (per-ABI, OTA-updated, rule 001). The sheet installs
as a PWA (ADR-0019: manifest + shell worker). But the fahva face — the page
at the bare root since ADR-0025 — carries no manifest and no worker: a
desktop browser or an iPhone opening fahva has no way to put «کتاب و همراه»
on its home screen. The iPhone is the real gap: Eitaa's bernamek reaches
Android users, the APK reaches Android users, and iOS users had nothing.

The PM asked for a popup button that installs the PWA, and placed it on the
fahva face. Rule 001 stands untouched: this adds a browser-installable door,
it builds no APK.

## Decision

- **The mobile face is a PWA.** `ui/mobile/manifest.webmanifest` (id
  `/mobile/`, name «کتاب و همراه», RTL fa, standalone, theme #faf8f3) whose
  `start_url` and `scope` are `/` — the installed app opens at the bare
  root, the ADR-0025 shape, never at a path. The icons are the sheet's own
  set at `/icons/`, which rides fahva's general proxy; no binaries are
  duplicated.
- **A worker owns the shell only.** `ui/mobile/sw.js` (cache
  `cwb-mobile-shell-v1`) mirrors ADR-0019's contract with one deliberate
  difference: the whitelist (`/mobile/`, `/vendor/`, `/book-reader/`,
  `/icons/`) and the navigate check are ordered so the page itself is
  never served stale — the page lives *under* the whitelist here. Navigations
  are network-first; the metered product routes are never named and pass
  through untouched. The pdf.js engine stays OUT of the install (unlike the
  sheet's): several MB down the Iran-to-box path at install time is a tax on
  everyone for an offline book nobody opened — it rides the
  stale-while-revalidate cache on its first real open.
- **The worker owns the whole origin.** The page answers at `/` on fahva
  while the script sits under `/mobile/`, so serve.py answers
  `Service-Worker-Allowed: /` for `/mobile/sw.js` and the registration
  (`pwa.mjs`) asks for scope `/`. One worker serves both faces (fahva root
  and the backend's own `/mobile/`).
- **The install door is the drawer.** A «نصب برنامه» row (`download` icon)
  appears in the drawer's nav only where the platform can actually install:
  Chromium's `beforeinstallprompt` (suppressed from the browser's own
  banner — the drawer row is the door), or iOS read off the agent (no event;
  the popup teaches the share sheet's «افزودن به صفحهٔ اصلی»). The popup is
  the app's own sheet idiom; a standalone app never shows the row, and
  `appinstalled` hides it wherever the install came from.

## Consequences

iOS and desktop users gain a home-screen install of the mobile face for the
first time; Android keeps the APK as the richer door (rule 001 untouched —
no new binary). The worker's scope is the whole fahva origin, but the
whitelist keeps its hands off every per-Account answer. The install costs
the fonts, icons and two page doors — tens of KB, not megabytes. Deploys
reach installed PWAs by the same revalidation law as the sheet: the next
load answers from the network, the cache is only the offline answer.
