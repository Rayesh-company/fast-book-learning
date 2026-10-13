import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// Avalai's direct web-search endpoint (verified live 2026-10-04):
// POST /v1/search with {query, max_results, search_tool_name} →
// Perplexity-compatible {results: [{title, url, snippet}]}.
// Env is read at call time (the ui.ask._recall_url rule) so the
// tests' pins hold.

export const webSearchTool = createTool({
  id: "web-search",
  description:
    "جست‌وجوی اینترنت — بیرون از کتاب. For questions beyond the Book set: current events, general knowledge, anything the Books don't cover. Returns results with title, url, and snippet.",
  inputSchema: z.object({
    query: z.string().describe("The web search query"),
    maxResults: z.number().int().min(1).max(10).default(5),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        snippet: z.string(),
      }),
    ),
  }),
  execute: async ({ query, maxResults }, { abortSignal }) => {
    let avalaiUrl = (
      process.env.AVALAI_BASE_URL ||
      process.env.LLM_ENDPOINT ||
      "https://api.avalai.ir/v1"
    ).replace(/\/+$/, "");
    if (
      !process.env.VITEST &&
      process.env.NODE_ENV === "production" &&
      (avalaiUrl.includes("127.0.0.1") || avalaiUrl.includes("localhost"))
    ) {
      avalaiUrl = avalaiUrl
        .replace("127.0.0.1", "host.docker.internal")
        .replace("localhost", "host.docker.internal");
    }
    const searchTool = process.env.AVALAI_SEARCH_TOOL ?? "perplexity-search";
    const apiKey = process.env.AVALAI_API_KEY || process.env.LLM_API_KEY || "";
    try {
      const response = await fetch(`${avalaiUrl}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: maxResults,
          search_tool_name: searchTool,
        }),
        signal: abortSignal ?? undefined,
      });
      if (!response.ok) {
        return { results: [] };
      }
      const data = (await response.json()) as {
        results?: Array<{ title?: string; url?: string; snippet?: string }>;
      };
      return {
        results: Array.isArray(data.results)
          ? data.results
              .filter(
                (r) => typeof r?.url === "string" && typeof r?.title === "string",
              )
              .map((r) => ({
                title: String(r.title),
                url: String(r.url),
                snippet: typeof r.snippet === "string" ? r.snippet : "",
              }))
          : [],
      };
    } catch {
      // A failed search contributes nothing; the agent answers from
      // the Books alone and says the web is unreachable.
      return { results: [] };
    }
  },
});
