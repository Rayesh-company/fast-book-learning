/*
 * The sheet's service worker (ADR-0019): the shell installs, the words
 * do not. One cache, the app shell only — the sheet's own HTML, the
 * manifest, the icons, the vendored fonts and the pdf.js engine.
 *
 * The freshness contract is the 2026-09-11 lesson (serve.py's
 * end_headers comment): every load must revalidate — a deploy must
 * never leave an operator on a stale sheet. So navigations are
 * NETWORK-FIRST: the network answers whenever it can and only an
 * offline load falls back to the cached shell. The API families —
 * every ask, quote, research, auth, book and note route — are never
 * intercepted at all: their answers are per-Account, per-Session and
 * metered; an old answer painted from a cache would lie.
 */

const SHELL_CACHE = "cwb-shell-v1";

const SHELL_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/vendor/fonts/Vazirmatn-Regular.woff2",
  "/vendor/fonts/Vazirmatn-Bold.woff2",
  "/vendor/fonts/Vazirmatn-Light.woff2",
  "/vendor/pdf.min.mjs",
  "/vendor/pdf.worker.min.mjs",
];

/* Static, same-origin, content-addressed-by-stability: vendored assets
 * and icons go stale-while-revalidate — the cache answers at once and
 * the network refreshes it behind the read. */
function isShellAsset(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/vendor/") ||
      url.pathname.startsWith("/icons/") ||
      url.pathname === "/manifest.webmanifest")
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

  if (isShellAsset(url)) {
    // Stale-while-revalidate: the vendored engine and the icons are
    // stable bytes; the cache answers, the network refreshes.
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const refresh = fetch(request)
          .then((response) => {
            if (response && response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || refresh;
      })
    );
    return;
  }

  if (request.mode === "navigate") {
    // Network-first (the revalidation contract): a live server wins,
    // the cached shell is the OFFLINE answer, never the deploy's.
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
        .catch(() =>
          caches
            .match(request, { ignoreSearch: true })
            .then((hit) => hit || caches.match("/"))
        )
    );
    return;
  }

  /* Everything else — /api/*, /research/*, /auth/*, /books/*, the
   * quote and phase routes, the notebook, the meter — passes through
   * untouched. The worker only ever owns the shell. */
});
