# Test Infrastructure & Benchmark Specification

## Mastra & Cognee Architecture Optimization

---

## 1. Testing Philosophy & Seam Architecture

This document defines the automated test infrastructure, verification methodology, and empirical benchmark harness for the Mastra agent memory pruning, Python evidence distillation, context hierarchy enforcement, and interactive reader citation contracts.

### 1.1 Core Testing Principles
1. **Seam-Driven Verification**: Tests verify behavior strictly through defined architectural seams (public interfaces and HTTP boundaries), never via private state inspection or side channels.
2. **Deterministic & Isolated**: In-process mocks (`node:http` servers and `unittest.mock` / `AskUpstream`) simulate external LLMs (AvalAI) and vector storage (Cognee) deterministically with zero live network dependency.
3. **Explicit Expected Output Derivation**: Every test assertion derives from documented requirements in `ORIGINAL_REQUEST.md`, architectural invariants in `PROJECT.md`, and mathematical token reduction formulas.
4. **Anti-Facade / Anti-Cheating Invariant**: Test suites actively verify genuine execution logic (e.g. measuring intercepted HTTP payload sizes, parsing sentence substrings, checking regex citation structures) rather than asserting mock identities.

### 1.2 System Seam Architecture

```
+-------------------------------------------------------------------------+
|                              Learner / Mobile UI                        |
+-------------------------------------------------------------------------+
                                    |
                            [Client Seam: HTTP SSE]
                                    v
+-------------------------------------------------------------------------+
|                  Python Core Server (ui/serve.py)                       |
|  - LearnerTurnContext Validation & ADR-0023 Context Hierarchy           |
|  - «بیرون از کتاب» Platform Guarantee Derivation                       |
|  - POST /agent/recall Seam Handler (_agent_recall -> distill_pool)      |
+-------------------------------------------------------------------------+
           |                                                ^
 [Mastra Stream Seam]                             [Python Retrieval Seam]
           v                                                |
+------------------------------------+             +----------------------+
|  Mastra Agent Layer (TypeScript)   |             |   ui/ask.py          |
|  agent/src/mastra/agents/          |             |   - ask_pool         |
|  - chatAgent                       |--[Recall]-->|   - distill_pool     |
|  - Memory & Tool Compaction        |             |   - Cognee Recall    |
|  - searchBooksTool / webSearchTool |             +----------------------+
+------------------------------------+                        |
           |                                            [Cognee API]
   [LLM Request Seam]                                         v
           v                                       +----------------------+
+------------------------------------+             |   Cognee Service     |
|  LLM Completion API (/v1/chat)     |             |   (HYBRID_COMPLETION)|
+------------------------------------+             +----------------------+
```

The four testable public seams:
1. **Memory Seam (TypeScript)**: `agent/src/mastra/agents/chat-agent.ts` — Conversation turn memory, input processors, and tool result compaction.
2. **Retrieval Seam (Python)**: `ui/ask.py` / `ui/serve.py:_agent_recall` — Cognee hybrid context parsing, extractive sentence scoring, exact page resolution, and passage payload distillation.
3. **Client Dialogue Seam (Python)**: `ui/serve.py:/agent/chat` -> `ui/agent_client.py` — Multi-turn SSE streaming, `LearnerTurnContext` coordination, and «بیرون از کتاب» badge emission.
4. **Reader & Citation Seam (JavaScript / Python)**: `tests/reader/*.test.mjs`, `ui/guard.py` — Canonical citation format `document <book> (page <N>)` and mobile reader page jumping.

---

## 2. Feature Inventory to Test Suite Mapping

| Feature ID | Feature Name | Primary Seam | Test File(s) | Runner Command |
|---|---|---|---|---|
| **F1** | Multi-Candidate Empirical Benchmark | All Seams | `agent/src/mastra/multi-turn-benchmark.test.ts`<br>`BENCHMARK_REPORT.md` | `npm.cmd test --prefix agent -- multi-turn-benchmark` |
| **F2** | Memory Seam History Pruning | Mastra Agent Layer | `agent/src/mastra/multi-turn-benchmark.test.ts`<br>`agent/src/mastra/agents/chat-agent.test.ts` | `npm.cmd test --prefix agent` |
| **F3** | Evidence Pool Sentence Distillation | Python Retrieval Seam | `tests/test_evidence_distillation.py`<br>`tests/test_agent_recall.py`<br>`tests/test_ask.py` | `python -m pytest tests/test_evidence_distillation.py tests/test_agent_recall.py` |
| **F4** | Context Hierarchy & Citation Regression Guard | Client & Reader Seams | `tests/test_agent_chat.py`<br>`tests/reader/*.test.mjs`<br>`agent/src/mastra/agents/chat-agent.test.ts` | `python -m pytest tests/test_agent_chat.py`<br>`npm.cmd test --prefix tests/reader` |
| **F5** | E2E Benchmark & Integration Track | Full Pipeline | `TEST_INFRA.md`<br>`agent/src/mastra/multi-turn-benchmark.test.ts`<br>`tests/test_evidence_distillation.py` | Full Test Suite (Section 3) |
| **F6** | Adversarial Hardening (Tier 5) | Seam Boundaries | Challenger & Forensic Audit Suites | `python -m pytest`<br>`npm.cmd test` |

---

## 3. Test Runner Commands & Environment Configuration

### 3.1 Windows PowerShell Notes
- On Windows systems with default execution policies, calling bare `npm` fails due to PowerShell script restrictions. Always invoke as **`npm.cmd`**.
- When running Python tests, always execute via **`python -m pytest`** (or set `$env:PYTHONPATH="."`) to ensure repository root modules (`ui`, `tests`) are resolved.

### 3.2 Individual Test Suite Execution

#### TypeScript Multi-Turn Benchmark (Tier 3)
```powershell
npm.cmd test --prefix agent -- multi-turn-benchmark
```
*Expected output*: 1 passed test file, 5 benchmark test cases passed, exit code 0.

#### TypeScript Chat Agent & Tools Unit/Contract Tests (Tiers 1 & 2)
```powershell
npm.cmd test --prefix agent
```
*Expected output*: All agent test files passed, exit code 0.

#### Python Evidence Distillation Tests (Tier 2)
```powershell
python -m pytest tests/test_evidence_distillation.py
```
*Expected output*: All distillation unit and contract tests passed, exit code 0.

#### Python Agent Chat & Recall Seam Tests (Tier 2 & 4)
```powershell
python -m pytest tests/test_agent_chat.py tests/test_agent_recall.py
```
*Expected output*: 34 passed tests, exit code 0.

#### Mobile Reader & Citation Navigation Tests (Tier 4)
```powershell
npm.cmd test --prefix tests/reader
```
*Expected output*: 102 passed tests, exit code 0.

### 3.3 Full Regression Guard Execution
To verify the entire repository with zero regressions:
```powershell
npm.cmd test --prefix agent
python -m pytest tests/test_evidence_distillation.py tests/test_agent_chat.py tests/test_agent_recall.py tests/test_ask.py
npm.cmd test --prefix tests/reader
```

---

## 4. Multi-Turn 6-Dialogue Benchmark Harness Specification

### 4.1 Benchmark Objective
The multi-turn benchmark simulates a stateful learner dialogue across 6 sequential turns on a persistent thread. It measures prompt token growth at the `/chat/completions` HTTP seam, validates canonical citation preservation, and evaluates prompt token compaction.

### 4.2 Turn-by-Turn Scenario Script

| Turn | Learner Query | Context / Tier | Expected Tool Call | Expected Model Response & Citation |
|---|---|---|---|---|
| **Turn 1** | مفهوم نبوت در قرآن و کتاب طرح کلی چیست؟ | Tier 3 (Book Search) | `searchBooksTool({ query: "نبوت در قرآن" })` | نبوت به معنای رسالت و روشنگری توحیدی است `document tarhe-kolli (pages 120-121)`. |
| **Turn 2** | آیا این مفهوم با توحید پیوند مستقیم دارد؟ | Follow-up Coherence | None (0 tool calls) | بله، همان‌طور که در نوبت پیش اشاره شد، نبوت جلوه عملی توحید است. |
| **Turn 3** | در کتاب انسان ۲۵۰ ساله سیره ائمه در جهاد چگونه تحلیل شده است؟ | Tier 3 (Book Search) | `searchBooksTool({ query: "سیره ائمه جهاد" })` | ائمه به عنوان یک انسان ۲۵۰ ساله یک مبارزه حاد سیاسی را دنبال می‌کردند `document 70143-336 (page 140)`. |
| **Turn 4** | منظور از انسان ۲۵۰ ساله دقیقا چیست؟ | Clarification | None (0 tool calls) | منظور این است که زندگی ائمه از سال ۱۱ هجری تا ۲۶۰ هجری یک پیکار پیوسته بوده است. |
| **Turn 5** | آیا در صفحهٔ ۴۸۱ طرح کلی به مبحث عدالت اقتصادی اشاره شده است؟ | Tier 2 (Page Scope) -> Escalation to Tier 3 | `searchBooksTool({ query: "عدالت اقتصادی طرح کلی" })` | در صفحهٔ ۴۸۱ به این موضوع پرداخته نشده است. با جستجو در کل کتاب: عدالت اقتصادی بر پایه مساوات بنیان نهاده می‌شود `document tarhe-kolli (page 481)`. |
| **Turn 6** | خلاصه‌ای از پیوند بین نبوت، توحید و مبارزه ۲۵۰ ساله ائمه ارائه دهید. | Multi-Turn Summary | None (0 tool calls) | خلاصه پیوند: توحید زیربنا، نبوت نقشه راه (طرح کلی)، و مبارزه ائمه تحقق عملی آن است (انسان ۲۵۰ ساله). |

### 4.3 Prompt Token Measurement Methodology
1. **Request Interception**: The mock HTTP server intercepts every POST request to `/chat/completions`.
2. **Payload Extraction**: For each request, the complete `body.messages` array is captured.
3. **Character & Token Calculations**:
   - Total prompt character count = sum of `message.content` lengths + tool call arguments + system instructions.
   - Standard token estimate: $\text{tokens} = \max(1, \lceil \text{chars} / 3 \rceil)$.
4. **Tool Bloat Attribution**:
   - Tracks the presence of raw book chunk tool results from prior turns ($t < T$) vs the active turn ($t = T$).
5. **Pass/Fail Threshold**:
   - Compaction must achieve $\ge 50.0\%$ cumulative prompt token reduction across the 6-turn dialogue compared to baseline:
     $$\text{Reduction} = \frac{\text{Cumulative Tokens}_{\text{Baseline}} - \text{Cumulative Tokens}_{\text{Optimized}}}{\text{Cumulative Tokens}_{\text{Baseline}}} \ge 0.50$$

---

## 5. Evidence Pool Sentence Distillation Specification

### 5.1 Distillation Objective
Cognee's `only_context` retrieval returns multi-page chunks (often 3,500–4,100 tokens, spanning up to 5 PDF pages). Blind slicing at 1,500 characters severs sentences mid-thought and clips away evidence on subsequent chunk pages.

Evidence Pool Sentence Distillation (`distill_pool` in `ui/ask.py`) replaces blind slicing with extractive sentence scoring and page provenance tracking before crossing the HTTP seam into Mastra.

### 5.2 Interface Contract
- **Signature**: `distill_pool(query: str, pool: list[dict], max_chars_per_passage: int = 600, min_chars_per_passage: int = 150) -> list[dict]`
- **Input Passage Schema**:
  ```python
  {
      "reference": "document tarhe-kolli (pages 707-712)",
      "passage": "... raw multi-page chunk text ...",
  }
  ```
- **Output Passage Schema**:
  ```python
  {
      "reference": "document tarhe-kolli (page 709)",  # Narrowed to exact page
      "passage": "... verbatim distilled sentence span ...",
      "score": 4.5,                                     # Optional density metric
  }
  ```

### 5.3 Algorithmic Invariants
1. **Verbatim Sentence Boundaries**: Output text must strictly match an exact substring of the original source text. No invented words, no summarization, no character modifications.
2. **Exact Page Provenance**: By parsing `Page (\d+)[:：]` markers inside the chunk, each sentence is tagged with its origin page. When the distilled span comes from page $N$, the citation is updated from `(pages X-Y)` to `(page N)`.
3. **Lexical Density Scoring**: Sentence relevance is scored using Persian text normalization (`normalize_for_match` from `ui/guard.py`):
   - Maps Arabic forms (`ي`, `ك`, `ة`, `أ`) to Persian (`ی`, `ک`, `ه`, `ا`).
   - Strips tashkeel and punctuation.
   - Computes query keyword frequency and coverage.
4. **Contiguous Window Assembly**: Builds a 1-to-3 sentence window around scoring peaks up to `max_chars_per_passage` (~400–600 chars).
5. **Concise Passage Protection**: Passages already $\le 400$ characters are preserved verbatim without pruning.
6. **Token Reduction Threshold**:
   - The token payload across the distilled pool must be reduced by $\ge 40.0\%$ compared to raw passage volume:
     $$\text{Payload Reduction} = \frac{\text{Chars}_{\text{Raw}} - \text{Chars}_{\text{Distilled}}}{\text{Chars}_{\text{Raw}}} \ge 0.40$$

---

## 6. Context Hierarchy & Invariants Verification Matrix

| Tier | Context Scope | Tool Execution Rule | Verification Rule | Test Anchor |
|---|---|---|---|---|
| **Tier 1** | `selectionText` | 0 tool calls permitted | Closed-passage reading comprehension; answers solely from highlighted text. | `chat-agent.test.ts:Ticket 03` |
| **Tier 2** | `pageContext` ($\pm 1$ page) | 0 tool calls when answered from page; boundary acknowledgment before book search when uncovered. | Answers directly with citation; acknowledges page boundary before escalating to `searchBooksTool`. | `chat-agent.test.ts:Ticket 02`<br>`multi-turn-benchmark.test.ts:Turn 5` |
| **Tier 3** | Whole-Book Hybrid Search | Calls `searchBooksTool` -> `/agent/recall` -> `ask_pool` / `distill_pool` | Returns top citable passages with canonical citation `document <book> (page <N>)`. | `test_agent_recall.py`<br>`multi-turn-benchmark.test.ts:Turns 1, 3` |
| **Tier 4** | Web Fallback | Calls `webSearchTool` -> AvalAI search | Platform guarantee: SSE `chat-answer-finalized` emits «بیرون از کتاب» if and only if `webSearchTool` was invoked. | `test_agent_chat.py:test_web_sourced_badge` |

---

## 7. Baseline vs Candidate Metrics Reference

| Candidate | Multi-Turn Prompt Tokens (T1-T6) | % Prompt Reduction | Retrieval Payload Tokens | % Payload Reduction | Avg Retrieval Latency | Avg TTFT | Citation Validity |
|---|---|---|---|---|---|---|---|
| **Baseline** | ~24,500 | 0.0% | ~2,800 | 0.0% | ~4,200 ms | ~1,850 ms | 100% |
| **C1: Memory Seam Pruning** | $\le 11,500$ | $\ge 53.0\%$ | ~2,800 | 0.0% | ~4,200 ms | ~1,100 ms | 100% |
| **C2: Evidence Distillation** | ~21,000 | ~14.0% | $\le 1,600$ | $\ge 42.8\%$ | ~4,250 ms | ~1,400 ms | 100% |
| **C3: Unified Context Budget** | ~14,000 | ~42.8% | ~2,800 | 0.0% | ~4,200 ms | ~1,200 ms | 100% |
| **C4: Recall Cache Adapter** | ~24,500 | 0.0% | ~2,800 | 0.0% | < 10 ms (hit) / ~4,200 ms (miss) | ~250 ms (hit) / ~1,850 ms (miss) | 100% |
| **Combined (C1 + C2)** | $\le 8,500$ | $\ge 65.3\%$ | $\le 1,600$ | $\ge 42.8\%$ | ~4,250 ms | ~950 ms | 100% |

---

## 8. Invalidation & Maintenance

This test infrastructure specification is invalidated if:
1. Canonical interactive citation format `document <book> (page <N>)` is changed in `ui/guard.py` or mobile reader contracts.
2. The Four-Tier context hierarchy (ADR-0023) is altered.
3. «بیرون از کتاب» derivation rule in `ui/serve.py` is removed or modified.
4. Any regression occurs on baseline suites (`npm.cmd test --prefix agent` or `python -m pytest tests/test_agent_chat.py tests/test_agent_recall.py`).
