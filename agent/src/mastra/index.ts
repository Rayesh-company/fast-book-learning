import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { chatAgent } from "./agents/chat-agent";
import { observability } from "./observability";

const STORAGE_URL = process.env.MASTRA_STORAGE_URL ?? "file:./data/mastra.sqlite";

if (STORAGE_URL.startsWith("file:")) {
  // The libsql client resolves file: paths against the working
  // directory (agent/ under mastra dev); create the directory there.
  const filePath = resolve(STORAGE_URL.slice("file:".length));
  mkdirSync(dirname(filePath), { recursive: true });
}

export const mastra = new Mastra({
  agents: { chatAgent },
  storage: new LibSQLStore({
    id: "chat-agent-storage",
    url: STORAGE_URL,
  }),
  observability,
});
