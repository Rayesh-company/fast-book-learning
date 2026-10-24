// The streamed reply's REAL dialect (issue #26, probed 2026-10-07
// against this agent with a canned OpenAI-compatible upstream answering
// /chat/completions with streaming chunks): the contract the Python
// seam relays (ui/agent_client.py's AgentStream) and the sheet's stream
// consumer read. Three pins, nothing more: the delta frame that carries
// answer text, the frame that carries an EXECUTED tool's result (the
// «بیرون از کتاب» guarantee's source — #24's contract survives onto the
// streamed path), and the completion signal.
//
// Wire note: the HTTP route (POST /api/agents/chat-agent/stream,
// streamFormat "sse" — @mastra/server's agents handler) returns
// agent.stream(...).fullStream, and the server serializes EACH chunk as
// ONE `data: <json>\n\n` line, appending a final `data: [DONE]\n\n`
// after the last chunk (@mastra/deployer's stream serialization). The
// in-process parts iterated below ARE the JSON those data lines carry.
import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One canned server answers both ends of the agent's streamed round: the
// model (POST /chat/completions with stream:true — turn 1 invokes the
// web tool, turn 2 answers in Farsi with NO «بیرون از کتاب» mark) and
// the web tool's own search endpoint (POST /search on the same
// AVALAI_BASE_URL). Everything else 404s loudly.
const seenToolNames: string[] = [];
let modelCalls = 0;
let server: Server;

function sseChunk(delta: any, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-stream-shape",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "shape-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function firstTurnBody(reqBody: any): string {
  const tools: any[] = Array.isArray(reqBody.tools) ? reqBody.tools : [];
  for (const t of tools) seenToolNames.push(String(t?.function?.name));
  const webName = seenToolNames.find((name) => /web/i.test(name))!;
  return (
    sseChunk({
      role: "assistant",
      tool_calls: [
        {
          id: "call_web_stream_1",
          type: "function",
          index: 0,
          function: {
            name: webName,
            arguments: JSON.stringify({ query: "رویداد روز", maxResults: 3 }),
          },
        },
      ],
    }) + sseChunk({}, "tool_calls")
  );
}

function secondTurnBody(): string {
  // Two content deltas — the sheet's progressive text composes from
  // exactly these.
  return (
    sseChunk({ role: "assistant" }) +
    sseChunk({ content: "پاسخ " }) +
    sseChunk({ content: "نهایی" }) +
    sseChunk({}, "stop")
  );
}

const WEB_RESULTS = [
  { title: "منبع اول", url: "https://example.ir/one", snippet: "خلاصهٔ اول" },
  { title: "منبع دوم", url: "https://example.ir/two", snippet: "خلاصهٔ دوم" },
];

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the streamed reply's SSE dialect (#26)", () => {
  it("carries answer text in text-delta frames, tool records in tool-result frames, and finishes with a finish frame", async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        const url = req.url ?? "";
        const send = (status: number, payload: any, type = "application/json") => {
          res.writeHead(status, { "Content-Type": type });
          res.end(JSON.stringify(payload));
        };
        const sendSSE = (events: string) => {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(events);
          res.write("data: [DONE]\n\n");
          res.end();
        };
        if (url.includes("/chat/completions")) {
          if (body.stream !== true) {
            send(400, { error: "this pin speaks the streamed dialect only" });
            return;
          }
          sendSSE(modelCalls++ === 0 ? firstTurnBody(body) : secondTurnBody());
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

    const tmp = mkdtempSync(join(tmpdir(), "stream-shape-mastra-"));
    process.env.AVALAI_BASE_URL = `http://127.0.0.1:${addr.port}`;
    process.env.AVALAI_API_KEY = "shape-key";
    process.env.MASTRA_STORAGE_URL = `file:${join(tmp, "shape.sqlite")}`;
    // chat-agent.ts and index.ts read env at module load — the import
    // stays after the pins above.
    const { mastra } = await import("./index.ts");
    const result = await mastra.getAgent("chatAgent").stream(
      [{ role: "user", content: "یک رویداد روز را از اینترنت بگو" }],
      { memory: { thread: "shape-stream", resource: "shape-stream" } },
    );
    const chunks: any[] = [];
    for await (const chunk of result.fullStream) {
      chunks.push(JSON.parse(JSON.stringify(chunk)));
    }

    // The model-facing tool NAME is unchanged on the streamed path.
    expect(seenToolNames).toContain("webSearchTool");

    // Pin 1 — the delta frame: {"type":"text-delta","payload":{"id","text"}}.
    const deltas = chunks.filter((c) => c?.type === "text-delta");
    expect(deltas.map((c) => c.payload?.text).join("")).toBe("پاسخ نهایی");
    for (const delta of deltas) {
      expect(typeof delta.payload?.id).toBe("string");
    }

    // Pin 2 — the executed tool's record:
    // {"type":"tool-result","payload":{toolCallId, toolName, args,
    //  result:{results}}} — the payload IS the generate() reply's
    // toolResults[] entry payload (generate-shape.test.ts's pin), so the
    // seam's ONE derivation covers both paths.
    const toolResults = chunks.filter((c) => c?.type === "tool-result");
    expect(toolResults).toHaveLength(1);
    const webRecord = toolResults.find(
      (c) => c.payload?.toolName === "webSearchTool",
    );
    expect(webRecord).toBeDefined();
    expect(webRecord.payload.result.results).toEqual(WEB_RESULTS);
    expect(webRecord.payload.toolCallId).toBe("call_web_stream_1");
    expect(webRecord.payload.args).toEqual({
      query: "رویداد روز",
      maxResults: 3,
    });

    // Pin 3 — the completion signal: a terminal {"type":"finish"} chunk
    // (after per-turn step-finish chunks) is the stream's LAST chunk;
    // on the wire the server then writes its `data: [DONE]` line.
    expect(chunks[chunks.length - 1]?.type).toBe("finish");
    const finishIndex = chunks.findIndex((c) => c?.type === "finish");
    expect(chunks.slice(finishIndex + 1)).toEqual([]);
  });
});
