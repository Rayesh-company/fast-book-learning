# Spec: Four-Tier Hierarchical Context for Chat Agent (Selection, Page-Injection, Whole-Book Search, Web Fallback)

## Problem Statement

When a Learner asks questions while studying a Book in the mobile reader, the current chat agent architecture treats all queries as an unscoped, whole-book hybrid search. Even when viewing a specific page (e.g. page 83) or selecting an exact passage, the system ignores the page boundaries, queries vector memory across hundreds of unrelated pages, and returns answers cited from far-away chapters. Furthermore, the composer interface displays a page pill (`۸۳`) that suggests the agent is looking at that specific page when it is not. This causes disorientation, degraded comprehension, and an inability to ask targeted reading questions about the active page.

## Solution

Implement a **Four-Tier Hierarchical Context Architecture** that dynamically routes and injects context according to the Learner's explicit study focus:
1. **Tier 1 (Passage Selection)**: In-context reading comprehension over highlighted text, answering strictly from the excerpt without extraneous book searches.
2. **Tier 2 (Page Scope)**: Direct server-side injection of verbatim page text from the authoritative book text index (with $\pm 1$ page boundary buffers), bypassing vector search for zero latency and 100% precision.
3. **Tier 3 (Whole Book)**: Unscoped hybrid search across the Book set via Cognee for thematic and cross-chapter inquiries.
4. **Tier 4 (Internet Fallback)**: Agent-judged web search for topics outside the Book set, with platform-guaranteed «بیرون از کتاب» markings.

The composer receives an explicit Page Scope toggle, defaulting to "صفحه فعلی" from the Book reader and "کل کتاب" from the sidebar, with all tiers adhering to canonical citations to support interactive reader jumping.

## User Stories

1. As a Learner reading page 83 of a Book, I want to tap the composer and ask "این صفحه را خلاصه کن", so that the Chat agent answers based on the actual text of page 83 without wandering into other chapters.
2. As a Learner viewing page 83, I want the system to include adjacent page boundary buffers, so that sentences starting on page 82 or ending on page 84 are not cut off in the Chat agent's comprehension.
3. As a Learner reading a Book, I want to highlight two sentences and ask "منظور از این گزاره چیست؟", so that the Chat agent explains those specific sentences in-context without pulling citations from unrelated chapters.
4. As a Learner with page 83 scoped, I want to be informed if my question is about a topic not mentioned on page 83, so that I understand the limits of this page before the agent expands to the rest of the book.
5. As a Learner asking an out-of-scope question on page 83, I want the Chat agent to automatically expand to whole-book search after acknowledging the page gap, so that I still get a complete answer to my question.
6. As a Learner starting a "نشست تازه" from the sidebar, I want the composer to default to "کل کتاب" scope, so that I can ask broad thematic questions across the entire Book set without accidental page restrictions.
7. As a Learner jumping from the Book reader into chat, I want the composer to default to "صفحه فعلی", so that my chat immediately aligns with what I was just reading.
8. As a Learner in the chat composer, I want an interactive toggle on the page pill between "صفحه فعلی" and "کل کتاب", so that I can switch between local page study and global book exploration with one tap.
9. As a Learner studying a specific chapter range, I want to select a custom page interval (e.g. pages 80 to 95) via the page modal, so that the agent confines its direct context to that target section.
10. As a Learner receiving an answer derived from an injected page, I want to see a standard clickable citation badge for that page, so that I can tap it to open the Book reader directly at the referenced text.
11. As a Learner receiving an answer from a whole-book search, I want verifiable page range citations, so that I can jump to the exact pages where the arguments appear.
12. As a Learner asking about modern historical events not covered in the Book set, I want the agent to search the internet and clearly badge the findings as «بیرون از کتاب», so that I never mistake external commentary for Book doctrine.
13. As a Learner reviewing past chats in the sidebar history, I want to see the page number and study context under each historical question, so that I remember which section of the Book prompted that conversation.
14. As a mobile Learner on a low-bandwidth connection, I want page text to be assembled on the server rather than uploaded from my device, so that asking page-scoped questions is fast and consumes minimal data.
15. As a Learner switching books, I want the page scope to reset to the reading position of the newly selected book, so that context never leaks across different books.
16. As a Learner whose connection drops mid-stream, I want incomplete or failed page-scoped streams to record no spurious Question or corrupted exchange, so that my quota and study history stay clean.
17. As an operator reviewing token usage, I want direct page injection to bypass vector retrieval and tool-call loops for direct page questions, so that time-to-first-token is immediate and inference cost is minimized.

## Implementation Decisions

- **Context Routing & Injection Protocol**:
  - The mobile API request carries `{ query, datasets, page, scope: "page" | "all", selection }`.
  - The server-side request handler inspects the incoming scope:
    - If `scope === "page"`: retrieves the normalized text for the requested page plus immediate boundary slices ($\pm 1$) from the local text index.
    - If `selection` is present: wraps the selected excerpt as primary in-context passage.
    - If `scope === "all"`: leaves page context empty, signaling whole-book mode.
  - The assembled context is supplied to the Mastra agent via request context metadata, where dynamic agent instructions format it into the system prompt.
- **Mastra Chat Agent System Instructions**:
  - Directives define the four-tier hierarchy:
    1. If selection context is present: prioritize closed-passage comprehension.
    2. If page context is present: answer from the active page first; cite in canonical `document <book> (page <N>)` format. If the page does not cover the question, state that page $N$ does not contain it and invoke the book retrieval tool.
    3. If whole-book mode or page overflow: invoke the book retrieval tool across the Book set.
    4. If book retrieval yields no relevant results: invoke the web search tool, marking external findings.
- **Composer State Machine**:
  - The client UI tracks an active scope state: `scoped` vs `unscoped`.
  - When navigating to chat from the reader: initializes `scope = "page"` with the reader's current page position.
  - When opening a new session from the sidebar or book selector: initializes `scope = "all"`.
  - Tapping the page pill toggles between `scoped` and `unscoped`, updating the visual styling (solid active vs dimmed outline).
- **Canonical Citation Format**:
  - Across all tiers (injected page text, book retrieval tool), citations follow `document <book> (page <N>)` or `document <book> (pages <N>-<M>)`.
  - The client citation parser regex detects these references and transforms them into interactive navigation elements linked to the PDF reader.
- **Persistence Schema & History Restore**:
  - Chat exchanges persist the turn metadata `{ scope, page, selection }` alongside the question and answer.
  - History rendering reads this metadata to display contextual study badges on user message bubbles.

## Testing Decisions

- **Seams**:
  - Primary Seam: `POST /agent/chat` (HTTP Seam). This is the highest operational integration seam, testing client request payloads through server-side page text assembly, Mastra stream relay, and final event emission.
  - Unit / Agent Seam: Vitest suite for the Mastra agent instructions and tool execution, testing that page context in request context generates canonical citations without premature tool calls.
  - Client UI Seam: End-to-end component tests verifying composer scope toggling, entry defaults from reader vs sidebar, and citation badge clicks.
- **Behavior-Driven Test Coverage**:
  - Verify that a page-scoped request with page 83 injects page 83 text into the Mastra stream and produces an answer with `document <book> (page 83)` without invoking the book search tool.
  - Verify that an out-of-scope question on a page-scoped turn triggers the explanatory phrase and subsequently executes the book search tool.
  - Verify that a question with a text selection restricts its answer to the excerpt without extraneous tool calls.
  - Verify that an unscoped question defaults to whole-book search tool execution.
  - Verify that entering chat from the reader sets active page scope, while starting a new session defaults to unscoped.
- **Prior Art**:
  - `tests/test_agent_chat.py` (pins the `/agent/chat` HTTP seam and canned Mastra SSE stream relay).
  - `tests/test_agent_recall.py` (pins the `/agent/recall` tool seam).
  - `agent/src/mastra/stream-shape.test.ts` (pins the Mastra streaming dialect and tool-result frames).

## Out of Scope

- Multi-page semantic OCR or image analysis of PDF drawings/diagrams.
- Automatic clustering or summarization of the entire book in a single prompt.
- Changes to Cognee's internal embedding models or pgvector storage indexing.
- Learning mode (Mode 2) protocol workflows and mind map rendering (governed by separate learning-session specs).

## Further Notes

- Builds directly on ADR-0007, ADR-0011, ADR-0018, and ADR-0023.
- All Persian strings adhere to the approved domain vocabulary in `CONTEXT.md`.
