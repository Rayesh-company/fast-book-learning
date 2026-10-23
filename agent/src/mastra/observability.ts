import { Observability, MastraStorageExporter, SensitiveDataFilter } from "@mastra/observability";

export const observability = new Observability({
  configs: {
    default: {
      serviceName: "chat-with-books",
      exporters: [new MastraStorageExporter()],
      spanOutputProcessors: [new SensitiveDataFilter()],
    },
  },
});
