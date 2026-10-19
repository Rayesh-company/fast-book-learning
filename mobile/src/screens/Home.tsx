// The Sessions list (the store's sidebar, on the phone) — and the live
// line's first consumer: any settle anywhere re-reads the list, so an
// ask on the web opens the sitting here the moment it lands.
import { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { Palette, SessionRow } from "../types";
import { S } from "../strings";
import { api } from "../api";

const BOOKS: { dataset: string; title: string }[] = [
  { dataset: "tarhe-kolli", title: S.bookTarheKolli },
  { dataset: "70143-336", title: S.bookEnsan250 },
];

export function HomeScreen({
  palette,
  onOpen,
  onLoggedOut,
  refreshToken,
}: {
  palette: Palette;
  onOpen: (session: SessionRow) => void;
  onLoggedOut: () => void;
  refreshToken: number;
}) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const payload = await api.sessions();
      setSessions(payload.sessions ?? []);
      setError(null);
    } catch (exc: any) {
      if (exc?.status === 401) {
        onLoggedOut();
        return;
      }
      setError(S.offline);
    }
  }, [onLoggedOut]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshToken]);

  const createSitting = async (dataset: string, title: string) => {
    setPicking(false);
    try {
      const session = await api.createSession(dataset, title);
      onOpen({ id: session.id, title, book: dataset });
    } catch (exc: any) {
      setError(exc?.message ?? S.offline);
    }
  };

  return (
    <View style={[styles.wrap, { backgroundColor: palette.bg }]}>
      <View style={[styles.header, { backgroundColor: palette.surface, borderBottomColor: palette.rule }]}>
        <Text style={[styles.headerTitle, { color: palette.ink }]}>{S.sessionsTitle}</Text>
        <TouchableOpacity onPress={() => setPicking(true)}>
          <Text style={[styles.newButton, { color: palette.clay }]}>{S.newSession}</Text>
        </TouchableOpacity>
      </View>
      {error ? <Text style={[styles.error, { color: palette.bad }]}>{error}</Text> : null}
      <FlatList
        data={sessions}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.row, { backgroundColor: palette.surface, borderColor: palette.rule }]}
            onPress={() => onOpen(item)}
          >
            <Text numberOfLines={1} style={[styles.rowTitle, { color: palette.ink }]}>
              {item.title || S.appName}
            </Text>
            {item.book ? (
              <Text style={[styles.rowBook, { color: palette.mute }]}>{item.book}</Text>
            ) : null}
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: palette.mute }]}>{S.emptySessions}</Text>
        }
      />
      <Modal visible={picking} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: palette.surface, borderColor: palette.rule }]}>
            <Text style={[styles.modalTitle, { color: palette.ink }]}>{S.pickBook}</Text>
            {BOOKS.map((book) => (
              <TouchableOpacity
                key={book.dataset}
                style={[styles.bookRow, { borderColor: palette.rule }]}
                onPress={() => createSitting(book.dataset, book.title)}
              >
                <Text style={[styles.rowTitle, { color: palette.ink }]}>{book.title}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={() => setPicking(false)}>
              <Text style={[styles.rowBook, { color: palette.mute }]}>{S.close}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
  },
  header: {
    flexDirection: "row-reverse",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
  },
  newButton: {
    fontSize: 15,
    fontWeight: "700",
  },
  list: {
    padding: 12,
  },
  row: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: "600",
    textAlign: "right",
  },
  rowBook: {
    fontSize: 12,
    marginTop: 4,
    textAlign: "right",
  },
  empty: {
    textAlign: "center",
    marginTop: 40,
    fontSize: 14,
  },
  error: {
    textAlign: "center",
    fontSize: 12,
    padding: 6,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(28,20,10,0.5)",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: "700",
    textAlign: "right",
    marginBottom: 10,
  },
  bookRow: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
});
