# ADR 0016 — Mastra is the top layer; Cognee becomes the agent's retrieval tool

Date: 2026-10-03
Status: accepted
Builds on: ADR-0001 (Cognee memory on Postgres), ADR-0002 (GLM via AvalAI), ADR-0008/0009 (the journey layer and its skills), ADR-0014 (the retrieval-only seam)

## Context

The 2026-10-03 product decisions — the two-mode app (#1) and the learning-job definition (Wayfinder #5, PM-confirmed) — require an engine the current stack was never shaped for. Learning mode runs a multi-week pedagogy loop per Learner: a calibration-derived schedule, +1/+7/+30 retrieval timing, judging of productions against citable pages, a mind map rendered from multimodal input (text, audio, photographed Farsi handwriting), and a coach that guides then reveals. Half of that loop is deterministic automation; half is agent behavior that uses tools and never produces the Learner's content.

The live stack is Python: Cognee on Postgres (ADR-0001) carrying the hybrid retrieval lanes and citation machinery (ADR-0006, ADR-0014), GLM via AvalAI (ADR-0002), the sheet UI, Accounts/Balance/Tariff (ADR-0013). ADR-0001 framed Cognee itself as "the prebuilt agent"; the sheet hand-drives every phase. Nothing in it owns long-running per-Learner workflow state (calendars, ledgers, schedules), and the deadline (19 Shahrivar 1406, mode 1 at 100% for ≥1,000 users) does not buy a rewrite of the retrieval core — the citation-honest hybrid pool is the differentiation (research #6) and it already runs in production.

## Decision

- **Mastra (TypeScript) is the product's top layer.** Mastra **workflows** own the deterministic automation of the protocol — calibration derivation, session scheduling, retrieval-ladder timing, judging pipelines — and are callable as tools. Mastra **agents** own the coaching/examining behavior: the pre-reading interviewer, the Confusion-Compass keeper, the منتقد/قاضی of مباحثه/آموزش, the guide-then-earned-reveal answerer, the mind-map renderer.
- **Cognee is demoted from agent to retrieval tool.** The Mastra agent calls Cognee's search API for passages over the Book set — the same `only_context` hybrid seam ADR-0014 already uses — and every judgment cites what it returns. The Python service keeps the memory/retrieval/citation core (ADR-0001 unchanged in substance) and keeps serving mode 1's ask path, the Books, and the Accounts/Balance/Tariff surfaces.
- **Two services, one seam.** The TS layer talks to the Python core through the retrieval/citation API; it does not duplicate memory, embeddings, or citation logic. GLM via AvalAI (ADR-0002) remains the model, now called from the Mastra agents.

## Considered options

- **Full TS rewrite of the backend on Mastra** — rejected: rewrites the proven citation core against the launch deadline; the differentiation survives the rebrand precisely because it stays.
- **Build the learning loop inside the Python sheet** — rejected: the pedagogy loop is workflow-plus-agent shaped; the sheet has no workflow engine, and a hand-rolled scheduler/agent loop in `serve.py` recreates Mastra worse.
- **Keep Cognee's own agent layer on top (ADR-0001's original framing)** — rejected: its completion-layer assistant machinery is a cache, not orchestration (probed in ADR-0014); it cannot own durable per-Learner schedules, ledgers, or multimodal intake.
