// The serialized generate() reply's REAL shape (issue #24, probed
// 2026-10-07 against this agent with a canned OpenAI-compatible
// upstream): the contract the Python seam reads (ui/agent_client.py)
// and ticket #26 builds on. Two pins, nothing more: the model-facing
// tool NAME, and the tool-call record's field path in the reply.
import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One canned server answers both ends of the agent's round: the model
// (POST /chat/completions — turn 1 invokes the web tool, turn 2 answers
// in Farsi with NO «بیرون از کتاب» mark) and the web tool's own search
// endpoint (POST /search on the same AVALAI_BASE_URL). Everything else
// 404s loudly.
const seenToolNames: string[] = [];
let modelCalls = 0;
let server: Server;

function completionsBody(reqBody: any): any {
  const n = modelCalls++;
  if (n === 0) {
    const tools: any[] = Array.isArray(reqBody.tools) ? reqBody.tools : [];
    for (const t of tools) seenToolNames.push(String(t?.function?.name));
    const webName = seenToolNames.find((name) => /web/i.test(name))!;
    return {
      id: "chatcmpl-shape-1",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: reqBody.model ?? "shape-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_web_shape_1",
                type: "function",
                function: {
                  name: webName,
                  arguments: JSON.stringify({ query: "رویداد روز", maxResults: 3 }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  }
  return {
    id: "chatcmpl-shape-2",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: reqBody.model ?? "shape-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "پاسخ نهایی بدون نشان" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  };
}

const WEB_RESULTS = [
  { title: "منبع اول", url: "https://example.ir/one", snippet: "خلاصهٔ اول" },
  { title: "منبع دوم", url: "https://example.ir/two", snippet: "خلاصهٔ دوم" },
];

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the serialized generate() reply shape (#24)", () => {
  it("names the web tool webSearchTool and records its result under top-level toolResults", async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        const url = req.url ?? "";
        const send = (status: number, payload: any) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (url.includes("/chat/completions")) {
          if (body.stream === true) {
            send(400, { error: "this pin speaks the non-streamed dialect only" });
            return;
          }
          send(200, completionsBody(body));
          return;
        }
        if (url.includes("/search")) {
          send(200, { results: WEB_RESULTS });
          return;
        }
        send(404, { error: "no such route", url });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };

    const tmp = mkdtempSync(join(tmpdir(), "shape-mastra-"));
    process.env.AVALAI_BASE_URL = `http://127.0.0.1:${addr.port}`;
    process.env.AVALAI_API_KEY = "shape-key";
    process.env.MASTRA_STORAGE_URL = `file:${join(tmp, "shape.sqlite")}`;
    // chat-agent.ts and index.ts read env at module load — the import
    // stays after the pins above.
    const { mastra } = await import("./index.ts");
    const result = await mastra.getAgent("chatAgent").generate(
      [{ role: "user", content: "یک رویداد روز را از اینترنت بگو" }],
      { memory: { thread: "shape", resource: "shape" } },
    );
    const reply = JSON.parse(JSON.stringify(result));

    // Pin 1 — the tool name the MODEL sees is the tools record's object
    // key, not the tool's own id ("web-search").
    expect(seenToolNames).toContain("webSearchTool");

    // Pin 2 — the executed web round lands in the reply's top-level
    // toolResults[] as payload {toolName, result: {results}}, while the
    // final text is just the prose (the marking is NOT the text's).
    expect(reply.text).toBe("پاسخ نهایی بدون نشان");
    const webRecords = (reply.toolResults ?? []).filter(
      (r: any) => r?.payload?.toolName === "webSearchTool",
    );
    expect(webRecords).toHaveLength(1);
    expect(webRecords[0].payload.result.results).toEqual(WEB_RESULTS);
  });
});
