// The live line (ADR-0020): the Account's SSE stream, read on the
// phone through expo/fetch's streaming body — EventSource semantics
// with a Bearer header. A dropped line reconnects with a short
// backoff; a runtime without streaming bodies degrades to a quiet
// retry, never a crash (the stores, not the stream, are the truth).
import { fetch as expoFetch } from "expo/fetch";
import { BASE_URL } from "./api";

export type LiveEvent = { kind: string; [key: string]: unknown };

export function subscribeEvents(
  getToken: () => Promise<string | null>,
  onEvent: (event: LiveEvent) => void,
  onStateChange?: (up: boolean) => void
): () => void {
  let stopped = false;
  let controller: AbortController | null = null;

  async function run() {
    let backoffMs = 1000;
    while (!stopped) {
      controller = new AbortController();
      try {
        const token = await getToken();
        if (!token || stopped) return;
        const response = await expoFetch(`${BASE_URL}/events`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`events ${response.status}`);
        }
        onStateChange?.(true);
        backoffMs = 1000;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done || stopped) break;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            for (const line of frame.split("\n")) {
              if (line.startsWith("data: ")) {
                try {
                  onEvent(JSON.parse(line.slice(6)));
                } catch {
                  // A malformed frame is skipped, never fatal.
                }
              }
            }
          }
        }
        onStateChange?.(false);
      } catch {
        if (!stopped) onStateChange?.(false);
      }
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 15000);
    }
  }

  run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
