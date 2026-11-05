// The real-time leg of rule 001: the wave rides the sheet's own wire
// (publish_ota.py -> /ota, signed per F-019), expo's ON_LOAD fetches it
// at launch, and this listener closes the last gap — every
// background->active return re-checks, and a verified, downloaded wave
// reloads at the exact moment the user comes back to the app. Mid-use
// the session is never yanked: a check only fires on the foreground
// transition itself, so a TTS/lecture playing in hand is never cut.
import * as Updates from "expo-updates";
import { AppState, Platform, ToastAndroid } from "react-native";

const CHECK_INTERVAL_MS = 5 * 60_000;

// The user's own real-time proof: the wave this session runs, short
// form — Home paints it, and the same id is readable on /ota's
// manifest at fahva, so the two lines matching IS the verification.
export function currentWaveTag(): string {
  const id = Updates.manifest?.id;
  return typeof id === "string" ? id.slice(0, 8) : "embedded";
}

export function installForegroundUpdates(): () => void {
  // The dev client and the Metro dev server carry no OTA channel —
  // checking there would only churn the developer's session.
  if (!Updates.isEnabled) return () => {};
  // Which bundle runs, one line at boot: the operator reads the wave id
  // straight off logcat, and every reload names its own new one.
  console.log(`[cwb-updates] bundle ${Updates.manifest?.id ?? "embedded"}`);
  // The applied-update announcement: a wave that downloads and reloads
  // boots THIS branch as a non-embedded launch, so the user SEES the
  // real-time channel working — the update landed without a store and
  // without them doing anything.
  if (!Updates.isEmbeddedLaunch && Platform.OS === "android") {
    ToastAndroid.show("به‌روزرسانی فحوا نصب شد", ToastAndroid.SHORT);
  }
  let lastCheck = 0;
  const subscription = AppState.addEventListener("change", (state) => {
    if (state !== "active") return;
    const now = Date.now();
    if (now - lastCheck < CHECK_INTERVAL_MS) return;
    lastCheck = now;
    void (async () => {
      try {
        const check = await Updates.checkForUpdateAsync();
        console.log(
          `[cwb-updates] check available=${check.isAvailable} ` +
            `server=${check.manifest?.id ?? "none"} running=${Updates.manifest?.id ?? "embedded"}`
        );
        if (!check.isAvailable) return;
        // The race guard: right after a reload expo-updates' internal
        // "current" can lag the JS actually on screen, so the server's
        // newest manifest can equal the running bundle — reload-then-
        // check-again would loop (three boots per wave, live-measured).
        // The running manifest's own id is the truth about what the
        // user is already looking at.
        if (check.manifest?.id && check.manifest.id === Updates.manifest?.id) return;
        const fetched = await Updates.fetchUpdateAsync();
        console.log(
          `[cwb-updates] fetched=${fetched.isNew} ` +
            `fetched-id=${"manifest" in fetched ? fetched.manifest?.id ?? "none" : "none"}`
        );
        if (fetched.isNew) await Updates.reloadAsync();
      } catch {
        // The wire down, a refused signature, a throttled panel — any
        // failure keeps the running bundle; a check never breaks the
        // session it runs inside (expo-updates' own anti-brick rolls
        // a broken wave back to the embedded bundle regardless).
      }
    })();
  });
  return () => subscription.remove();
}
