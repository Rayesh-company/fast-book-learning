import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// The Python core's agent seam (ADR-0016/0018): the same parsed
// only_context hybrid pool ui.ask.ask_pool builds for /ask — the
// citation logic is NEVER duplicated on this side of the seam.
// Env is read at call time (the ui.ask._recall_url rule) so the
// tests' pins hold.

export const searchBooksTool = createTool({
  id: "search-books",
  description:
    "جست‌وجو در متن کتاب‌های مجموعه. Searches the Book set (طرح کلی اندیشۀ اسلامی در قرآن and انسان ۲۵۰ ساله) and returns verbatim passages, each with its citation reference (the Book and its pages). Call this FIRST for any question the Books might answer.",
  inputSchema: z.object({
    query: z.string().describe("The search query over the Book set; Farsi preferred"),
    datasets: z
      .array(z.string())
      .optional()
      .describe("Optional Book dataset names; omit to search the whole Book set"),
  }),
  outputSchema: z.object({
    passages: z.array(
      z.object({
        reference: z.string().describe("The citation reference: the Book and its pages"),
        passage: z.string().describe("Verbatim Book text"),
      }),
    ),
  }),
  execute: async ({ query, datasets }, { abortSignal }) => {
    const coreUrl = (process.env.PYTHON_CORE_URL ?? "http://127.0.0.1:8765").replace(/\/+$/, "");
    const agentToken = process.env.AGENT_SERVICE_TOKEN ?? "";
    try {
      const response = await fetch(`${coreUrl}/agent/recall`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-Token": agentToken,
        },
        body: JSON.stringify({ query, datasets }),
        signal: abortSignal ?? undefined,
      });
      if (!response.ok) {
        return { passages: [] };
      }
      const data = (await response.json()) as {
        passages?: Array<{ reference: string; passage: string }>;
      };
      return {
        passages: Array.isArray(data.passages)
          ? data.passages.filter(
              (p) =>
                typeof p?.reference === "string" && typeof p?.passage === "string",
            )
          : [],
      };
    } catch {
      // A missed seam contributes nothing; the agent must say the
      // Books are unreachable rather than invent Book text.
      return { passages: [] };
    }
  },
});
