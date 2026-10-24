# Project: Mastra & Cognee Architecture Optimization

## Architecture
- **Mastra Agent Layer** (`agent/src/mastra/`): TypeScript agent powered by `@mastra/core`, `@mastra/memory`, `@mastra/libsql`. Handles dialogue streaming, tool execution (`searchBooksTool`, `webSearchTool`), and conversation memory.
- **Python Retrieval Seam** (`ui/ask.py`, `ui/serve.py:_agent_recall`): Python HTTP service receiving POST `/agent/recall` with `X-Agent-Token`, querying Cognee hybrid context, and returning citable passages.
- **Client & Chat Streaming Seam** (`ui/agent_client.py`, `ui/serve.py:/agent/chat`): Initiates streaming dialogue requests with `LearnerTurnContext`, enforces ADR-0023 Four-Tier context hierarchy, and provides platform-guaranteed «بیرون از کتاب» markings.
- **Reader & Citation Contract**: Canonical interactive citation format `document <book> (page <N>)` or `document <book> (pages <N>-<M>)`, driving mobile reader jumping.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Multi-Candidate Investigation & Empirical Benchmark | Measure token consumption, TTFT, retrieval latency across turns 1-6 under baseline; profile all 4 candidates (Memory Pruning, Evidence Distillation, Unified Context Budgeting, Recall Cache Adapter); produce evaluation markdown report | M1 | ORIGINAL_REQUEST §R1 |
| F2 | Memory Seam History Pruning & Tool Compaction | Compact/strip raw verbatim tool results from earlier turns in Mastra while preserving message roles, model syntheses, and canonical citations; reduce 6-turn dialogue prompt tokens by ≥ 50% | M2 | ORIGINAL_REQUEST §R2 |
| F3 | Evidence Pool Sentence Distillation & Density Scoring | Implement extractive sentence-level scoring and density distillation in `ui/ask.py` / `/agent/recall`, reducing passage token payload by ≥ 40% while preserving verbatim sentence boundaries and citations | M3 | ORIGINAL_REQUEST §R3 |
| F4 | Regression Guard & Context Hierarchy Verification | Zero regressions against ADR-0023 Four-Tier context hierarchy, interactive reader citations, and platform-guaranteed «بیرون از کتاب» markings; all baseline test suites pass | M4 | ORIGINAL_REQUEST §R4 |
| F5 | E2E Testing Suite (Tiers 1-4) | Independent opaque-box test suite covering feature coverage, boundaries, pairwise combinations, and 6-turn multi-dialogue benchmark; publishes TEST_READY.md | E2E-Track | Dual Track Architecture |
| F6 | Adversarial Hardening (Tier 5) & Forensic Integrity Audit | White-box stress-testing, coverage gap closing, and binary integrity verification | M4 (Final) | Project Pattern §Dual Track |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| E2E | E2E Testing Track | Requirement-driven test suite (Tiers 1-4), multi-turn benchmark runner, publishes `TEST_READY.md` | none | DONE (`TEST_READY.md` & `TEST_INFRA.md`) |
| M1 | Baseline Profiling & Multi-Candidate Empirical Benchmark | Turn 1-6 baseline profiling, 4-candidate quantitative analysis, empirical benchmark report | none | DONE (`BENCHMARK_REPORT.md`) |
| M2 | Prototype: Memory Seam History Pruning | Mastra `agent/src/mastra/agents/chat-agent.ts`, input processor / `ToolCallFilter`, compacting tool history, ≥ 50% prompt reduction | none | DONE (65 passed, 58.7-63.2% reduction) |
| M3 | Prototype: Evidence Pool Sentence Distillation | Python `ui/ask.py` (`distill_pool`), `ui/serve.py` (`_agent_recall`), sentence scoring, exact page resolution, ≥ 40% payload reduction | none | DONE (59 passed, 96.04% reduction) |
| M4 | Final Milestone: Integration, E2E 100% Pass, Adversarial Hardening & Audit | 100% E2E test pass (Tiers 1-4), Tier 5 adversarial stress testing, zero regressions on ADR-0023/citations, forensic integrity audit | M1, M2, M3, E2E | DONE (Gate PASSED: 2 APPROVE, 2 Challengers APPROVE, Auditor CLEAN) |

## Interface Contracts

### 1. Python Retrieval Seam Contract (`POST /agent/recall`)
- **Caller**: `agent/src/mastra/tools/search-books.ts`
- **Callee**: `ui/serve.py:_agent_recall` -> `ui/ask.py:ask_pool` / `distill_pool`
- **Request Headers**: `X-Agent-Token: <AGENT_SERVICE_TOKEN>`, `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "query": "string (non-empty)",
    "datasets": ["tarhe-kolli", "70143-336"]
  }
  ```
- **Response Body (200 OK)**:
  ```json
  {
    "passages": [
      {
        "reference": "document tarhe-kolli (page 709)",
        "passage": "verbatim distilled sentence span (preserves grammatical integrity, page provenance, and exact book text)"
      }
    ]
  }
  ```
- **Invariant**: Returned passages must match exact source substring sentences; reference must follow canonical citation format `document <book> (page <N>)` or `document <book> (pages <N>-<M>)`.

### 2. Mastra Agent Memory Pruning Contract
- **Seam**: `agent/src/mastra/agents/chat-agent.ts`
- **Hook**: `inputProcessors` / `processLLMRequest({ prompt, steps })`
- **Behavior**:
  - Current active turn ($T = \text{current}$): tool calls and tool results present in `steps` are preserved in `prompt` so the model can synthesize its response and citations.
  - Prior turns ($T < \text{current}$): raw tool calls (`searchBooksTool`, `webSearchTool`) and raw tool result messages are stripped/compacted from the prompt.
  - Prior turns collapse cleanly to `user -> assistant` exchanges.
  - Assistant synthesized text and embedded canonical citations (`document <book> (page <N>)`) are 100% preserved.

### 3. Client & Chat Streaming Seam Contract (`POST /agent/chat`)
- **Caller**: Mobile Client / Web UI
- **Callee**: `ui/serve.py` -> `ui/agent_client.py` -> `POST /api/agents/chat-agent/stream`
- **Invariants**:
  - Four-Tier context hierarchy strictly preserved (Tier 1: selection, Tier 2: page context, Tier 3: book search, Tier 4: web search).
  - Platform-guaranteed «بیرون از کتاب» marking emitted in SSE `chat-answer-finalized` and stored in `chat_store`, derived strictly from `webSearchTool` execution in the active turn.
  - Interactive reader citations `document <book> (page <N>)` trigger reader jump buttons.

## Code Layout
- TypeScript Agent:
  - `agent/src/mastra/agents/chat-agent.ts`: Chat agent configuration, memory options, and input processors.
  - `agent/src/mastra/tools/search-books.ts`: Book search tool calling `/agent/recall`.
  - `agent/src/mastra/tools/web-search.ts`: Web search tool calling Avalai search.
  - `agent/src/mastra/index.ts`: Mastra server and LibSQL storage setup.
  - `agent/src/mastra/multi-turn-benchmark.test.ts`: 6-turn sequential dialogue benchmark test.
- Python Retrieval & Server:
  - `ui/ask.py`: `ask_pool`, `_dataset_passages`, and new `distill_pool` extractive sentence scoring logic.
  - `ui/serve.py`: `_agent_recall` endpoint handler calling `distill_pool`.
  - `ui/agent_client.py`: Mastra client request construction and streaming parser.
  - `tests/test_evidence_distillation.py`: Unit and contract tests for sentence distillation.
- Documentation & Artifacts:
  - `BENCHMARK_REPORT.md` (or `evaluation_report.md`): Final empirical benchmark evaluation report comparing token, latency, and accuracy metrics for all 4 candidates.
