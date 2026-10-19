// The sitting: one threaded conversation, the sheet's three phases
// rendered the store's way — the operator's ask, the assistant article
// (the server settles it itself when the body carries the sitting's id
// and the ask's key), and the research conversation beneath, its turns
// polled the recorded way.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import type { AskReply, Block, Palette, Selection, SittingPayload, Source, TurnStatus } from "../types";
import { S } from "../strings";
import { api, ApiError } from "../api";
import { Blocks, PoolList, References, SelectionList } from "../components";

type PhaseState = "idle" | "running" | "done" | "skipped" | "failed";

type Turn = {
  role: "user" | "assistant";
  text: string;
  blocks?: Block[];
  citations?: Source[];
  truncated?: boolean;
};

export function SittingScreen({
  palette,
  sessionId,
  onBack,
}: {
  palette: Palette;
  sessionId: number;
  onBack: () => void;
}) {
  const [sitting, setSitting] = useState<SittingPayload | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [query, setQuery] = useState("");
  const [pool, setPool] = useState<Source[]>([]);
  const [selections, setSelections] = useState<Selection[]>([]);
  const [phase, setPhase] = useState<PhaseState>("idle");
  const [phaseNote, setPhaseNote] = useState<string | null>(null);
  const [researchSession, setResearchSession] = useState<string | null>(null);
  const [researchText, setResearchText] = useState("");
  const [researchTurn, setResearchTurn] = useState<TurnStatus | null>(null);
  const [researchBusy, setResearchBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const payload = await api.sitting(sessionId);
      if (!mounted.current) return;
      setSitting(payload);
      setResearchSession(payload.session.research_session_id ?? null);
      const rows: Turn[] = (payload.messages ?? []).map((message) => ({
        role: message.role,
        text: String(message.payload?.text ?? message.payload?.question ?? ""),
        blocks: message.payload?.blocks,
        citations: message.payload?.citations,
        truncated: message.payload?.truncated,
      }));
      setTurns(rows);
    } catch (exc: any) {
      if (mounted.current) setError(exc?.message ?? S.offline);
    }
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  const ask = async () => {
    const question = query.trim();
    if (!question || phase === "running") return;
    setQuery("");
    setError(null);
    setPhase("running");
    setPhaseNote(null);
    setSelections([]);
    const askKey = `ask-${Date.now()}`;
    setTurns((rows) => [...rows, { role: "user", text: question }]);
    try {
      const reply: AskReply = await api.ask(question, sitting?.session.book ? [sitting.session.book] : []);
      if (!mounted.current) return;
      setPool(reply.sources ?? []);
      api.appendMessage(sessionId, "user", { text: question }).catch(() => {});
      // Phase 1: the Quote selection over the pool — the picker is
      // copy-matching, one call; an empty reply lands the honest note.
      const picked = await api.quoteSelection(question, reply.sources, sessionId, askKey);
      if (!mounted.current) return;
      if (picked.selections?.length) {
        setSelections(picked.selections);
      } else {
        setPhaseNote(S.selectionFailed);
      }
      // Phase 2: the Quoted answer over the same pool — the server
      // settles the assistant turn itself (session_id + ask_key).
      setPhaseNote(S.quotedRunning);
      const doc = await api.quotedAnswer(question, reply.sources, {
        sessionId,
        askKey,
        chatId: reply.chat_id,
      });
      if (!mounted.current) return;
      setPhase(doc.blocks?.length ? "done" : "failed");
      if (!doc.blocks?.length) setPhaseNote(S.quotedFailed);
      else if (doc.truncated) setPhaseNote(S.truncatedNote);
      // The store holds the settled article; the reload's shape is
      // this screen's truth.
      await load();
    } catch (exc: any) {
      if (!mounted.current) return;
      setPhase("failed");
      setPhaseNote(exc instanceof ApiError ? exc.message : S.quotedFailed);
    }
  };

  const sendResearch = async (text: string) => {
    const message = text.trim();
    if (!message || researchBusy) return;
    setResearchText("");
    setResearchBusy(true);
    setError(null);
    setTurns((rows) => [...rows, { role: "user", text: message }]);
    try {
      const started = await api.researchStart(message, {
        book: sitting?.session.book,
        chatSessionId: sessionId,
      });
      if (!mounted.current) return;
      setResearchSession(started.session_id);
      // The turn runs server-side; the poll is its recorded surface.
      for (;;) {
        if (!mounted.current) return;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const status = await api.researchTurn(started.turn_id);
        if (!mounted.current) return;
        setResearchTurn(status);
        if (status.state === "done" || status.state === "failed" || status.state === "aborted") {
          break;
        }
      }
    } catch (exc: any) {
      if (mounted.current) setError(exc?.message ?? S.researchFailed);
    } finally {
      if (mounted.current) setResearchBusy(false);
    }
  };

  const researchReplyBlocks: Block[] =
    researchTurn?.state === "done"
      ? (researchTurn.reply?.blocks as Block[] | undefined) ?? []
      : [];

  return (
    <KeyboardAvoidingView
      style={[styles.wrap, { backgroundColor: palette.bg }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.header, { backgroundColor: palette.surface, borderBottomColor: palette.rule }]}>
        <TouchableOpacity onPress={onBack}>
          <Text style={[styles.back, { color: palette.clay }]}>{S.close}</Text>
        </TouchableOpacity>
        <Text numberOfLines={1} style={[styles.headerTitle, { color: palette.ink }]}>
          {sitting?.session.title || S.appName}
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.thread}>
        {turns.map((turn, index) =>
          turn.role === "user" ? (
            <View key={index} style={[styles.userBubble, { backgroundColor: palette.clay }]}>
              <Text style={[styles.userText, { color: palette.surface }]}>{turn.text}</Text>
            </View>
          ) : (
            <View key={index} style={[styles.article, { backgroundColor: palette.surface, borderColor: palette.rule }]}>
              {turn.text ? (
                <Text style={[styles.articleQuestion, { color: palette.clay }]}>{turn.text}</Text>
              ) : null}
              {turn.blocks?.length ? <Blocks blocks={turn.blocks} palette={palette} /> : null}
              {turn.truncated ? (
                <Text style={[styles.note, { color: palette.gold }]}>{S.truncatedNote}</Text>
              ) : null}
            </View>
          )
        )}
        {phase === "running" ? (
          <View style={[styles.article, { backgroundColor: palette.surface, borderColor: palette.rule }]}>
            <Text style={[styles.phaseTitle, { color: palette.clay }]}>{S.phaseOne}</Text>
            {selections.length ? (
              <SelectionList selections={selections} palette={palette} />
            ) : (
              <View style={styles.runningRow}>
                <ActivityIndicator color={palette.clay} />
              </View>
            )}
            {pool.length ? (
              <View>
                <Text style={[styles.poolTitle, { color: palette.mute }]}>{S.poolTitle}</Text>
                <PoolList sources={pool} palette={palette} />
              </View>
            ) : null}
            <Text style={[styles.phaseTitle, { color: palette.clay }]}>{S.phaseTwo}</Text>
            <View style={styles.runningRow}>
              <ActivityIndicator color={palette.clay} />
              <Text style={[styles.note, { color: palette.mute }]}>
                {phaseNote ?? S.quotedRunning}
              </Text>
            </View>
          </View>
        ) : null}
        {phase === "failed" || phaseNote === S.selectionFailed ? (
          <Text style={[styles.note, { color: palette.bad }]}>{phaseNote ?? S.quotedFailed}</Text>
        ) : null}
        {researchTurn ? (
          <View style={[styles.article, { backgroundColor: palette.surface, borderColor: palette.rule }]}>
            <Text style={[styles.phaseTitle, { color: palette.clay }]}>{S.phaseThree}</Text>
            {(researchTurn.events ?? []).map((line, index) => (
              <Text key={index} style={[styles.note, { color: palette.mute }]}>
                {line}
              </Text>
            ))}
            {researchTurn.state !== "done" ? (
              <View style={styles.runningRow}>
                <ActivityIndicator color={palette.clay} />
                <Text style={[styles.note, { color: palette.mute }]}>
                  {researchTurn.state} · {Math.round(researchTurn.elapsed ?? 0)}s
                </Text>
              </View>
            ) : (
              <View>
                <Blocks blocks={researchReplyBlocks} palette={palette} />
                {Array.isArray(researchTurn.reply?.references) ? (
                  <References items={researchTurn.reply?.references as string[]} palette={palette} />
                ) : null}
                {(researchTurn.suggestions ?? []).map((chip) => (
                  <TouchableOpacity
                    key={chip}
                    style={[styles.chip, { borderColor: palette.rule }]}
                    onPress={() => sendResearch(chip)}
                  >
                    <Text style={{ color: palette.clay }}>{chip}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            {researchTurn.state === "failed" ? (
              <Text style={[styles.note, { color: palette.bad }]}>
                {researchTurn.detail ?? S.researchFailed}
              </Text>
            ) : null}
          </View>
        ) : null}
        {error ? <Text style={[styles.note, { color: palette.bad }]}>{error}</Text> : null}
      </ScrollView>
      <View style={[styles.composer, { backgroundColor: palette.surface, borderTopColor: palette.rule }]}>
        <TextInput
          style={[styles.input, { borderColor: palette.rule, color: palette.ink, backgroundColor: palette.raised }]}
          value={query}
          onChangeText={setQuery}
          placeholder={S.askPlaceholder}
          placeholderTextColor={palette.mute}
          multiline
        />
        <TouchableOpacity
          style={[styles.send, { backgroundColor: palette.clay }]}
          onPress={ask}
          disabled={phase === "running" || !query.trim()}
        >
          <Text style={[styles.sendText, { color: palette.surface }]}>{S.askSend}</Text>
        </TouchableOpacity>
      </View>
      <View style={[styles.composer, { backgroundColor: palette.surface, borderTopColor: palette.rule }]}>
        <TextInput
          style={[styles.input, { borderColor: palette.rule, color: palette.ink, backgroundColor: palette.raised }]}
          value={researchText}
          onChangeText={setResearchText}
          placeholder={S.researchPlaceholder}
          placeholderTextColor={palette.mute}
          multiline
        />
        <TouchableOpacity
          style={[styles.send, { backgroundColor: palette.gold }]}
          onPress={() => sendResearch(researchText)}
          disabled={researchBusy || !researchText.trim()}
        >
          <Text style={[styles.sendText, { color: palette.surface }]}>{S.researchSend}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
  },
  header: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  back: {
    fontSize: 14,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "700",
    flex: 1,
    textAlign: "right",
  },
  thread: {
    padding: 12,
  },
  userBubble: {
    alignSelf: "flex-start",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginVertical: 6,
    maxWidth: "90%",
  },
  userText: {
    fontSize: 15,
    textAlign: "right",
  },
  article: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginVertical: 6,
  },
  articleQuestion: {
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 6,
    textAlign: "right",
  },
  phaseTitle: {
    fontSize: 14,
    fontWeight: "700",
    marginTop: 8,
    textAlign: "right",
  },
  poolTitle: {
    fontSize: 12,
    marginTop: 10,
    textAlign: "right",
  },
  runningRow: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
  },
  note: {
    fontSize: 13,
    marginTop: 8,
    textAlign: "right",
  },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 8,
    alignSelf: "flex-end",
  },
  composer: {
    flexDirection: "row-reverse",
    alignItems: "flex-end",
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
    maxHeight: 96,
    textAlign: "right",
  },
  send: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendText: {
    fontSize: 14,
    fontWeight: "700",
  },
});
