// The shared API's client (ADR-0020): the sheet's own wire protocol,
// spoken from the phone. One backend — the same server the web sheet
// talks to — and one credential: the login token in the device's
// secure store, riding Authorization: Bearer on every call.
import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "cwb_auth_token";

export const BASE_URL = (
  process.env.EXPO_PUBLIC_API_URL ?? "https://booksai.rayesh-team.ir"
).replace(/\/+$/, "");

export type Source = { reference: string; passage: string };

export type Selection = { text: string; reference: string; pages_label?: string };

export type QuotePart = {
  text?: string;
  quote?: string;
  reference?: string;
  pages_label?: string;
};

export type Block =
  | { type: "heading"; text: string }
  | { type: "paragraph"; parts: QuotePart[] };

export type SessionRow = {
  id: number;
  title: string;
  book: string;
  updated_at?: string;
};

export type StoreMessage = {
  role: "user" | "assistant";
  payload: {
    text?: string;
    question?: string;
    blocks?: Block[];
    truncated?: boolean;
    citations?: Source[];
    [key: string]: unknown;
  };
};

export type SittingPayload = {
  session: SessionRow & { research_session_id?: string | null };
  messages: StoreMessage[];
};

export type AskReply = {
  chat_id: string;
  sources: Source[];
  pool_size: number;
};

export type TurnStatus = {
  state: string;
  events?: string[];
  elapsed?: number;
  reply?: { blocks?: Block[]; references?: string[]; [k: string]: unknown };
  suggestions?: string[];
  detail?: string;
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

let cachedToken: string | null = null;

export async function loadToken(): Promise<string | null> {
  if (cachedToken === null) {
    try {
      cachedToken = await SecureStore.getItemAsync(TOKEN_KEY);
    } catch {
      cachedToken = null;
    }
  }
  return cachedToken;
}

export async function storeToken(token: string | null): Promise<void> {
  cachedToken = token;
  try {
    if (token === null) {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
    } else {
      await SecureStore.setItemAsync(TOKEN_KEY, token);
    }
  } catch {
    // A store miss must not erase the in-memory credential: the
    // session works until the app dies, then asks again.
  }
}

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const token = await loadToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const text = await response.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    // The server's Farsi detail is the message the operator reads.
    throw new ApiError(response.status, payload?.detail ?? `خطا (${response.status})`);
  }
  return payload as T;
}

export const api = {
  async login(email: string, password: string): Promise<{ email: string; role: string }> {
    const payload = await call<{ email: string; role: string; token: string }>(
      "/auth/login",
      { method: "POST", json: { email, password } }
    );
    await storeToken(payload.token);
    return { email: payload.email, role: payload.role };
  },

  async logout(): Promise<void> {
    try {
      await call("/auth/logout", { method: "POST", json: {} });
    } catch {}
    await storeToken(null);
  },

  sessions(): Promise<{ sessions: SessionRow[] }> {
    return call("/sessions");
  },

  createSession(book: string, title: string): Promise<{ id: number }> {
    return call("/sessions", { method: "POST", json: { book, title } });
  },

  sitting(id: number): Promise<SittingPayload> {
    return call(`/sessions/${id}`);
  },

  appendMessage(id: number, role: string, payload: unknown): Promise<unknown> {
    return call(`/sessions/${id}/messages`, { method: "POST", json: { role, payload } });
  },

  ask(query: string, datasets: string[]): Promise<AskReply> {
    return call("/ask", { method: "POST", json: { query, datasets } });
  },

  quoteSelection(
    question: string,
    sources: Source[],
    sessionId?: number,
    askKey?: string
  ): Promise<{ selections: Selection[]; pool_size: number }> {
    return call("/quote-selection", {
      method: "POST",
      json: {
        question,
        sources,
        session_id: sessionId,
        ask_key: askKey,
      },
    });
  },

  quotedAnswer(
    question: string,
    sources: Source[],
    opts: { sessionId?: number; askKey?: string; chatId?: string }
  ): Promise<{ blocks: Block[]; truncated: boolean }> {
    return call("/quoted-answer", {
      method: "POST",
      json: {
        question,
        sources,
        session_id: opts.sessionId,
        ask_key: opts.askKey,
        chat_id: opts.chatId,
      },
    });
  },

  researchStart(message: string, opts: { book?: string; chatSessionId?: number }): Promise<{
    turn_id: string;
    session_id: string;
  }> {
    const body: Record<string, unknown> = { message };
    // The first message seeds the research conversation: the ask's
    // question and pool are optional (the composer's toggle line),
    // the Book pick rides along.
    if (opts.book) body.datasets = [opts.book];
    if (opts.chatSessionId) body.chat_session_id = opts.chatSessionId;
    return call("/research/message", { method: "POST", json: body });
  },

  researchTurn(turnId: string): Promise<TurnStatus> {
    return call(`/research/turn?turn=${encodeURIComponent(turnId)}`);
  },

  researchState(sessionId: string): Promise<Record<string, unknown>> {
    return call(`/research/state?session=${encodeURIComponent(sessionId)}`);
  },
};
