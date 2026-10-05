import { afterEach, describe, expect, it, vi } from "vitest";
import { searchBooksTool } from "./search-books";
import { webSearchTool } from "./web-search";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
process.env.AGENT_SERVICE_TOKEN = "test-token";
process.env.PYTHON_CORE_URL = "http://core.test";
process.env.AVALAI_API_KEY = "test-key";
process.env.AVALAI_BASE_URL = "http://avalai.test/v1";

afterEach(() => {
  fetchMock.mockReset();
});

type BookResult = { passages: Array<{ reference: string; passage: string }> };
type WebResult = { results: Array<{ title: string; url: string; snippet: string }> };

async function runBooks(input: { query: string; datasets?: string[] }): Promise<BookResult> {
  const result = await searchBooksTool.execute!(input, {} as never);
  if (!result || result instanceof Error) {
    throw new Error(`unexpected tool result: ${JSON.stringify(result)}`);
  }
  return result as BookResult;
}

async function runWeb(input: { query: string; maxResults: number }): Promise<WebResult> {
  const result = await webSearchTool.execute!(input, {} as never);
  if (!result || result instanceof Error) {
    throw new Error(`unexpected tool result: ${JSON.stringify(result)}`);
  }
  return result as WebResult;
}

describe("searchBooksTool", () => {
  it("calls the Python seam with the token and maps the passages", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          passages: [
            { reference: "document book-a (pages 12-13)", passage: "متن کتاب" },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await runBooks({ query: "علم از نظر قرآن" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://core.test/agent/recall");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Agent-Token"]).toBe("test-token");
    expect(JSON.parse(init.body)).toEqual({ query: "علم از نظر قرآن", datasets: undefined });
    expect(result.passages).toHaveLength(1);
    expect(result.passages[0].reference).toContain("pages 12-13");
  });

  it("contributes nothing when the seam is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connection refused"));
    const result = await runBooks({ query: "q" });
    expect(result.passages).toEqual([]);
  });

  it("contributes nothing on a non-200 reply", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    const result = await runBooks({ query: "q" });
    expect(result.passages).toEqual([]);
  });
});

describe("webSearchTool", () => {
  it("calls Avalai /v1/search with the tool name and bearer key", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            { title: "منبع", url: "https://example.ir/a", snippet: "خلاصه" },
            { title: "بدون url", snippet: "افت می‌شود" },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await runWeb({ query: "رویداد روز", maxResults: 5 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://avalai.test/v1/search");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body)).toEqual({
      query: "رویداد روز",
      max_results: 5,
      search_tool_name: "perplexity-search",
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe("https://example.ir/a");
  });

  it("contributes nothing when the search fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    const result = await runWeb({ query: "q", maxResults: 3 });
    expect(result.results).toEqual([]);
  });
});
