import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { LibSQLStore } from "@mastra/libsql";
import { RequestContext } from "@mastra/core/request-context";
import { searchBooksTool } from "./tools/search-books";
import { chatAgent } from "./agents/chat-agent";
import { observability } from "./observability";
import { mastra } from "./index";

describe("searchBooksTool Cognee child span (direct execution with mocked tracing context)", () => {
  const fetchMock = vi.fn();

  beforeAll(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env.AGENT_SERVICE_TOKEN = "test-token";
    process.env.PYTHON_CORE_URL = "http://core.test";
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  it("creates a generic cognee-recall child span, passes session_id in recall body, and ends with success and passage_count", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          passages: [
            { reference: "طرح کلی ص ۱۰", passage: "متن نمونه یک" },
            { reference: "طرح کلی ص ۲۰", passage: "متن نمونه دو" },
          ],
        }),
        { status: 200 },
      ),
    );

    const spanEndMock = vi.fn();
    const spanErrorMock = vi.fn();
    const mockSpan = {
      end: spanEndMock,
      error: spanErrorMock,
    };
    const createChildSpanMock = vi.fn().mockReturnValue(mockSpan);

    const mockContext = {
      requestContext: {
        get: (key: string) => {
          if (key === "requestId") return "req-test-trace-123";
          if (key === "datasets") return ["tarhe-kolli"];
          return undefined;
        },
      },
      tracing: {
        currentSpan: {
          createChildSpan: createChildSpanMock,
        },
      },
    };

    const result = await (searchBooksTool as any).execute(
      { query: "ایمان و عمل" },
      mockContext,
    );

    // 1. Verify child span creation with generic type, name, metadata, and input
    expect(createChildSpanMock).toHaveBeenCalledTimes(1);
    const childSpanArgs = createChildSpanMock.mock.calls[0][0];
    expect(childSpanArgs.type).toBe("generic");
    expect(childSpanArgs.name).toBe("cognee-recall");
    expect(childSpanArgs.input).toEqual({ query: "ایمان و عمل" });
    expect(childSpanArgs.metadata.request_id).toBe("req-test-trace-123");
    expect(childSpanArgs.metadata.datasets).toEqual(["tarhe-kolli"]);

    // 2. Verify session_id sent in recall POST body
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://core.test/agent/recall");
    const parsedBody = JSON.parse(init.body);
    expect(parsedBody.session_id).toBe("req-test-trace-123");
    expect(parsedBody.query).toBe("ایمان و عمل");
    expect(parsedBody.datasets).toEqual(["tarhe-kolli"]);

    // 3. Verify span.end called with success status and passage count
    expect(spanEndMock).toHaveBeenCalledTimes(1);
    expect(spanErrorMock).not.toHaveBeenCalled();
    const endArgs = spanEndMock.mock.calls[0][0];
    expect(endArgs.output).toEqual({ passages: 2 });
    expect(endArgs.attributes.status).toBe("success");
    expect(endArgs.attributes.searchType).toBe("recall");
    expect(endArgs.attributes.datasets).toEqual(["tarhe-kolli"]);
    expect(endArgs.attributes.passage_count).toBe(2);
    expect(endArgs.attributes.passage_references).toEqual(["طرح کلی ص ۱۰", "طرح کلی ص ۲۰"]);
    expect(endArgs.attributes.passage_lengths).toEqual([12, 12]);
    expect(typeof endArgs.attributes.latency_ms).toBe("number");
    expect(endArgs.attributes.latency_ms).toBeGreaterThanOrEqual(0);

    // 4. Verify tool return value
    expect(result.passages).toHaveLength(2);
  });

  it("records status: 'error' on child span when recall returns non-200 HTTP status and returns empty passages", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Internal error" }), { status: 500 }),
    );

    const spanEndMock = vi.fn();
    const spanErrorMock = vi.fn();
    const mockSpan = {
      end: spanEndMock,
      error: spanErrorMock,
    };
    const createChildSpanMock = vi.fn().mockReturnValue(mockSpan);

    const mockContext = {
      requestContext: {
        get: (key: string) => (key === "requestId" ? "req-500-error" : undefined),
      },
      tracing: {
        currentSpan: {
          createChildSpan: createChildSpanMock,
        },
      },
    };

    const result = await (searchBooksTool as any).execute(
      { query: "خطای سرور" },
      mockContext,
    );

    expect(result).toEqual({ passages: [] });
    expect(spanEndMock).not.toHaveBeenCalled();
    expect(spanErrorMock).toHaveBeenCalledTimes(1);
    const errorArgs = spanErrorMock.mock.calls[0][0];
    expect(errorArgs.error).toBeInstanceOf(Error);
    expect(errorArgs.error.message).toContain("500");
    expect(errorArgs.attributes.status).toBe("error");
    expect(errorArgs.attributes.status_code).toBe(500);
    expect(typeof errorArgs.attributes.latency_ms).toBe("number");
  });

  it("records status: 'error' on child span when fetch throws a network error and returns empty passages", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Seam connection refused"));

    const spanEndMock = vi.fn();
    const spanErrorMock = vi.fn();
    const mockSpan = {
      end: spanEndMock,
      error: spanErrorMock,
    };
    const createChildSpanMock = vi.fn().mockReturnValue(mockSpan);

    const mockContext = {
      requestContext: {
        get: (key: string) => (key === "requestId" ? "req-net-error" : undefined),
      },
      tracing: {
        currentSpan: {
          createChildSpan: createChildSpanMock,
        },
      },
    };

    const result = await (searchBooksTool as any).execute(
      { query: "خطای شبکه" },
      mockContext,
    );

    expect(result).toEqual({ passages: [] });
    expect(spanEndMock).not.toHaveBeenCalled();
    expect(spanErrorMock).toHaveBeenCalledTimes(1);
    const errorArgs = spanErrorMock.mock.calls[0][0];
    expect(errorArgs.error).toBeInstanceOf(Error);
    expect(errorArgs.error.message).toContain("Seam connection refused");
    expect(errorArgs.attributes.status).toBe("error");
    expect(typeof errorArgs.attributes.latency_ms).toBe("number");
  });

  it("safely no-ops span handling when tracing is not provided", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ passages: [] }), { status: 200 }),
    );

    const result = await (searchBooksTool as any).execute(
      { query: "بدون ترسینگ" },
      {},
    );

    expect(result).toEqual({ passages: [] });
  });
});

describe("Mastra Agent trace integration with cognee-recall child span", () => {
  let server: Server;
  let recallRequestBody: any = null;

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
          // 1st completion calls searchBooksTool
          if (!req.headers["x-second-call"]) {
            send(200, {
              id: "chatcmpl-cognee-1",
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: "test-model",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_books_span_1",
                        type: "function",
                        function: {
                          name: "searchBooksTool",
                          arguments: JSON.stringify({ query: "ولایت در اسلام" }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            });
            return;
          }

          // 2nd completion answers
          send(200, {
            id: "chatcmpl-cognee-2",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "test-model",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "پاسخ درباره ولایت در اسلام.",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          });
          return;
        }

        if (url.includes("/agent/recall")) {
          recallRequestBody = raw ? JSON.parse(raw) : null;
          send(200, {
            passages: [
              {
                reference: "طرح کلی ص ۱۲۰",
                passage: "ولایت به معنای پیوستگی جبهه حق است.",
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
    process.env.AVALAI_API_KEY = "test-agent-key";
    process.env.PYTHON_CORE_URL = `http://127.0.0.1:${addr.port}`;
    process.env.AGENT_SERVICE_TOKEN = "test-token";
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("records cognee-recall child span in the trace under the search-books tool call span", async () => {
    const traceId = randomBytes(16).toString("hex");
    const requestId = `req-integration-span-${traceId.slice(0, 8)}`;

    const requestContext = new RequestContext();
    requestContext.set("requestId", requestId);
    requestContext.set("datasets", ["tarhe-kolli"]);

    let callCount = 0;
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const url = req.url ?? "";
        const send = (status: number, payload: any) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };

        if (url.includes("/chat/completions")) {
          callCount++;
          if (callCount === 1) {
            send(200, {
              id: "chatcmpl-cognee-1",
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: "test-model",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_books_span_1",
                        type: "function",
                        function: {
                          name: "searchBooksTool",
                          arguments: JSON.stringify({ query: "ولایت در اسلام" }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            });
            return;
          }

          send(200, {
            id: "chatcmpl-cognee-2",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "test-model",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "پاسخ درباره ولایت در اسلام.",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          });
          return;
        }

        if (url.includes("/agent/recall")) {
          recallRequestBody = raw ? JSON.parse(raw) : null;
          send(200, {
            passages: [
              {
                reference: "طرح کلی ص ۱۲۰",
                passage: "ولایت به معنای پیوستگی جبهه حق است.",
              },
            ],
          });
          return;
        }

        send(404, { error: "not found", url });
      });
    });

    const result = await chatAgent.generate(
      [{ role: "user", content: "ولایت چیست؟" }],
      {
        tracingOptions: { traceId },
        requestContext: requestContext as any,
      },
    );

    expect(result.text).toContain("ولایت در اسلام");

    // Verify session_id was passed to python recall endpoint
    expect(recallRequestBody).not.toBeNull();
    expect(recallRequestBody.session_id).toBe(requestId);
    expect(recallRequestBody.datasets).toEqual(["tarhe-kolli"]);

    // Flush buffered observability events to storage
    await observability.flush();

    // Query trace from the storage observability domain
    const storage = mastra.getStorage() as LibSQLStore;
    const obsStore = await storage.getStore("observability");
    const trace = await obsStore!.getTrace({ traceId });

    expect(trace).toBeDefined();
    expect(trace?.traceId).toBe(traceId);

    // Verify cognee-recall child span is present in the trace
    const cogneeSpan = trace?.spans.find(
      (s: any) => s.name === "cognee-recall" || s.entityName === "cognee-recall",
    );
    expect(cogneeSpan).toBeDefined();
    expect(cogneeSpan?.spanType).toBe("generic");
    expect(cogneeSpan?.attributes?.status).toBe("success");
    expect(cogneeSpan?.attributes?.passage_count).toBe(1);
    expect(cogneeSpan?.attributes?.searchType).toBe("recall");
  });
});
