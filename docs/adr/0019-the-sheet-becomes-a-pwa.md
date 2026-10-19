# ADR 0019 — The sheet becomes a PWA: the shell installs, the words are never cached

Date: 2026-10-02
Status: accepted
Context for: the operator's «اینو تبدیل به یک وب اپلیکیشن بکن با pwa»

## Context

The sheet is a mobile-first Farsi product — the reader, the notebook, the research map all ride a phone's browser — but it lives behind a URL bar: no home-screen presence, no offline shell, and every cold start re-downloads the sheet, the fonts, and the pdf.js engine. A PWA (installable manifest + service worker) closes that gap without touching the answer pipeline, which stays server-side and per-Account.

Two recorded constraints shape the decision:

1. **The freshness contract (serve.py's `end_headers`, the 2026-09-11 lesson):** every sheet load must revalidate — a deploy must never leave an operator rendering a stale cached page. A cache-first app shell would break exactly that contract.
2. **The answers are not cacheable:** every ask, quote, phase, research turn, and meter read is per-Account, per-Session, and billed. A stale answer painted from a cache would lie — the sheet's honesty rules (the verbatim guard, the honest-empty paths) apply to the network layer too.

A Windows-registry fact pins one implementation detail: `SimpleHTTPRequestHandler` guesses content types through `mimetypes`, which on Windows consults the registry. A registry answering `text/plain` for `.js` kills every service-worker registration (workers must ride a JavaScript MIME type), and a wrong `.webmanifest` type kills the install.

## Decision

- **The shell installs.** `ui/manifest.webmanifest` (RTL, `lang: fa`, `display: standalone`, `start_url`/`scope` `/`, the sheet's own paper `#d8cbae` as `theme_color`/`background_color`) and the iOS metas (`apple-mobile-web-app-*`, `apple-touch-icon`) stand beside it, because Safari still reads the metas. The names («نشست · پرسش از کتاب‌ها» / «نشست») are DRAFT pending PM approval, recorded in CONTEXT.md's roster.
- **The icon set is generated from source.** `tools/make_pwa_icons.py` — a pure-stdlib rasterizer (no Pillow, no design tool) — draws the light theme's world: the paper behind an ink open book, two curved pages sinking into the gutter over a base line. One geometry, two croppings: `purpose: any` icons own their tile; maskable ones shrink the mark into the safe zone so an OS mask of any shape keeps the book whole; `apple-touch-icon.png` (180) rides for iOS. The PNGs are committed beside the generator that produces them.
- **The worker owns the shell only.** `ui/sw.js` keeps ONE cache (`cwb-shell-v1`): the sheet HTML, the manifest, the icons, the vendored Vazirmatn weights, the pdf.js engine. Nothing else is ever stored.
  - **Navigations are network-first** — the freshness contract stands: a live server wins, the cached shell is the OFFLINE answer, never the deploy's. (A first-ever load with no network has no shell to fall back to; the browser's own error page shows. Honest, recorded.)
  - **`/vendor/` and `/icons/` are stale-while-revalidate** — stable bytes answer at once and refresh behind the read.
  - **Everything else passes through untouched.** No route of the product — `/api/*`, `/research/*`, `/auth/*`, `/books/*`, the quote and phase routes, the notebook, the meter — is intercepted, cached, or even observed. A POST is never touched by construction (`method !== "GET"` returns first).
- **The types are pinned, not guessed.** `SessionHandler.extensions_map` pins `.js`/`.mjs` (`text/javascript`), `.webmanifest` (`application/manifest+json`), `.png`, `.svg`, `.woff2` — no registry sits between the sheet and a working install.
- **The install chip appears only where installing is real.** Chromium answers `beforeinstallprompt`; the topbar chip («نصب برنامه», `PWA_INSTALL_LABEL`, DRAFT) shows itself then and only then — no event, no chip. iOS installs through Safari's share sheet and needs no chip. `appinstalled` hides it again.
- **The container ships the new files.** The Dockerfile's COPY (the shipping lock) carries `manifest.webmanifest`, `sw.js`, and `icons/`.

## Consequences

- Installed, the sheet opens standalone (no browser chrome) from a home-screen icon; reloads of the shell and the vendored engine work with the server down, so a dropped connection during reading costs the reader nothing already rendered — though page rasters (`/books/*`, deliberately untouched) need the server.
- Updates propagate on the next online load: the worker re-fetches the shell network-first, and a new worker (`skipWaiting` + `clients.claim`) takes over with a cache-version bump — no stale-sheet window either way.
- The worker adds one moving part the deploy must remember: bump `SHELL_CACHE`'s version suffix when the precache list changes, or an old cache lingers (harmless — `activate` prunes unknown versions, and the shell itself always revalidates).
- Rebranding the icon is `python tools/make_pwa_icons.py` after editing one constant — the mark's geometry is code, reviewed like code.
- The suite pins the whole wiring (`tests/test_pwa_docs.py`): the manifest's shape, the worker's never-cache contract, the pinned types, the COPY lock, the chip's string, and the PNG headers' real dimensions against the manifest's claimed sizes.
