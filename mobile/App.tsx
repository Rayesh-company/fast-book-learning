// The app's root: boot the stored credential, then the phone's one
// stack — the Sessions list, a sitting, and the live line underneath
// it all (ADR-0020). Any settle anywhere re-renders the list.
import { useCallback, useEffect, useMemo, useState } from "react";
import { StatusBar, useColorScheme, View } from "react-native";
import { dark, light } from "./src/theme";
import { api, loadToken } from "./src/api";
import { subscribeEvents } from "./src/events";
import { LoginScreen } from "./src/screens/Login";
import { HomeScreen } from "./src/screens/Home";
import { SittingScreen } from "./src/screens/Sitting";

export default function App() {
  const scheme = useColorScheme();
  const palette = scheme === "dark" ? dark : light;
  const [booted, setBooted] = useState(false);
  const [me, setMe] = useState<{ email: string; role: string } | null>(null);
  const [openSessionId, setOpenSessionId] = useState<number | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    loadToken().then((token) => {
      // A stored credential opens the list; /sessions' own 401 (the
      // Home read) is the gate that sends it back here.
      if (token) setMe({ email: "", role: "operator" });
      setBooted(true);
    });
  }, []);

  // The live line: opens once the Account exists, re-renders the list
  // on every settle, and dies with the logout.
  const meEmail = me?.email;
  useEffect(() => {
    if (!meEmail) return;
    const unsubscribe = subscribeEvents(loadToken, () =>
      setRefreshToken((n) => n + 1)
    );
    return unsubscribe;
  }, [meEmail]);

  const onLoggedOut = useCallback(() => {
    api.logout().catch(() => {});
    setMe(null);
    setOpenSessionId(null);
  }, []);

  const body = useMemo(() => {
    if (!booted) return null;
    if (!me) {
      return (
        <LoginScreen
          palette={palette}
          onLoggedIn={(next) => {
            setMe(next);
            setRefreshToken((n) => n + 1);
          }}
        />
      );
    }
    if (openSessionId !== null) {
      return (
        <SittingScreen
          palette={palette}
          sessionId={openSessionId}
          onBack={() => {
            setOpenSessionId(null);
            setRefreshToken((n) => n + 1);
          }}
        />
      );
    }
    return (
      <HomeScreen
        palette={palette}
        onOpen={(session) => setOpenSessionId(session.id)}
        onLoggedOut={onLoggedOut}
        refreshToken={refreshToken}
      />
    );
  }, [booted, me, openSessionId, palette, refreshToken, onLoggedOut]);

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <StatusBar barStyle={scheme === "dark" ? "light-content" : "dark-content"} />
      {body}
    </View>
  );
}
