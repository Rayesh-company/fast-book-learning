// The app's root is now the fahva web face itself: one fullscreen
// WebView over https://fahva.rayesh-team.ir/ — the login (the phone's
// SMS door), the book reader, the chat, every pixel of it IS the web,
// so the two clients can never drift again (the operator's 2026-11-05
// call: the native client's minimal UI and its missing reader left
// him with «the text doesn't load» and «the web looks like something
// else»). The web keeps its own auth inside the WebView's localStorage
// — one OTP login persists across opens — and the shell keeps only the
// OTA leg (rule 001): a shell upgrade still rides the signed wave.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PixelRatio,
  Platform,
  StatusBar,
  Text,
  TouchableOpacity,
  useColorScheme,
  View,
} from "react-native";
import { WebView } from "react-native-webview";

// The status bar's height in dp for the edge-to-edge window: on modern
// Android (API 35+) currentHeight can report 0, so the web's top bar
// would collide with the clock and battery. A real height converts
// px→dp; otherwise the standard 24dp band plus breathing room.
const TOP_BAR_DP =
  (StatusBar.currentHeight ?? 0) > 0
    ? StatusBar.currentHeight! / PixelRatio.get()
    : Platform.OS === "android"
      ? 38
      : 0;

const FAHVA_URL = "https://fahva.rayesh-team.ir/";

// The URL.parse ponyfill, injected before ANY page JS: pdf.js ≥ 4.5
// calls the static URL.parse (Chrome 126+), and Android WebViews on
// older Chrome builds (124 and below — the operator's phone among
// them) throw «URL.parse is not a function» the moment the reader's
// PDF engine boots — the book text never loads. The ponyfill is the
// spec's own semantics: new URL(url, base), null on failure.
const PONYFILL = `
  if (!URL.parse) {
    URL.parse = function (url, base) {
      try { return base ? new URL(url, base) : new URL(url); }
      catch (e) { return null; }
    };
  }
  true;
`;

export default function App() {
  const scheme = useColorScheme();
  const palette = useMemo(
    () => (scheme === "dark" ? { bg: "#202524" } : { bg: "#faf8f3" }),
    [scheme]
  );
  // The connection-failure door: a network cut (or a server restart —
  // the operator's ERR_CONNECTION_CLOSED screenshot, 2026-11-06) must
  // land on a Persian «try again» screen, never the raw WebView error
  // page. A retry bumps the key, forcing the WebView to reload.
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const retry = useCallback(() => {
    setFailed(false);
    setReloadKey((k) => k + 1);
  }, []);

  // NO in-app OTA listener here — ON_LOAD's single native check per
  // launch is the whole channel the shell needs (the web face updates
  // itself; a wave only ships a new shell), and the foreground check
  // proved to spin on the runtime-mismatch era (a /ota request every
  // second, the wave tag advancing on nothing). One launch, one check,
  // no listener.
  useEffect(() => {}, []);

  const onError = useCallback(() => {
    setFailed(true);
  }, []);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: palette.bg,
        paddingTop: TOP_BAR_DP,
      }}
    >
      <StatusBar barStyle={scheme === "dark" ? "light-content" : "dark-content"} />
      {failed ? (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            padding: 32,
            gap: 18,
          }}
        >
          <Text style={{ fontSize: 17, color: "#262c2b", textAlign: "center" }}>
            اتصال برقرار نشد
          </Text>
          <Text style={{ fontSize: 13, color: "#626965", textAlign: "center", lineHeight: 22 }}>
            اینترنت یا اتصال به سرور قطع بود. دوباره تلاش کنید؛ اگر تکرار شد، شبکه را عوض کنید (وای‌فای/داده).
          </Text>
          <TouchableOpacity
            onPress={retry}
            style={{
              backgroundColor: "#16786e",
              borderRadius: 12,
              paddingVertical: 12,
              paddingHorizontal: 40,
            }}
          >
            <Text style={{ color: "#fffefa", fontSize: 15, fontWeight: "700" }}>
              تلاش دوباره
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <WebView
          key={reloadKey}
          source={{ uri: FAHVA_URL }}
          style={{ flex: 1, backgroundColor: palette.bg }}
          domStorageEnabled
          javaScriptEnabled
          originWhitelist={["https://*"]}
          injectedJavaScriptBeforeContentLoaded={PONYFILL}
          onError={onError}
          onRenderProcessGone={retry}
        />
      )}
    </View>
  );
}
