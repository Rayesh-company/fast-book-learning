// The one door (ADR-0013's shape, on the phone): email + password in,
// the Account's token into the secure store.
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import type { Palette } from "../types";
import { S } from "../strings";
import { api, ApiError } from "../api";

export function LoginScreen({
  palette,
  onLoggedIn,
}: {
  palette: Palette;
  onLoggedIn: (me: { email: string; role: string }) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const me = await api.login(email.trim(), password);
      onLoggedIn(me);
    } catch (exc) {
      setError(
        exc instanceof ApiError ? exc.message : S.loginFailed
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.wrap, { backgroundColor: palette.bg }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Text style={[styles.title, { color: palette.ink }]}>{S.appName}</Text>
      <Text style={[styles.subtitle, { color: palette.mute }]}>{S.pickBook}</Text>
      <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.rule }]}>
        <Text style={[styles.label, { color: palette.mute }]}>{S.loginEmail}</Text>
        <TextInput
          style={[styles.input, { borderColor: palette.rule, color: palette.ink, backgroundColor: palette.raised }]}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          textContentType="emailAddress"
        />
        <Text style={[styles.label, { color: palette.mute }]}>{S.loginPassword}</Text>
        <TextInput
          style={[styles.input, { borderColor: palette.rule, color: palette.ink, backgroundColor: palette.raised }]}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType="password"
          onSubmitEditing={submit}
        />
        {error ? <Text style={[styles.error, { color: palette.bad }]}>{error}</Text> : null}
        <TouchableOpacity
          style={[styles.button, { backgroundColor: palette.clay }]}
          onPress={submit}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color={palette.surface} />
          ) : (
            <Text style={[styles.buttonText, { color: palette.surface }]}>{S.loginSubmit}</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: "700",
    textAlign: "center",
  },
  subtitle: {
    fontSize: 13,
    textAlign: "center",
    marginTop: 6,
    marginBottom: 24,
  },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
  },
  label: {
    fontSize: 13,
    marginTop: 10,
    marginBottom: 4,
    textAlign: "right",
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  error: {
    marginTop: 10,
    fontSize: 13,
    textAlign: "right",
  },
  button: {
    marginTop: 16,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 12,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: "700",
  },
});
