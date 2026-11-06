/*
 * The mobile face's service worker (ADR-0026): the shell installs, the
 * product does not. One cache, the app shell only — the page's own
 * HTML, the manifest, the icons and the vendored fonts.
 *
 * The freshness contract is the 2026-09-11 lesson (serve.py's
 * end_headers comment): every load must revalidate — a deploy must
 * never leave an operator on a stale face. So navigations are
 * NETWORK-FIRST: the network answers whenever it can and only an
 * offline load falls back to the cached shell. And the worker owns
 * ONLY a whitelist of static families (/mobile/, /vendor/,
 * /book-reader/, /icons/): the metered, per-Account routes — every
 * auth, session, ask, research and live-event line — fall outside the
 * whitelist and pass through untouched; an old answer painted from a
 * cache would lie. The pdf.js engine also stays out of the install
 * (unlike the sheet's worker): several MB down the Iran-to-box path
 * at install time is a tax on everyone for an offline book nobody
 * opened — it rides the stale-while-revalidate cache on its first
 * real open instead.
 */

const SHELL_CACHE = "cwb-mobile-shell-v2";

const SHELL_ASSETS = [
  "/",
  "/mobile/",
  "/mobile/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/vendor/fonts/Vazirmatn-Regular.woff2",
  "/vendor/fonts/Vazirmatn-Bold.woff2",
];

/* The page answers at / on fahva and at /mobile/ on the backend's own
 * origin — one worker serves both faces, so the install caches both
 * doors (whichever misses, misses; allSettled keeps the shell up). */
function isShellAsset(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/mobile/") ||
      url.pathname.startsWith("/vendor/") ||
      url.pathname.startsWith("/book-reader/") ||
      url.pathname.startsWith("/icons/"))
  );
}

self.addEventListener("install", (event) => {
  // allSettled, not addAll: one missing optional asset must not stop
  // the install — the shell still stands, the asset lands next fetch.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        Promise.allSettled(
          SHELL_ASSETS.map((asset) => cache.add(new Request(asset, { cache: "reload" })))
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Navigations first — the page itself lives under the /mobile/
  // whitelist, and it must stay network-first, never a cached read.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => {
              cache.put("/", copy);
              cache.put(request, response.clone());
            });
          }
          return response;
        })
        .catch(async () =>
          // The offline answer's order matters: the request's own door
          // first, then the face's own page, and only then whatever the
          // install precached — on the backend's own origin "/" is the
          // SHEET, and a mobile navigation must never fall back to it
          // while its own page sits in the cache.
          (await caches.match(request, { ignoreSearch: true })) ||
          (await caches.match("/mobile/")) ||
          (await caches.match("/"))
        )
    );
    return;
  }

  if (isShellAsset(url)) {
    // Network-first, like the navigations — the shell era's freshness
    // contract: the app IS the web now, and a web deploy must never
    // leave a stale face one restart behind (the 2026-11-06 report:
    // the drawer's logout icon stayed invisible through SWR's
    // first-load-stale window). The cache answers ONLY when the wire
    // fails — the offline fallback, not the freshness source.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) || Response.error())
    );
    return;
  }

  /* Everything else — the login, the sessions, the asks, the research,
   * the SSE line, the OTA manifest, the books' JSON — passes through
   * untouched. The worker only ever owns the shell. */
});
