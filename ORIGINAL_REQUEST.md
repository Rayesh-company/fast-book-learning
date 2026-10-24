# Original User Request

## 2026-10-18T10:48:01Z

Investigate all four Mastra agent and Cognee optimization candidates (Memory Seam Compaction, Evidence Pool Distillation, Unified Context Budgeting, and Recall Cache Adapter), delivering working test-backed prototypes for the highest-impact candidates (Memory Pruning and Evidence Distillation) alongside empirical token, latency, and accuracy benchmarks across all four options.

Working directory: e:\code\fast-book-learning\.scratch\mobile-agent
Branch: feat/agent-cognee-architecture-optimization
Integrity mode: demo

## Requirements

### R1. Multi-Candidate Investigation & Empirical Benchmark Report
Profile and measure token consumption, time-to-first-token (TTFT), and retrieval latency across turns 1 to 6 under the current baseline. Document the feasibility, quantitative trade-offs, and expected architectural leverage for all four deepening candidates in an empirical evaluation report.

### R2. Prototype: Memory Seam History Pruning & Tool Result Compaction
Implement conversation memory pruning within the Mastra agent layer (agent/src/mastra/agents/chat-agent.ts / memory options) that strips raw verbatim tool results (e.g. 6,000-character book chunks) from earlier conversation turns while preserving message roles, model syntheses, and canonical citation references.

### R3. Prototype: Evidence Pool Sentence Distillation & Density Scoring
Implement extractive sentence-level scoring and distillation at the Python retrieval seam (ui/ask.py / /agent/recall), filtering candidate Cognee passages down to high-density citable evidence spans before crossing the HTTP seam into Mastra, without breaking the canonical citation contract.

### R4. Regression Guard & Contract Verification
Ensure zero regressions against existing mobile chat and reader contracts. The Four-Tier context hierarchy (ADR-0023), interactive reader citations (document <book> (page <N>)), and platform-guaranteed «بیرون از کتاب» markings must remain strictly verified.

## Acceptance Criteria

### Verification & Performance Targets
- [ ] Multi-turn prompt token footprint across a 6-turn dialogue is reduced by at least 50% compared to baseline.
- [ ] Memory pruning retains conversation coherence and citation integrity across follow-up turns without dropping references.
- [ ] Evidence pool distillation reduces returned passage token payload by at least 40% while preserving verbatim sentence boundaries.
- [ ] All existing test suites pass with zero regressions:
  - `npm test --prefix agent`
  - `pytest tests/test_agent_chat.py tests/test_agent_recall.py`
- [ ] New unit and integration tests are added to verify memory pruning and evidence distillation at their respective module interfaces.
- [ ] A final markdown evaluation artifact is produced comparing token, latency, and accuracy metrics for all 4 candidates.
