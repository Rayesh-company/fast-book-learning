import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Agent, setGlobalDispatcher } from "undici";
import { Mastra } from "@mastra/core";
import { MastraCompositeStore } from "@mastra/core/storage";
import { LibSQLStore } from "@mastra/libsql";
import { DuckDBStore } from "@mastra/duckdb";
import { chatAgent } from "./agents/chat-agent";
import { observability } from "./observability";

setGlobalDispatcher(
  new Agent({
    connect: { timeout: 60_000 },
    headersTimeout: 60_000,
    bodyTimeout: 120_000,
  })
);

const STORAGE_URL = process.env.MASTRA_STORAGE_URL ?? "file:./data/mastra.sqlite";
const DUCKDB_PATH =
  process.env.MASTRA_DUCKDB_PATH ??
  (process.env.NODE_ENV === "test" || process.env.VITEST
    ? ":memory:"
    : resolve("./data/mastra-observability.duckdb"));

function ensureParentDir(target: string): void {
  if (target === ":memory:") {
    return;
  }
  // Remote URLs (e.g. libsql://, http://) do not map to local directories.
  if (target.includes("://") && !target.startsWith("file://")) {
    return;
  }
  let filePath = target;
  if (target.startsWith("file:")) {
    try {
      filePath = fileURLToPath(target);
    } catch {
      filePath = fileURLToPath(new URL(target, pathToFileURL("./").href));
    }
  }
  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}

ensureParentDir(STORAGE_URL);
ensureParentDir(DUCKDB_PATH);

export const mastra = new Mastra({
  agents: { chatAgent },
  storage: new MastraCompositeStore({
    id: "chat-agent-storage",
    default: new LibSQLStore({
      id: "chat-agent-libsql",
      url: STORAGE_URL,
    }),
    domains: {
      observability: new DuckDBStore({
        id: "chat-agent-duckdb",
        path: DUCKDB_PATH,
      }).observability,
    },
  }),
  observability,
});
