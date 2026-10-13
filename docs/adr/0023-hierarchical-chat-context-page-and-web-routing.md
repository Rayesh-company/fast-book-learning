# ADR 0023 — Four-Tier Hierarchical Context for Chat: Selection, Page-Injection, Book-Search, and Web Fallback

Date: 2026-10-11
Status: accepted
Amends: ADR-0022 (The chat becomes a free Mastra agent: Cognee and web search as its tools)
Builds on: ADR-0007 (Book reader page provenance), ADR-0011 (True-page resolver)

## Context

Learners chatting with their Books ask questions at four distinct semantic granularities:
1. **Passage-level**: Explaining or questioning a selected phrase or paragraph on the page.
2. **Page-level**: Inquiring about the specific page open in the Book reader (e.g., page 83: "خلاصهٔ این صفحه چیست؟").
3. **Book-level**: Broad thematic questions that span chapters (e.g., "جهاد در طرح کلی چه مراحلی دارد؟").
4. **External**: Concepts, modern history, or current events not covered in the Book set.

Previously, the Mastra chat agent treated every ask as a whole-book vector search via Cognee (`pageFiltering: false`). Even when a Learner asked while looking at page 83, the system searched the entire book and returned passages from unrelated chapters. No direct mechanism existed for the agent to inspect the verbatim text of the Learner's active page.

## Decision

Adopt a **Four-Tier Hierarchical Context Architecture**:

1. **Tier 1 — In-Context Selection Comprehension**:
   - When text is selected in the Book reader, the snippet is injected directly into prompt context.
   - The agent treats this as closed-passage reading comprehension; it answers strictly from the passage and avoids `search_books` unless external book definitions are required.

2. **Tier 2 — Direct Server-Side Page Text Injection**:
   - When a specific page is targeted (e.g. page 83), the server (`ui/serve.py`) reads the verbatim text directly from `books/<dataset>.pages.json` and injects it into Mastra's `requestContext.pageContext`.
   - Vector search is bypassed for this tier, eliminating retrieval latency and chunk-boundary misses.
   - The injection includes a small boundary buffer ($\pm 1$ page margin) to preserve sentences splitting across page breaks.

3. **Tier 3 — Whole-Book Hybrid Search (`search_booksTool`)**:
   - When the composer is set to "کل کتاب" (or when a page-scoped question cannot be answered from the scoped page), the agent calls `search_booksTool` to retrieve candidate passages across the Book set via Cognee's `ask_pool`.
   - If a page-scoped question exceeds the page's contents, the agent states explicitly that the topic is not on page $N$ before expanding its search to the rest of the book.

4. **Tier 4 — Web Search Fallback (`webSearchTool`)**:
   - If the Book set lacks the answer, the agent invokes `webSearchTool`.
   - The platform guarantees the «بیرون از کتاب» badge and visible link citations derived from the tool-execution record.

5. **UI Scoping & Canonical Citations**:
   - The mobile composer's page pill displays an explicit scope toggle: "صفحه فعلی" (scoped) vs "کل کتاب" (unscoped).
   - Entry from the Book reader defaults to "صفحه فعلی"; starting a new session from the sidebar defaults to "کل کتاب".
   - The agent must always cite sources using the canonical `document <book> (page <N>)` format, ensuring the client's interactive reader-jump buttons function across all tiers.
   - Turn metadata (`{ scope, page, selection }`) is permanently persisted in the session store.

## Considered Options

- **Vector retrieval with strict page-number metadata filters**: Rejected. Text chunks in Cognee frequently split across page boundaries, resulting in truncated sentences and missed passages compared to direct reading from `books/<dataset>.pages.json`.
- **Pre-LLM router / classifier for web vs book**: Rejected. Classifying query intent with regex or heuristics causes false positives on book terminology; agent-judged tool fallback preserves ADR-0018's differentiation.
- **Client-side page text uploads**: Rejected. Uploading text from the browser wastes mobile bandwidth and introduces inconsistency; `books/<dataset>.pages.json` is already indexed and mounted server-side.
