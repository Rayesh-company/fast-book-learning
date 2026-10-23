import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { LibSQLStore } from "@mastra/libsql";
import { chatAgent } from "./agents/chat-agent";
import { observability } from "./observability";
import { mastra } from "./index";

let server: Server;
let modelCalls = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (status: number, payload: any) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (url.includes("/chat/completions")) {
        const n = modelCalls++;
        if (n === 0) {
          send(200, {
            id: "chatcmpl-obs-1",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "obs-model",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_books_obs_1",
                      type: "function",
                      function: {
                        name: "searchBooksTool",
                        arguments: JSON.stringify({ query: "توحید در قرآن" }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
          });
          return;
        }

        send(200, {
          id: "chatcmpl-obs-2",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "obs-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "توحید در قرآن مبنای عمل اجتماعی است document tarhe-kolli (page 50).",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 },
        });
        return;
      }

      if (url.includes("/agent/recall")) {
        send(200, {
          passages: [
            {
              reference: "طرح کلی اندیشه اسلامی ص ۵۰",
              passage: "توحید یک اندیشه انقلابی و سازنده است.",
            },
          ],
        });
        return;
      }

      send(404, { error: "not found", url });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  process.env.AVALAI_BASE_URL = `http://127.0.0.1:${addr.port}`;
  process.env.AVALAI_API_KEY = "test-obs-key";
  process.env.PYTHON_CORE_URL = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Mastra observability integration", () => {
  it("wires observability into the main mastra instance in index.ts", () => {
    expect(mastra.observability).toBeDefined();
    expect(mastra.observability).toBe(observability);
  });

  it("records a trace matching the provided traceId and contains a search-books tool span", async () => {
    const traceId = "0123456789abcdef0123456789abcdef";

    const result = await chatAgent.generate(
      [{ role: "user", content: "درباره توحید در قرآن بگو" }],
      {
        tracingOptions: { traceId },
      },
    );

    expect(result.text).toContain("توحید در قرآن");

    // Flush buffered observability events to storage
    await observability.flush();

    // Query trace from the storage observability domain
    const storage = mastra.getStorage() as LibSQLStore;
    const obsStore = await storage.getStore("observability");
    expect(obsStore).toBeDefined();

    const trace = await obsStore!.getTrace({ traceId });

    expect(trace).toBeDefined();
    expect(trace?.traceId).toBe(traceId);
    expect(trace?.spans).toBeDefined();
    expect(trace?.spans.length).toBeGreaterThan(0);

    // Verify search-books tool span was recorded in the trace
    const toolSpan = trace?.spans.find(
      (s: any) =>
        s.spanType === "tool_call" &&
        (/search.*book/i.test(s.name) || /search.*book/i.test(s.entityId)),
    );
    expect(toolSpan).toBeDefined();
  });
});
