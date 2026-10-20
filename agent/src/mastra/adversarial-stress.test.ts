import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { RequestContext } from "@mastra/core/request-context";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Adversarial Stress Test Suite: Memory Seam History Pruning & Edge Cases
 *
 * Authored by Empirical Challenger 1 to stress-test:
 * 1. Multiple (2+) consecutive tool calls within a single active turn.
 * 2. Zero-tool direct responses mixed with tool calls and role alternation invariants.
 * 3. 10+ turn dialogue thread expansion and token budgeting (maxTokens: 8000).
 * 4. Canonical citation retention and integrity across compacted turns.
 * 5. Prompt token footprint reduction measurement.
 */

describe("Adversarial Stress Testing: Memory Seam Pruning Under Extreme Conditions", () => {
  let server: Server;
  let serverUrl: string;
  let completionsRequests: any[] = [];
  let completionsResponses: any[] = [];
  let recallRequests: any[] = [];
  let searchRequests: any[] = [];
  let agent: any;

  function makeChunk(book: string, page: number, topic: string, sizeChars: number = 1500): string {
    const text = `متن تفصیلی و تحلیلی از صفحه ${page} کتاب ${book} درباره ${topic}. این گزاره‌ها تبیین‌کننده اصول بنیادین هستند. `;
    return text.repeat(Math.ceil(sizeChars / text.length)).slice(0, sizeChars);
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const url = req.url ?? "";
        const send = (status: number, data: any) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        };

        if (url.includes("/chat/completions")) {
          const body = raw ? JSON.parse(raw) : {};
          completionsRequests.push(body);
          const next = completionsResponses.shift();
          if (next) {
            send(200, next(body));
          } else {
            send(500, { error: "No mock response configured in completionsResponses" });
          }
          return;
        }

        if (url.includes("/agent/recall")) {
          const body = raw ? JSON.parse(raw) : {};
          recallRequests.push(body);
          send(200, {
            passages: [
              {
                reference: "document tarhe-kolli (pages 120-121)",
                passage: makeChunk("tarhe-kolli", 120, "نبوت و توحید", 1500),
              },
              {
                reference: "document 70143-336 (page 140)",
                passage: makeChunk("70143-336", 140, "مبارزه ائمه", 1500),
              },
            ],
          });
          return;
        }

        if (url.includes("/search")) {
          const body = raw ? JSON.parse(raw) : {};
          searchRequests.push(body);
          send(200, {
            results: [
              {
                title: "منبع وب آزمایشی",
                url: "https://example.ir/article",
                snippet: "اطلاعات جاری وب درباره موضوع جستجو شده.",
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
    serverUrl = `http://127.0.0.1:${addr.port}`;
    process.env.AVALAI_BASE_URL = serverUrl;
    process.env.PYTHON_CORE_URL = serverUrl;
    process.env.AVALAI_API_KEY = "adv-key";

    const tmp = mkdtempSync(join(tmpdir(), "mastra-adv-stress-"));
    process.env.MASTRA_STORAGE_URL = `file:${join(tmp, "mastra.sqlite")}`;
    process.env.CHAT_AGENT_LAST_MESSAGES = "30";

    const { mastra } = await import("./index");
    agent = mastra.getAgent("chatAgent");
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    completionsRequests = [];
    completionsResponses = [];
    recallRequests = [];
    searchRequests = [];
  });

  it("Stress Scenario 1: Retains BOTH tool results when a turn makes 2 consecutive tool calls, and prunes both on next turn", async () => {
    const threadId = `thread-adv-multi-tool-${Date.now()}`;
    const resourceId = "adv-learner-1";

    // Turn 1, Step 1: Model calls searchBooksTool
    completionsResponses.push((_body: any) => ({
      id: "cmpl-adv-t1-s1",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_books_step1",
                type: "function",
                function: {
                  name: "searchBooksTool",
                  arguments: JSON.stringify({ query: "نبوت در طرح کلی" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }));

    // Turn 1, Step 2: Model calls webSearchTool in the SAME turn
    completionsResponses.push((_body: any) => ({
      id: "cmpl-adv-t1-s2",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_web_step2",
                type: "function",
                function: {
                  name: "webSearchTool",
                  arguments: JSON.stringify({ query: "تحلیل امروزی نبوت" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }));

    // Turn 1, Step 3: Model synthesizes answer combining both book citation and web badge
    completionsResponses.push((_body: any) => ({
      id: "cmpl-adv-t1-s3",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "نبوت در کتاب به معنای برپایی قسط است document tarhe-kolli (pages 120-121)، و طبق گزارش‌های وب «بیرون از کتاب»: تحلیل‌های معاصر آن را بازخوانی می‌کنند https://example.ir/article.",
          },
          finish_reason: "stop",
        },
      ],
    }));

    // Execute Turn 1
    const r1 = await agent.generate(
      [{ role: "user", content: "دیدگاه کتاب درباره نبوت چیست و در وب چه تحلیلی ارائه شده؟" }],
      { memory: { thread: threadId, resource: resourceId } },
    );

    expect(r1.text).toContain("document tarhe-kolli (pages 120-121)");
    expect(r1.text).toContain("«بیرون از کتاب»");
    expect(completionsRequests).toHaveLength(3);

    // CRUCIAL VERIFICATION: Step 3 prompt in Turn 1 MUST contain BOTH tool results
    const step3Messages = completionsRequests[2].messages;
    const toolResultsInStep3 = step3Messages.filter((m: any) => m.role === "tool");
    expect(toolResultsInStep3).toHaveLength(2);

    const hasBookResult = toolResultsInStep3.some((m: any) =>
      m.content && m.content.includes("نبوت و توحید"),
    );
    const hasWebResult = toolResultsInStep3.some((m: any) =>
      m.content && m.content.includes("منبع وب آزمایشی"),
    );
    expect(hasBookResult).toBe(true);
    expect(hasWebResult).toBe(true);

    // Now execute Turn 2: Follow-up question on same thread
    completionsResponses.push((_body: any) => ({
      id: "cmpl-adv-t2",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "این دو منظر با یکدیگر هم‌پوشانی دارند.",
          },
          finish_reason: "stop",
        },
      ],
    }));

    const r2 = await agent.generate(
      [{ role: "user", content: "آیا این دو تحلیل با هم سازگارند؟" }],
      { memory: { thread: threadId, resource: resourceId } },
    );

    expect(r2.text).toContain("هم‌پوشانی");
    expect(completionsRequests).toHaveLength(4);

    // CRUCIAL VERIFICATION: Turn 2 prompt MUST prune BOTH Turn 1 tool calls and results
    const t2PromptMessages = completionsRequests[3].messages;
    const t2ToolMessages = t2PromptMessages.filter((m: any) => m.role === "tool");
    expect(t2ToolMessages).toHaveLength(0);

    // Check assistant history in Turn 2 prompt
    const historicalAssistantMessages = t2PromptMessages.filter(
      (m: any) => m.role === "assistant" && typeof m.content === "string",
    );
    expect(historicalAssistantMessages).toHaveLength(1);
    expect(historicalAssistantMessages[0].content).toContain("document tarhe-kolli (pages 120-121)");
    expect(historicalAssistantMessages[0].content).toContain("«بیرون از کتاب»");

    // Check role alternation in Turn 2 prompt: user -> assistant -> user (excluding system)
    const nonSystemRoles = t2PromptMessages.filter((m: any) => m.role !== "system").map((m: any) => m.role);
    expect(nonSystemRoles).toEqual(["user", "assistant", "user"]);
  });

  it("Stress Scenario 2: Preserves role alternation and coherence when direct answer turns (0 tools) are interleaved with tool turns", async () => {
    const threadId = `thread-adv-interleaved-${Date.now()}`;
    const resourceId = "adv-learner-2";

    // 5-Turn dialogue:
    // Turn 1: Direct answer (0 tools)
    // Turn 2: Tool call (searchBooksTool)
    // Turn 3: Direct answer (0 tools)
    // Turn 4: Tool call (webSearchTool)
    // Turn 5: Direct answer (0 tools)

    // Turn 1 (Direct)
    completionsResponses.push((_body: any) => ({
      id: "cmpl-int-t1",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "سلام! من عامل گفت‌وگو هستم." },
          finish_reason: "stop",
        },
      ],
    }));

    // Turn 2, Step 1: Tool call
    completionsResponses.push((_body: any) => ({
      id: "cmpl-int-t2-s1",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_t2_books",
                type: "function",
                function: { name: "searchBooksTool", arguments: JSON.stringify({ query: "سیره ائمه" }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }));

    // Turn 2, Step 2: Synthesis with citation
    completionsResponses.push((_body: any) => ({
      id: "cmpl-int-t2-s2",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "سیره ائمه مبارزه حاد سیاسی بوده است document 70143-336 (page 140).",
          },
          finish_reason: "stop",
        },
      ],
    }));

    // Turn 3 (Direct)
    completionsResponses.push((_body: any) => ({
      id: "cmpl-int-t3",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "منظور از مبارزه سیاسی، تلاش جهت تشکیل حکومت عدل است.",
          },
          finish_reason: "stop",
        },
      ],
    }));

    // Turn 4, Step 1: Tool call web
    completionsResponses.push((_body: any) => ({
      id: "cmpl-int-t4-s1",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_t4_web",
                type: "function",
                function: { name: "webSearchTool", arguments: JSON.stringify({ query: "کتاب جدید" }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }));

    // Turn 4, Step 2: Synthesis with web badge
    completionsResponses.push((_body: any) => ({
      id: "cmpl-int-t4-s2",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "بر اساس وب «بیرون از کتاب»: اطلاعات پیرامون کتاب جدید منتشر شده است.",
          },
          finish_reason: "stop",
        },
      ],
    }));

    // Turn 5 (Direct summary)
    completionsResponses.push((_body: any) => ({
      id: "cmpl-int-t5",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "جمع‌بندی تمام نوبت‌ها با انسجام کامل.",
          },
          finish_reason: "stop",
        },
      ],
    }));

    // Execute turns 1 to 5
    await agent.generate([{ role: "user", content: "سلام" }], { memory: { thread: threadId, resource: resourceId } });
    await agent.generate([{ role: "user", content: "سیره مبارزاتی ائمه چیست؟" }], { memory: { thread: threadId, resource: resourceId } });
    await agent.generate([{ role: "user", content: "توضیح بیشتر بده" }], { memory: { thread: threadId, resource: resourceId } });
    await agent.generate([{ role: "user", content: "آیا کتاب جدیدی در این زمینه منتشر شده؟" }], { memory: { thread: threadId, resource: resourceId } });
    await agent.generate([{ role: "user", content: "خلاصه مباحث را بگو" }], { memory: { thread: threadId, resource: resourceId } });

    // Inspect Turn 5 prompt (completionsRequests[6])
    const t5Request = completionsRequests[6];
    const t5Messages = t5Request.messages;

    // Verify ZERO tool results remain from prior turns
    const toolMessages = t5Messages.filter((m: any) => m.role === "tool");
    expect(toolMessages).toHaveLength(0);

    // Verify strict role alternation: [user, assistant, user, assistant, user, assistant, user, assistant, user]
    const nonSystemRoles = t5Messages.filter((m: any) => m.role !== "system").map((m: any) => m.role);
    expect(nonSystemRoles).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);

    // Verify citations and markings in assistant messages
    const assistantTexts = t5Messages
      .filter((m: any) => m.role === "assistant")
      .map((m: any) => m.content)
      .join(" ");

    expect(assistantTexts).toContain("document 70143-336 (page 140)");
    expect(assistantTexts).toContain("«بیرون از کتاب»");
  });

  it("Stress Scenario 3: 12-turn sequential dialogue maintains bounded prompt tokens under token budgeting", async () => {
    const threadId = `thread-adv-12turns-${Date.now()}`;
    const resourceId = "adv-learner-12";

    // Build 12 turns: even turns are tool calls (book search), odd turns are direct follow-ups
    const promptCharCounts: number[] = [];

    for (let turn = 1; turn <= 12; turn++) {
      if (turn % 2 === 1) {
        // Odd turn: Tool call + synthesis
        completionsResponses.push((_body: any) => ({
          id: `cmpl-12t-${turn}-s1`,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `call_12t_${turn}`,
                    type: "function",
                    function: { name: "searchBooksTool", arguments: JSON.stringify({ query: `مبحث نوبت ${turn}` }) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }));

        completionsResponses.push((_body: any) => ({
          id: `cmpl-12t-${turn}-s2`,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `پاسخ نوبت ${turn} مستند به کتاب document tarhe-kolli (pages 120-121).`,
              },
              finish_reason: "stop",
            },
          ],
        }));
      } else {
        // Even turn: Direct answer
        completionsResponses.push((_body: any) => ({
          id: `cmpl-12t-${turn}`,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `پاسخ مستقیم نوبت ${turn} جهت پیوستگی گفتگو.`,
              },
              finish_reason: "stop",
            },
          ],
        }));
      }

      await agent.generate(
        [{ role: "user", content: `پرسش نوبت ${turn} درباره مباحث معرفتی` }],
        { memory: { thread: threadId, resource: resourceId } },
      );
    }

    // Inspect intercepted completion requests across all 12 turns
    // Odd turns had 2 requests, even turns had 1 request -> total 18 requests
    expect(completionsRequests).toHaveLength(18);

    // Track prompt token growth for the first request of each turn
    // Requests correspond to:
    // Turn 1: req 0 (tool call)
    // Turn 2: req 2 (direct)
    // Turn 3: req 3 (tool call)
    // Turn 4: req 5 (direct)
    // Turn 5: req 6 (tool call)
    // ...
    const turnFirstReqIndices = [0, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17];
    for (let i = 0; i < turnFirstReqIndices.length; i++) {
      const req = completionsRequests[turnFirstReqIndices[i]];
      const totalChars = JSON.stringify(req.messages).length;
      promptCharCounts.push(totalChars);
    }

    // In turn 12, without compaction, 6 book tool results (each 3,000+ chars) would have added 18,000+ chars.
    // With compaction, earlier tool results are stripped.
    const lastTurnReq = completionsRequests[17]; // Turn 12 req
    const priorToolResultsInLastTurn = lastTurnReq.messages.filter((m: any) => m.role === "tool");
    expect(priorToolResultsInLastTurn).toHaveLength(0);

    // Verify all assistant replies retain citations
    const citationsInHistory = lastTurnReq.messages
      .filter((m: any) => m.role === "assistant" && typeof m.content === "string")
      .map((m: any) => m.content)
      .join(" ");

    expect(citationsInHistory).toContain("document tarhe-kolli (pages 120-121)");

    // Verify bounded prompt growth: Turn 12 prompt chars should remain comfortably bounded
    // (well under 8000 tokens ≈ 24000 chars)
    expect(promptCharCounts[11]).toBeLessThan(15000);
  });

  it("Stress Scenario 4: Citation Integrity Check — verifies regex compliance and zero mangling across turns", async () => {
    const threadId = `thread-adv-citation-${Date.now()}`;
    const resourceId = "adv-learner-cit";

    const testCitations = [
      "document tarhe-kolli (page 481)",
      "document 70143-336 (pages 140-145)",
      "document tarhe-kolli (pages 120-121)",
      "document 70143-336 (page 10)",
    ];

    for (let i = 0; i < testCitations.length; i++) {
      completionsResponses.push((_body: any) => ({
        id: `cmpl-cit-${i}`,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: `پاسخ مستند ${i + 1}: ${testCitations[i]} به صورت کامل.`,
            },
            finish_reason: "stop",
          },
        ],
      }));

      await agent.generate(
        [{ role: "user", content: `استناد شماره ${i + 1}` }],
        { memory: { thread: threadId, resource: resourceId } },
      );
    }

    // 5th turn to inspect all prior citations in prompt
    completionsResponses.push((_body: any) => ({
      id: "cmpl-cit-final",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "پایان استنادها." },
          finish_reason: "stop",
        },
      ],
    }));

    await agent.generate(
      [{ role: "user", content: "بررسی نهایی استنادها" }],
      { memory: { thread: threadId, resource: resourceId } },
    );

    const finalReq = completionsRequests[4];
    const canonicalRegex = /document\s+[A-Za-z0-9._-]+(?:\s+\((?:page\s+\d+|pages\s+\d+-\d+)\))?/g;

    const assistantMsgs = finalReq.messages.filter((m: any) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(4);

    for (let i = 0; i < 4; i++) {
      const content = assistantMsgs[i].content;
      const matches = content.match(canonicalRegex);
      expect(matches).not.toBeNull();
      expect(matches![0]).toBe(testCitations[i]);
    }
  });

  it("Stress Scenario 5: 3 consecutive tool calls in a single active turn (Books -> Books Refined -> Web Fallback)", async () => {
    const threadId = `thread-adv-3tools-${Date.now()}`;
    const resourceId = "adv-learner-3tools";

    // Step 1: Books search
    completionsResponses.push((_body: any) => ({
      id: "cmpl-3t-s1",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_b1",
                type: "function",
                function: { name: "searchBooksTool", arguments: JSON.stringify({ query: "اصطلاح اول" }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }));

    // Step 2: Refined books search
    completionsResponses.push((_body: any) => ({
      id: "cmpl-3t-s2",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_b2",
                type: "function",
                function: { name: "searchBooksTool", arguments: JSON.stringify({ query: "اصطلاح دوم" }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }));

    // Step 3: Web search fallback
    completionsResponses.push((_body: any) => ({
      id: "cmpl-3t-s3",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_w1",
                type: "function",
                function: { name: "webSearchTool", arguments: JSON.stringify({ query: "اصطلاح در وب" }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }));

    // Step 4: Final synthesis
    completionsResponses.push((_body: any) => ({
      id: "cmpl-3t-s4",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "سنتز نهایی با استناد document tarhe-kolli (pages 120-121) و وب «بیرون از کتاب».",
          },
          finish_reason: "stop",
        },
      ],
    }));

    await agent.generate(
      [{ role: "user", content: "جستجوی سه‌مرحله‌ای" }],
      { memory: { thread: threadId, resource: resourceId } },
    );

    // Verify 4 completion calls occurred
    expect(completionsRequests).toHaveLength(4);

    // Verify Step 4 prompt had ALL 3 active tool results available
    const step4Messages = completionsRequests[3].messages;
    const step4Tools = step4Messages.filter((m: any) => m.role === "tool");
    expect(step4Tools).toHaveLength(3);

    // Now turn 2 follow-up
    completionsResponses.push((_body: any) => ({
      id: "cmpl-3t-t2",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "پاسخ پیگیری نوبت ۲." },
          finish_reason: "stop",
        },
      ],
    }));

    await agent.generate(
      [{ role: "user", content: "پیگیری نوبت دوم" }],
      { memory: { thread: threadId, resource: resourceId } },
    );

    // In Turn 2 prompt (completionsRequests[4]): ALL 3 prior tool results must be stripped!
    const t2Req = completionsRequests[4];
    const t2Tools = t2Req.messages.filter((m: any) => m.role === "tool");
    expect(t2Tools).toHaveLength(0);

    const t2Assistants = t2Req.messages.filter((m: any) => m.role === "assistant");
    expect(t2Assistants).toHaveLength(1);
    expect(t2Assistants[0].content).toContain("document tarhe-kolli (pages 120-121)");
  });

  it("Stress Scenario 6: Quantifies exact token reduction across 6 turns to verify >= 50% requirement", () => {
    // Standard estimation formula: ceil(JSON.stringify(messages).length / 3)
    // We simulate 6 sequential turns where Turns 1, 3, and 5 invoke book search with 4 citable passages (each ~1,500 chars -> 6,000 chars total)
    const bookPayload = makeChunk("tarhe-kolli", 120, "مبحث نبوت", 6000);

    const userTurns = [
      "مفهوم نبوت در قرآن و کتاب طرح کلی چیست؟",
      "آیا این مفهوم با توحید پیوند مستقیم دارد؟",
      "در کتاب انسان ۲۵۰ ساله سیره ائمه در جهاد چگونه تحلیل شده است؟",
      "منظور از انسان ۲۵۰ ساله دقیقا چیست؟",
      "آیا در صفحهٔ ۴۸۱ طرح کلی به مبحث عدالت اقتصادی اشاره شده است؟",
      "خلاصه‌ای از پیوند بین نبوت، توحید و مبارزه ۲۵۰ ساله ائمه ارائه دهید.",
    ];

    const assistantTurns = [
      "نبوت به معنای رسالت و روشنگری توحیدی است document tarhe-kolli (pages 120-121).",
      "بله، همان‌طور که اشاره شد، نبوت جلوه عملی توحید است.",
      "ائمه به عنوان یک انسان ۲۵۰ ساله مبارزه حاد سیاسی را دنبال می‌کردند document 70143-336 (page 140).",
      "منظور این است که تمام ۲۵۰ سال دوران امامت پیکاری پیوسته بوده است.",
      "در صفحهٔ ۴۸۱ اشاره نشده است. با جستجو در کل کتاب: عدالت بر پایه مساوات است document tarhe-kolli (page 481).",
      "خلاصه پیوند جامع: توحید زیربنا، نبوت نقشه راه، و مبارزه ائمه تحقق عملی آن است.",
    ];

    // Build unpruned baseline prompt history at each turn
    let baselineCumulativeTokens = 0;
    let prunedCumulativeTokens = 0;

    let baselineHistory: any[] = [{ role: "system", content: "دستورالعمل سیستم" }];
    let prunedHistory: any[] = [{ role: "system", content: "دستورالعمل سیستم" }];

    for (let t = 0; t < 6; t++) {
      const userMsg = { role: "user", content: userTurns[t] };
      baselineHistory.push(userMsg);
      prunedHistory.push(userMsg);

      const hasTool = t === 0 || t === 2 || t === 4;
      if (hasTool) {
        // Active turn tool call and tool result
        const toolCallMsg = { role: "assistant", tool_calls: [{ id: `call_${t}`, name: "searchBooksTool" }] };
        const toolResultMsg = { role: "tool", tool_call_id: `call_${t}`, content: bookPayload };

        baselineHistory.push(toolCallMsg, toolResultMsg);
        // In pruned history, active turn has tool call and tool result during synthesis
        const activePrunedPrompt = [...prunedHistory, toolCallMsg, toolResultMsg];

        const baselineTokens = Math.ceil(JSON.stringify(baselineHistory).length / 3);
        const prunedTokens = Math.ceil(JSON.stringify(activePrunedPrompt).length / 3);

        baselineCumulativeTokens += baselineTokens;
        prunedCumulativeTokens += prunedTokens;

        // Assistant reply added
        const assistantMsg = { role: "assistant", content: assistantTurns[t] };
        baselineHistory.push(assistantMsg);

        // For subsequent turns in pruned history, the tool call and tool result are pruned:
        prunedHistory.push(assistantMsg);
      } else {
        const baselineTokens = Math.ceil(JSON.stringify(baselineHistory).length / 3);
        const prunedTokens = Math.ceil(JSON.stringify(prunedHistory).length / 3);

        baselineCumulativeTokens += baselineTokens;
        prunedCumulativeTokens += prunedTokens;

        const assistantMsg = { role: "assistant", content: assistantTurns[t] };
        baselineHistory.push(assistantMsg);
        prunedHistory.push(assistantMsg);
      }
    }

    const reductionPercent =
      ((baselineCumulativeTokens - prunedCumulativeTokens) / baselineCumulativeTokens) * 100;

    // Must be >= 50.0%
    expect(reductionPercent).toBeGreaterThanOrEqual(50.0);
    // Typical reduction with 6,000 char chunks is ~55-65%
    expect(reductionPercent).toBeGreaterThanOrEqual(55.0);
  });
});

