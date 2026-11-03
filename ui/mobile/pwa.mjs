/* The mobile face's PWA wiring (ADR-0026): the worker's registration
 * and the install capability's honest reading. No guessed platforms —
 * only what the browser actually reports: the standalone display mode
 * (the installed app must never be asked to install itself), iOS's
 * no-beforeinstallprompt reality (the share sheet is the door there),
 * and Chromium's deferred prompt for everyone else. */

export function registerServiceWorker(win) {
  if (!("serviceWorker" in win.navigator)) return;
  win.addEventListener("load", () => {
    // The page answers at / on fahva (ADR-0025) while the script sits
    // under /mobile/ — the scope rides the serve.py allowance header,
    // so the worker owns the whole origin whichever door it loads from.
    win.navigator.serviceWorker
      .register("/mobile/sw.js", { scope: "/" })
      .catch(() => {});
  });
}

export function isStandalone(win) {
  return (
    win.matchMedia?.("(display-mode: standalone)").matches === true ||
    win.navigator.standalone === true
  );
}

export function isIos(win) {
  return (
    /iphone|ipad|ipod/i.test(win.navigator.userAgent) ||
    (win.navigator.platform === "MacIntel" && win.navigator.maxTouchPoints > 1)
  );
}
