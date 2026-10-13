import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { RequestContext } from "@mastra/core/request-context";
import {
  buildPageContextDirectives,
  buildSelectionDirectives,
  chatAgent,
  getRequestContextValue,
  type PageContext,
  type SelectionContext,
} from "./chat-agent";

describe("buildPageContextDirectives", () => {
  it("returns empty string when pageContext is null, undefined, or empty", () => {
    expect(buildPageContextDirectives(null)).toBe("");
    expect(buildPageContextDirectives(undefined)).toBe("");
    expect(buildPageContextDirectives({ page: 1, text: "" })).toBe("");
  });

  it("formats active page text, book name, and canonical citation rule", () => {
    const pageContext: PageContext = {
      book: "tarhe-kolli",
      page: 481,
      text: "این متن اصلی صفحه ۴۸۱ است.",
    };
    const directives = buildPageContextDirectives(pageContext);
    expect(directives).toContain("tarhe-kolli");
    expect(directives).toContain("481");
    expect(directives).toContain("این متن اصلی صفحه ۴۸۱ است.");
    expect(directives).toContain("document tarhe-kolli (page 481)");
  });

  it("includes boundary context from previous and next pages when present", () => {
    const pageContext: PageContext = {
      book: "tarhe-kolli",
      page: 2,
      text: "متن صفحه دو",
      prev_page: 1,
      prev_paragraph: "پایان صفحه یک",
      next_page: 3,
      next_paragraph: "آغاز صفحه سه",
    };
    const directives = buildPageContextDirectives(pageContext);
    expect(directives).toContain("پایان صفحه یک");
    expect(directives).toContain("صفحهٔ قبل");
    expect(directives).toContain("آغاز صفحه سه");
    expect(directives).toContain("صفحهٔ بعد");
  });

  it("uses یادگیرنده and strictly avoids the forbidden term کاربر", () => {
    const pageContext: PageContext = {
      book: "tarhe-kolli",
      page: 10,
      text: "متن صفحه ده",
    };
    const directives = buildPageContextDirectives(pageContext);
    expect(directives).toContain("یادگیرنده");
    expect(directives).not.toContain("کاربر");
  });

  it("normalizes string page numbers when calculating fallback previous and next page numbers", () => {
    const pageContext: PageContext = {
      book: "tarhe-kolli",
      page: "481",
      text: "متن صفحه ۴۸۱",
      prev_paragraph: "پایان صفحه ۴۸۰",
      next_paragraph: "آغاز صفحه ۴۸۲",
    };
    const directives = buildPageContextDirectives(pageContext);
    expect(directives).toContain("صفحهٔ قبل (480)");
    expect(directives).toContain("صفحهٔ بعد (482)");
  });

  it("formats multi-page interval when last_page is present and > page", () => {
    const pageContext: PageContext = {
      book: "tarhe-kolli",
      page: 80,
      last_page: 82,
      pages: [80, 81, 82],
      text: "متن صفحات ۸۰ تا ۸۲",
      prev_paragraph: "پایان صفحه ۷۹",
      next_paragraph: "آغاز صفحه ۸۳",
    };
    const directives = buildPageContextDirectives(pageContext);
    expect(directives).toContain("صفحات فعلی: 80 تا 82");
    expect(directives).toContain("document tarhe-kolli (pages 80-82)");
    expect(directives).toContain("متن صفحات ۸۰ تا ۸۲");
    expect(directives).toContain("صفحهٔ قبل (79)");
    expect(directives).toContain("صفحهٔ بعد (83)");
  });
});

describe("buildSelectionDirectives", () => {
  it("returns empty string when selectionContext is null, undefined, or empty", () => {
    expect(buildSelectionDirectives(null)).toBe("");
    expect(buildSelectionDirectives(undefined)).toBe("");
    expect(buildSelectionDirectives("")).toBe("");
    expect(buildSelectionDirectives("   ")).toBe("");
    expect(buildSelectionDirectives({ text: "" })).toBe("");
    expect(buildSelectionDirectives({ text: "   " })).toBe("");
  });

  it("formats selection text, book name, and canonical citation rule", () => {
    const selectionContext: SelectionContext = {
      book: "tarhe-kolli",
      page: 481,
      text: "توحید در ایدئولوژی اسلامی به معنای نفی طبقات و تبعیض‌هاست.",
    };
    const directives = buildSelectionDirectives(selectionContext);
    expect(directives).toContain("tarhe-kolli");
    expect(directives).toContain("481");
    expect(directives).toContain("توحید در ایدئولوژی اسلامی به معنای نفی طبقات و تبعیض‌هاست.");
    expect(directives).toContain("document tarhe-kolli (page 481)");
  });

  it("handles string selection input gracefully", () => {
    const directives = buildSelectionDirectives("متن کوتاه منتخب");
    expect(directives).toContain("متن کوتاه منتخب");
    expect(directives).toContain("بافت فراز منتخب");
  });

  it("uses یادگیرنده and strictly avoids the forbidden term کاربر", () => {
    const selectionContext: SelectionContext = {
      book: "tarhe-kolli",
      page: 10,
      text: "متن منتخب",
    };
    const directives = buildSelectionDirectives(selectionContext);
    expect(directives).toContain("یادگیرنده");
    expect(directives).not.toContain("کاربر");
  });

  it("strictly specifies closed-passage reading comprehension focusing on verbatim wording", () => {
    const selectionContext: SelectionContext = {
      book: "tarhe-kolli",
      page: 10,
      text: "متن منتخب برای درک مطلب",
    };
    const directives = buildSelectionDirectives(selectionContext);
    expect(directives).toMatch(/درک مطلب (?:متن‌بسته|بسته)|closed-passage/i);
    expect(directives).toMatch(/واژگان عینی|verbatim/i);
  });

  it("strictly specifies zero tool calls without whole-book search unless external definitions needed", () => {
    const selectionContext: SelectionContext = {
      book: "tarhe-kolli",
      page: 10,
      text: "متن منتخب",
    };
    const directives = buildSelectionDirectives(selectionContext);
    expect(directives).toMatch(/(?:۰|0)\s*فراخوانی ابزار|بدون (?:هیچ‌گونه )?فراخوانی ابزار/);
    expect(directives).toMatch(/search_books/);
  });

  it("formats citation with active page number when selectionContext has no page but active page is provided", () => {
    const directives = buildSelectionDirectives("متن کوتاه منتخب", 481, "tarhe-kolli");
    expect(directives).toContain("document tarhe-kolli (page 481)");
    expect(directives).toContain("صفحه: 481");
  });

  it("formats citation with active page number when pageContext object is passed as fallback", () => {
    const pageCtx: PageContext = { book: "tarhe-kolli", page: 481, text: "متن صفحه" };
    const directives = buildSelectionDirectives({ text: "متن کوتاه منتخب" }, pageCtx);
    expect(directives).toContain("document tarhe-kolli (page 481)");
  });

  it("formats canonical citation placeholder document <book> (page <N>) when page is completely missing", () => {
    const directives = buildSelectionDirectives("متن کوتاه منتخب");
    expect(directives).toContain("document کتاب (page <N>)");
  });

  it("explicitly states in selection directives that closed-passage comprehension takes precedence over whole-page or book search", () => {
    const selectionContext: SelectionContext = {
      book: "tarhe-kolli",
      page: 10,
      text: "متن منتخب",
    };
    const directives = buildSelectionDirectives(selectionContext);
    expect(directives).toMatch(/(?:اولویت|تقدم).*درک مطلب|precedence/i);
    expect(directives).toMatch(/کل صفحه|کل کتاب/);
  });
});

describe("getRequestContextValue", () => {
  it("reads values from Map or RequestContext with get()", () => {
    const map = new Map();
    map.set("foo", "bar");
    expect(getRequestContextValue(map, "foo")).toBe("bar");
    expect(getRequestContextValue(map, "missing")).toBeUndefined();
  });

  it("reads values from plain object", () => {
    const obj = { foo: 123 };
    expect(getRequestContextValue(obj, "foo")).toBe(123);
    expect(getRequestContextValue(obj, "missing")).toBeUndefined();
  });

  it("returns undefined for null, undefined, or primitive context", () => {
    expect(getRequestContextValue(null, "foo")).toBeUndefined();
    expect(getRequestContextValue(undefined, "foo")).toBeUndefined();
    expect(getRequestContextValue("string", "foo")).toBeUndefined();
  });
});

describe("chatAgent dynamic instructions", () => {
  it("injects pageContext into instructions when provided via Map requestContext", async () => {
    const map = new Map();
    map.set("pageContext", {
      book: "tarhe-kolli",
      page: 50,
      text: "متن صفحه پنجاه",
    });
    const instructions = await chatAgent.getInstructions({
      requestContext: map as any,
    });
    expect(instructions).toContain("tarhe-kolli");
    expect(instructions).toContain("50");
    expect(instructions).toContain("متن صفحه پنجاه");
    expect(instructions).toContain("document tarhe-kolli (page 50)");
  });

  it("injects pageContext into instructions when provided via plain object requestContext", async () => {
    const plainObj = {
      pageContext: {
        book: "tarhe-kolli",
        page: 50,
        text: "متن صفحه پنجاه",
      },
    };
    const instructions = await chatAgent.getInstructions({
      requestContext: plainObj as any,
    });
    expect(instructions).toContain("tarhe-kolli");
    expect(instructions).toContain("50");
    expect(instructions).toContain("متن صفحه پنجاه");
  });

  it("omits page context section when pageContext is not provided", async () => {
    const instructions = await chatAgent.getInstructions({
      requestContext: new Map() as any,
    });
    expect(instructions).not.toContain("Active Page Context");
    expect(instructions).not.toContain("بافت صفحهٔ فعال");
  });

  it("clarifies in instructions that active page context covers questions directly before calling search_books", async () => {
    const instructions = await chatAgent.getInstructions({
      requestContext: new Map() as any,
    });
    expect(instructions).toMatch(
      /active page context.*answer directly.*without executing search tools.*search_books/is,
    );
  });

  it("injects selectionContext into instructions when provided via Map requestContext", async () => {
    const map = new Map();
    map.set("selectionText", {
      book: "tarhe-kolli",
      page: 50,
      text: "فراز منتخب در صفحه پنجاه",
    });
    const instructions = await chatAgent.getInstructions({
      requestContext: map as any,
    });
    expect(instructions).toContain("tarhe-kolli");
    expect(instructions).toContain("50");
    expect(instructions).toContain("فراز منتخب در صفحه پنجاه");
    expect(instructions).toContain("document tarhe-kolli (page 50)");
  });

  it("injects selectionContext into instructions when provided via plain object requestContext", async () => {
    const plainObj = {
      selectionText: {
        book: "tarhe-kolli",
        page: 50,
        text: "فراز منتخب در صفحه پنجاه",
      },
    };
    const instructions = await chatAgent.getInstructions({
      requestContext: plainObj as any,
    });
    expect(instructions).toContain("tarhe-kolli");
    expect(instructions).toContain("50");
    expect(instructions).toContain("فراز منتخب در صفحه پنجاه");
  });

  it("combines pageContext and selectionText directives when both are present", async () => {
    const plainObj = {
      pageContext: {
        book: "tarhe-kolli",
        page: 50,
        text: "متن کامل صفحه پنجاه",
      },
      selectionText: {
        book: "tarhe-kolli",
        page: 50,
        text: "بخش مشخص شده از صفحه پنجاه",
      },
    };
    const instructions = await chatAgent.getInstructions({
      requestContext: plainObj as any,
    });
    expect(instructions).toContain("متن کامل صفحه پنجاه");
    expect(instructions).toContain("بخش مشخص شده از صفحه پنجاه");
  });

  it("omits selection context section when selectionText is not provided", async () => {
    const instructions = await chatAgent.getInstructions({
      requestContext: new Map() as any,
    });
    expect(instructions).not.toContain("Selected Passage Context");
    expect(instructions).not.toContain("بافت فراز منتخب");
  });

  it("places selection directives before page context directives to guarantee Tier 1 precedence", async () => {
    const plainObj = {
      pageContext: {
        book: "tarhe-kolli",
        page: 50,
        text: "متن کامل صفحه پنجاه",
      },
      selectionText: {
        book: "tarhe-kolli",
        page: 50,
        text: "بخش مشخص شده از صفحه پنجاه",
      },
    };
    const instructions = await chatAgent.getInstructions({
      requestContext: plainObj as any,
    });
    const selIdx = instructions.indexOf("بافت فراز منتخب");
    const pageIdx = instructions.indexOf("بافت صفحهٔ فعال");
    expect(selIdx).toBeGreaterThan(-1);
    expect(pageIdx).toBeGreaterThan(-1);
    expect(selIdx).toBeLessThan(pageIdx);
  });

  it("structures base instructions with 4 clean tiers for selection, page, book, and web", async () => {
    const instructions = await chatAgent.getInstructions({
      requestContext: new Map() as any,
    });
    expect(instructions).toMatch(/Tier 1.*selected passage context/is);
    expect(instructions).toMatch(/Tier 2.*active page context/is);
    expect(instructions).toMatch(/Tier 3.*search_books/is);
    expect(instructions).toMatch(/Tier 4.*web_search/is);
    expect(instructions).toContain("«بیرون از کتاب»");
  });
});

describe("Ticket 02 - Tier 2 Directives Specification", () => {
  const pageContext: PageContext = {
    book: "tarhe-kolli",
    page: 481,
    text: "متن صفحه ۴۸۱ دربارهٔ توحید در جهان‌بینی اسلامی.",
  };

  it("strictly specifies direct answers with zero tool calls for page-covered queries", () => {
    const directives = buildPageContextDirectives(pageContext);
    expect(directives).toMatch(/(?:۰|0)\s*فراخوانی ابزار|بدون (?:هیچ‌گونه )?فراخوانی ابزار/);
  });

  it("strictly specifies canonical citations document <book> (page <N>)", () => {
    const directives = buildPageContextDirectives(pageContext);
    expect(directives).toContain("document tarhe-kolli (page 481)");
  });

  it("strictly specifies polite boundary acknowledgment when question is not covered on page N", () => {
    const directives = buildPageContextDirectives(pageContext);
    expect(directives).toMatch(/صفحهٔ\s*481.*پرداخته نشده است/);
  });

  it("strictly specifies automatic tool escalation to search_books following boundary acknowledgment", () => {
    const directives = buildPageContextDirectives(pageContext);
    expect(directives).toMatch(/search_books/);
    expect(directives).toMatch(/ارتقا|گسترش|جستجو در کل کتاب|مجموعهٔ کتاب/);
  });

  it("strictly specifies fallback to web_search with «بیرون از کتاب» if neither page nor books cover the question", () => {
    const directives = buildPageContextDirectives(pageContext);
    expect(directives).toContain("web_search");
    expect(directives).toContain("«بیرون از کتاب»");
  });

  it("clarifies boundary page and range citation format document <book> (page <N>) or (pages <N>-<M>)", () => {
    const directives = buildPageContextDirectives(pageContext);
    expect(directives).toMatch(/document\s+.*\(pages?\s+.*\)/);
    expect(directives).toMatch(/\(pages\s+.*-.*\)/);
  });

  it("clarifies acknowledging page boundary in answer before providing expanded answer", () => {
    const directives = buildPageContextDirectives(pageContext);
    expect(directives).toMatch(/پیش از ارائهٔ پاسخ|قبل از ارائه/);
  });

  it("clarifies boundary range citations and acknowledgment before expanded answer in base instructions", async () => {
    const instructions = await chatAgent.getInstructions({
      requestContext: new Map() as any,
    });
    expect(instructions).toMatch(/document <book> \(pages <N>-<M>\)/);
    expect(instructions).toMatch(/before providing the expanded answer/);
  });
});

describe("Ticket 02 - Chat Agent Behavior", () => {
  let server: Server;
  let serverUrl: string;
  let completionsRequests: any[] = [];
  let completionsResponses: any[] = [];
  let recallRequests: any[] = [];
  let searchRequests: any[] = [];

  let agent: any;

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
            send(500, { error: "No mock response configured" });
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
                passage: "اصل نبوت و رسالت در قرآن.",
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
                title: "منبع وب",
                url: "https://example.ir/article",
                snippet: "اطلاعات جاری",
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
    process.env.AVALAI_API_KEY = "test-key";

    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "mastra-chat-agent-test-"));
    process.env.MASTRA_STORAGE_URL = `file:${join(tmp, "mastra.sqlite")}`;
    const { mastra } = await import("../index");
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

  it("answers direct page questions directly with zero tool calls and canonical citations", async () => {
    completionsResponses.push((_body: any) => ({
      id: "chatcmpl-page-direct",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "test-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "توحید در این صفحه به معنای یگانگی پروردگار در تدبیر عالم است document tarhe-kolli (page 481).",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));

    const requestContext = new RequestContext();
    requestContext.set("pageContext", {
      book: "tarhe-kolli",
      page: 481,
      text: "متن صفحه ۴۸۱ دربارهٔ توحید در جهان‌بینی اسلامی.",
    });

    const result = await agent.generate(
      [{ role: "user", content: "توحید در این صفحه چه معنایی دارد؟" }],
      {
        requestContext: requestContext as any,
        memory: { thread: "thread-direct", resource: "learner-test" },
      },
    );

    expect(result.text).toContain("document tarhe-kolli (page 481)");
    const toolResults = (result as any).toolResults ?? [];
    expect(toolResults).toHaveLength(0);
    expect(recallRequests).toHaveLength(0);
    expect(searchRequests).toHaveLength(0);

    // Verify injected directives were in the prompt received by the model
    const systemMessage = completionsRequests[0].messages.find(
      (m: any) => m.role === "system",
    );
    expect(systemMessage?.content).toContain("document tarhe-kolli (page 481)");
    expect(systemMessage?.content).toContain("متن صفحه ۴۸۱");
  });

  it("acknowledges page boundary and triggers search_books escalation on out-of-scope question", async () => {
    // Turn 1: model acknowledges page boundary and triggers searchBooksTool
    completionsResponses.push((_body: any) => ({
      id: "chatcmpl-turn-1",
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
                id: "call_books_1",
                type: "function",
                function: {
                  name: "searchBooksTool",
                  arguments: JSON.stringify({ query: "نبوت در قرآن" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));

    // Turn 2: model outputs the boundary acknowledgment and answers from the book passage
    completionsResponses.push((_body: any) => ({
      id: "chatcmpl-turn-2",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "test-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "در صفحهٔ ۴۸۱ کتاب tarhe-kolli به موضوع نبوت پرداخته نشده است. با جستجو در کل کتاب: اصل نبوت و رسالت در قرآن مطرح است document tarhe-kolli (pages 120-121).",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
    }));

    const requestContext = new RequestContext();
    requestContext.set("pageContext", {
      book: "tarhe-kolli",
      page: 481,
      text: "متن صفحه ۴۸۱ دربارهٔ توحید در جهان‌بینی اسلامی.",
    });

    const result = await agent.generate(
      [{ role: "user", content: "مفهوم نبوت چیست؟" }],
      {
        requestContext: requestContext as any,
        memory: { thread: "thread-books", resource: "learner-test" },
      },
    );

    expect(result.text).toContain("صفحهٔ ۴۸۱");
    expect(result.text).toContain("document tarhe-kolli (pages 120-121)");
    expect(recallRequests).toHaveLength(1);
    const bookTools = ((result as any).toolResults ?? []).filter(
      (r: any) => r?.payload?.toolName === "searchBooksTool",
    );
    expect(bookTools).toHaveLength(1);
  });

  it("falls back to web_search with «بیرون از کتاب» if neither page nor book set covers question", async () => {
    // Turn 1: model acknowledges page boundary and triggers searchBooksTool
    completionsResponses.push((_body: any) => ({
      id: "chatcmpl-turn-web-1",
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
                id: "call_books_2",
                type: "function",
                function: {
                  name: "searchBooksTool",
                  arguments: JSON.stringify({ query: "رویداد روز" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }));

    // Turn 2: model sees searchBooks returned nothing relevant, calls webSearchTool
    completionsResponses.push((_body: any) => ({
      id: "chatcmpl-turn-web-2",
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
                id: "call_web_2",
                type: "function",
                function: {
                  name: "webSearchTool",
                  arguments: JSON.stringify({ query: "رویداد روز", maxResults: 3 }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }));

    // Turn 3: model finalizes answer with «بیرون از کتاب»
    completionsResponses.push((_body: any) => ({
      id: "chatcmpl-turn-web-3",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "test-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "در صفحهٔ ۴۸۱ و متن کتاب‌ها مطلبی دربارهٔ این موضوع نیست. طبق گزارش وب: اطلاعات جاری «بیرون از کتاب» https://example.ir/article",
          },
          finish_reason: "stop",
        },
      ],
    }));

    const requestContext = new RequestContext();
    requestContext.set("pageContext", {
      book: "tarhe-kolli",
      page: 481,
      text: "متن صفحه ۴۸۱ دربارهٔ توحید در جهان‌بینی اسلامی.",
    });

    const result = await agent.generate(
      [{ role: "user", content: "یک رویداد جدید بگو" }],
      {
        requestContext: requestContext as any,
        memory: { thread: "thread-web", resource: "learner-test" },
      },
    );

    expect(result.text).toContain("«بیرون از کتاب»");
    expect(searchRequests).toHaveLength(1);
    const webTools = ((result as any).toolResults ?? []).filter(
      (r: any) => r?.payload?.toolName === "webSearchTool",
    );
    expect(webTools).toHaveLength(1);
  });
});

describe("Ticket 03 - Chat Agent Behavior with Selection Context", () => {
  let server: Server;
  let serverUrl: string;
  let completionsRequests: any[] = [];
  let completionsResponses: any[] = [];
  let recallRequests: any[] = [];
  let searchRequests: any[] = [];
  let agent: any;

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
            send(500, { error: "No mock response configured" });
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
                passage: "اصل نبوت و رسالت در قرآن.",
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
                title: "منبع وب",
                url: "https://example.ir/article",
                snippet: "اطلاعات جاری",
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
    process.env.AVALAI_API_KEY = "test-key";

    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "mastra-chat-agent-selection-test-"));
    process.env.MASTRA_STORAGE_URL = `file:${join(tmp, "mastra.sqlite")}`;
    const { mastra } = await import("../index");
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

  it("answers query specifically about selected passage with zero tool calls and canonical citations", async () => {
    completionsResponses.push((_body: any) => ({
      id: "chatcmpl-sel-direct",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "test-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "بر پایهٔ این فراز، توحید به معنای نفی هرگونه طاغوت و عبودیت غیر خداست document tarhe-kolli (page 481).",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));

    const requestContext = new RequestContext();
    requestContext.set("selectionText", {
      book: "tarhe-kolli",
      page: 481,
      text: "توحید به معنای نفی هرگونه طاغوت و عبودیت غیر خداست.",
    });

    const result = await agent.generate(
      [{ role: "user", content: "این فراز چه پیامی دارد؟" }],
      {
        requestContext: requestContext as any,
        memory: { thread: "thread-sel-direct", resource: "learner-test" },
      },
    );

    expect(result.text).toContain("document tarhe-kolli (page 481)");
    const toolResults = (result as any).toolResults ?? [];
    expect(toolResults).toHaveLength(0);
    expect(recallRequests).toHaveLength(0);
    expect(searchRequests).toHaveLength(0);

    const systemMessage = completionsRequests[0].messages.find(
      (m: any) => m.role === "system",
    );
    expect(systemMessage?.content).toContain("document tarhe-kolli (page 481)");
    expect(systemMessage?.content).toContain("توحید به معنای نفی هرگونه طاغوت");
  });

  it("invokes search_books when answering explicitly requires external definitions not in excerpt", async () => {
    completionsResponses.push((_body: any) => ({
      id: "chatcmpl-sel-turn-1",
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
                id: "call_books_ext",
                type: "function",
                function: {
                  name: "searchBooksTool",
                  arguments: JSON.stringify({ query: "تعریف اصطلاح طاغوت در قرآن" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));

    completionsResponses.push((_body: any) => ({
      id: "chatcmpl-sel-turn-2",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "test-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "در این فراز به واژهٔ طاغوت اشاره شده document tarhe-kolli (page 481)، و تعریف تفصیلی آن طبق کتاب: طاغوت قدرتی است که در برابر حق سرکشی کند document tarhe-kolli (pages 120-121).",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
    }));

    const requestContext = new RequestContext();
    requestContext.set("selectionText", {
      book: "tarhe-kolli",
      page: 481,
      text: "توحید به معنای نفی هرگونه طاغوت است.",
    });

    const result = await agent.generate(
      [{ role: "user", content: "تعریف واژه طاغوت در کل کتاب چیست؟" }],
      {
        requestContext: requestContext as any,
        memory: { thread: "thread-sel-ext", resource: "learner-test" },
      },
    );

    expect(result.text).toContain("document tarhe-kolli (page 481)");
    expect(result.text).toContain("document tarhe-kolli (pages 120-121)");
    expect(recallRequests).toHaveLength(1);
    const bookTools = ((result as any).toolResults ?? []).filter(
      (r: any) => r?.payload?.toolName === "searchBooksTool",
    );
    expect(bookTools).toHaveLength(1);
  });
});
