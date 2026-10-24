# Spec 0024: Mastra Agent & Cognee Architecture Optimization (Memory Compaction, Evidence Distillation, and Retrieval Caching)

## Problem Statement

When a Learner engages in an extended study dialogue with their Books in the mobile reader, response generation becomes progressively slower (high TTFT) and answer quality degrades due to context pollution. Because historical conversation turns currently preserve unpruned, 6,000-character tool execution payloads in the prompt history, token consumption compounds exponentially—exceeding 30,000 prompt tokens over a standard 6-turn exchange. 

Simultaneously, when the agent queries the Book set via Cognee, the retrieval seam returns large, unranked 1,500-character chunks that often span wide multi-page ranges (e.g. `pages 707-712`). This forces the language model to search through extensive surrounding noise, increasing the risk of hallucinated citations or inexact page numbers. Furthermore, repeated or sequential questions across identical topics trigger duplicate 3,072-dimension query embeddings and pgvector scans over the Cognee HTTP seam, introducing multi-second delays on queries that should be instantaneous.

## Solution

A multi-layered architectural optimization across the Mastra agent memory layer and the Python retrieval seam:

1. **Memory Seam History Pruning**: The Mastra conversation memory compacts raw tool execution payloads from earlier dialogue turns, preserving only assistant syntheses and interactive citation anchors. Prompt token growth stays flat across multi-turn conversations.
2. **Evidence Pool Sentence Distillation**: The `/agent/recall` seam performs deterministic extractive sentence segmentation and query density scoring on candidate Cognee passages. Only high-density, sentence-aligned evidence spans are passed to the agent, reducing retrieval payload size by over 60% and sharpening multi-page ranges into exact single-page citations.
3. **Recall Caching**: An in-memory cache adapter behind the book retrieval interface short-circuits repeat and semantically close queries, slashing retrieval latency on cache hits from ~4,200ms to under 5ms with zero upstream embedding cost.

## User Stories

1. As a Learner asking follow-up questions in a multi-turn chat, I want the agent's response to begin streaming immediately, so that I don't experience increasing lag as our conversation progresses.
2. As a Learner reviewing earlier answers in my chat history, I want all previous citation pills and quotes to remain visible and clickable, so that pruning past tool data does not break my reading reference points.
3. As a Learner asking about a specific theological concept, I want the agent to ground its answer on the most relevant sentences rather than broad surrounding text, so that the explanation is focused and direct.
4. As a Learner tapping a citation badge, I want the reference to take me to the exact single page where the argument appears rather than a wide 5-page interval, so that I can immediately find the cited text in the PDF reader.
5. As a Learner asking a question similar or identical to a previous one in the same session, I want the response to arrive in under a second, so that study review is instantaneous.
6. As a Learner on a metered or limited mobile data connection, I want the server to exchange minimal necessary token payloads, so that network latency and battery consumption remain low.
7. As a Learner receiving an answer with external web sources, I want the platform-guaranteed «بیرون از کتاب» badge and links to appear reliably, so that I never mistake external facts for Book doctrine.
8. As a Learner alternating between questions and follow-ups, I want the conversation history to maintain strict user/assistant message alternation, so that the underlying language model is never confused by corrupted turn roles.
9. As an operator managing LLM infrastructure costs, I want multi-turn prompt tokens to be capped under an explicit budget, so that long conversations do not deplete the subscription tariff window prematurely.
10. As an operator running Cognee memory services, I want redundant embedding and pgvector queries to be cached in memory, so that database load and external embedding API rates remain sustainable under concurrent learner load.
11. As a developer verifying agent changes, I want tool pruning and sentence distillation to be tested against high-level HTTP and module seams, so that internal implementation details can evolve without breaking end-to-end behavior.
12. As a Learner whose connection drops mid-turn, I want the completion-anchored persistence contract to be preserved, so that incomplete or aborted streams do not leave orphaned tool states in my chat history.
13. As a Learner asking about concepts spanning page boundaries, I want verbatim sentence boundaries to be strictly preserved during distillation, so that quotes are never truncated mid-sentence.
14. As a Learner studying in low-connectivity environments, I want the retrieval pool to return compact payloads, so that server-to-agent serialization overhead is minimized.
15. As a Learner using personalized tone and age scaffolding, I want context budgeting to maintain my profile directives without bloating every prompt turn with redundant multi-paragraph boilerplate.

## Implementation Decisions

- **Mastra Memory Seam Tool Compaction**:
  - Integrated native `ToolCallFilter` processor seam into `agent/src/mastra/agents/chat-agent.ts`.
  - Excludes `searchBooksTool` and `webSearchTool` execution bodies from turns prior to the active turn, while retaining active-turn tool execution records for immediate synthesis.
  - Implements token budgeting (`maxTokens: 8000`, `atMaxRemoveTokens: 2000`) to guarantee an upper ceiling on prompt context.
  - *Decision snippet from prototype*:
    ```typescript
    inputProcessors: [
      new ToolCallFilter({
        exclude: ["searchBooksTool", "webSearchTool"],
      }),
    ],
    ```
- **Sentence-Level Evidence Distillation (`distill_pool`)**:
  - Implemented in `ui/ask.py` and connected to `ui/serve.py:_agent_recall`.
  - Splits retrieved Cognee passages along Farsi sentence boundaries, scores sentences by query token density, and extracts the top $K$ candidate spans within a token budget (e.g. 400 tokens).
  - Inspects page marker provenance (`Page N:`) on each extracted sentence to resolve coarse multi-page spans (e.g. `pages 707-712`) down to exact single-page citations (e.g. `page 709`).
  - *Decision snippet from prototype*:
    ```python
    def distill_pool(
        passages: list[dict],
        query: str,
        top_k: int = 3,
        max_tokens: int = 400,
    ) -> list[dict]:
        # Evaluates sentence boundaries, query density scores, and provenance locators
    ```
- **In-Memory Recall Cache**:
  - Sits directly behind `ask_pool` in `ui/ask.py`.
  - Keyed by normalized query string and validated dataset array; caches distilled passage results with TTL to eliminate redundant embedding generation and database round-trips.
- **Architectural Seams**:
  - Primary Seam (Highest): `POST /agent/chat` (HTTP Seam in Python Core `ui/serve.py`)
  - Retrieval Seam: `POST /agent/recall` (HTTP Seam in Python Core `ui/serve.py`)
  - Memory Seam: `chatAgent.memory` with `ToolCallFilter` (In-process Vitest Seam in `agent/src/mastra/agents/chat-agent.ts`)

## Testing Decisions

- **External Behavior Verification**: Tests strictly verify outward HTTP contracts, SSE stream frames, canonical citation strings (`document <book> (page <N>)`), and token reduction ratios rather than private internal state.
- **Tested Modules**:
  - `agent/src/mastra/agents/chat-agent.ts`: Verified via Vitest for memory compaction, role alternation, and token ceiling enforcement across 6 turns.
  - `ui/ask.py` & `ui/serve.py`: Verified via Pytest for sentence boundary preservation, citation sharpening, empty-pool safety, and unauthorized token rejection.
  - `ui/mobile/api.mjs`: Verified via reader regression tests ensuring citation buttons correctly link to PDF pages.
- **Prior Art**:
  - `tests/test_agent_chat.py` (pins the `/agent/chat` HTTP seam and SSE streaming relay).
  - `tests/test_agent_recall.py` (pins the `/agent/recall` tool seam).
  - `agent/src/mastra/stream-shape.test.ts` (pins the Mastra streaming frames and tool-result records).
  - `tests/test_evidence_distillation.py` (pins sentence boundary integrity and payload reduction).

## Out of Scope

- Modifying Cognee's internal relational tables, Alembic migrations, or pgvector index dimensions.
- Changing the primary chat LLM endpoint (retains `deepseek-v4.1-flash` via Avalai per ADR-0018).
- Redesigning the mobile UI reader or client-side navigation layout.
- Modifying audio narration, word alignment, or PDF rendering canvas components.

## Further Notes

- Amends ADR-0014 (retrieval-only ask), ADR-0018 (free conversational agent), ADR-0020 (Mastra top layer), and ADR-0023 (four-tier hierarchical context).
- Builds directly on empirical benchmarks established in `BENCHMARK_REPORT.md` and feature milestones in `PROJECT.md`.
