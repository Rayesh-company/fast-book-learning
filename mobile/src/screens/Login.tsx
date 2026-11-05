// The one door (ADR-0013's shape, on the phone) — the web face's own
// shape since 2026-11-05: the phone and its SMS code are the primary
// door (a phone no Account carries signs itself in), and the email
// login rides beside it as the secondary toggle. Either way the
// Account's token lands in the secure store.
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

const normalizePhone = (raw: string) =>
  raw
    .replace(/[۰-۹]/g, (c) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(c)))
    .replace(/[٠-٩]/g, (c) => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)))
    .replace(/[\s()-]/g, "")
    .replace(/^\+98|^0098/, "0");

export function LoginScreen({
  palette,
  onLoggedIn,
}: {
  palette: Palette;
  onLoggedIn: (me: { email: string; role: string }) => void;
}) {
  const [mode, setMode] = useState<"phone" | "otp" | "email">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (act: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await act();
    } catch (exc) {
      setError(exc instanceof ApiError ? exc.message : S.loginFailed);
    } finally {
      setBusy(false);
    }
  };

  const sendCode = () =>
    run(async () => {
      const normalized = normalizePhone(phone);
      if (!/^09\d{9}$/.test(normalized)) throw new Error(S.loginBadPhone);
      await api.requestOtp(normalized);
      setCode("");
      setMode("otp");
    });

  const verify = () =>
    run(async () => {
      const normalized = normalizePhone(phone);
      if (!/^\d{6}$/.test(code)) throw new Error(S.loginBadCode);
      const me = await api.verifyOtp(normalized, code);
      onLoggedIn(me);
    });

  const submitEmail = () =>
    run(async () => {
      const me = await api.login(email.trim(), password);
      onLoggedIn(me);
    });

  const submit = mode === "email" ? submitEmail : mode === "otp" ? verify : sendCode;

  return (
    <KeyboardAvoidingView
      style={[styles.wrap, { backgroundColor: palette.bg }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Text style={[styles.title, { color: palette.ink }]}>{S.appName}</Text>
      <Text style={[styles.subtitle, { color: palette.mute }]}>{S.pickBook}</Text>
      <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.rule }]}>
        {mode === "email" ? (
          <>
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
          </>
        ) : mode === "otp" ? (
          <>
            <Text style={[styles.label, { color: palette.mute }]}>
              {S.loginOtpSent(normalizePhone(phone))}
            </Text>
            <TextInput
              style={[styles.input, styles.codeInput, { borderColor: palette.rule, color: palette.ink, backgroundColor: palette.raised }]}
              value={code}
              onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              maxLength={6}
              onSubmitEditing={submit}
            />
          </>
        ) : (
          <>
            <Text style={[styles.label, { color: palette.mute }]}>{S.loginPhone}</Text>
            <TextInput
              style={[styles.input, styles.phoneInput, { borderColor: palette.rule, color: palette.ink, backgroundColor: palette.raised }]}
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              placeholder="0912 345 6789"
              placeholderTextColor={palette.mute}
              onSubmitEditing={submit}
            />
          </>
        )}
        {error ? <Text style={[styles.error, { color: palette.bad }]}>{error}</Text> : null}
        <TouchableOpacity
          style={[styles.button, { backgroundColor: palette.clay }]}
          onPress={submit}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color={palette.surface} />
          ) : (
            <Text style={[styles.buttonText, { color: palette.surface }]}>
              {mode === "email" ? S.loginSubmit : mode === "otp" ? S.loginOtpSubmit : S.loginSendCode}
            </Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.toggle}
          onPress={() =>
            run(async () => {
              setMode(mode === "email" ? "phone" : "email");
            })
          }
          disabled={busy}
        >
          <Text style={[styles.toggleText, { color: palette.clay }]}>
            {mode === "email" ? S.loginPhoneToggle : S.loginEmailToggle}
          </Text>
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
  phoneInput: {
    textAlign: "left",
  },
  codeInput: {
    textAlign: "center",
    fontSize: 20,
    letterSpacing: 8,
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
  toggle: {
    marginTop: 14,
    alignItems: "center",
    paddingVertical: 6,
  },
  toggleText: {
    fontSize: 13,
  },
});
