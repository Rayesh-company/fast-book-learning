import { Observability, MastraStorageExporter, SensitiveDataFilter } from "@mastra/observability";

/**
 * Mastra Observability configuration for chat-with-books.
 *
 * Spans, traces, and metric observations collected through this instance are exported
 * via MastraStorageExporter to the DuckDB-backed observability storage domain
 * (DuckDBStore) configured on the MastraCompositeStore in ./index.ts.
 *
 * While LibSQLStore serves as the default relational operational store (threads, chats),
 * DuckDBStore powers the observability domain for OLAP trace querying, metric aggregations,
 * and Mastra Studio inspection (http://localhost:4111).
 */
export const observability = new Observability({
  configs: {
    default: {
      serviceName: "chat-with-books",
      exporters: [new MastraStorageExporter()],
      spanOutputProcessors: [new SensitiveDataFilter()],
    },
  },
});

