# ADR 0018 — The chat becomes a free Mastra agent: Cognee and web search as its tools, launch-critical by 8 Oct

Date: 2026-10-04
Status: accepted
Amends: ADR-0014 (the retrieval-only ask), ADR-0002 (model routing for the chat path), ADR-0017 (the launch build surface)
Builds on: ADR-0016 (Mastra top layer, Cognee demoted to the agent's retrieval tool)

## Context

The PM asked (2026-10-04) for a Mastra agent in کتاب‌خوان: Cognee as its book-retrieval tool, a conversational chat environment for the Learner, internet search, models via Avalai. ADR-0016 had already fixed the architecture — Mastra as the TS top layer, Cognee as the retrieval tool behind the Python seam, AvalAI reachable as the model gateway — but framed it for Learning mode; mode 1's chat was still ADR-0014's retrieval-only ask (the Quote selection is the ONLY first answer, no LLM prose anywhere), and no TS layer existed in the repo.

Four edges were put to the PM in the Wayfinder #18 grill and answered 2026-10-04: free conversational answers, agent-judged web search, launch-critical timing, and the model. Verified live the same day: Avalai is OpenAI-compatible at `https://api.avalai.ir/v1` (Bearer `AVALAI_API_KEY`); the exact model id `deepseek-v4.1-flash` is on the DeepSeek provider page; web search ships two ways — the built-in `web_search` tool on the Responses API (`tools: [{"type": "web_search"}]`, `search_context_size`, domain filters, inline `url_citation` annotations) and the raw `/v1/search` endpoint for results without synthesis.

## Decision

- **The chat surface is a free conversational Mastra agent.** The Learner's message goes to the agent; Book retrieval (Cognee's `only_context` hybrid pool through the Python seam) and web search are parallel tools the agent calls as it judges; the model composes its answer freely, citations best-effort. This **supersedes ADR-0014's retrieval-only contract for the chat surface**: the agent's answer is the first answer, the Quote selection and the honest-note/empty-pool fallbacks retire from that surface, and the picker/phase-2 writer stop gating what the Learner sees. ADR-0014's other legs stand unchanged: the conversation is durable (the `chats.sqlite3` pattern — a reload restores without re-billing), Account-guarded, and a new ask still aborts in-flight work for that phone.
- **Web search is an agent-judged tool, marked.** The agent decides when the Book pool cannot answer and searches; web-sourced parts of the answer render under a visible «بیرون از کتاب» marking (inline web citations render as visible links — Avalai's display requirement). This is not Research Mode: the guided research conversation (ADR-0008/0009) stays hidden per ADR-0017.
- **Launch-critical by 2026-10-08.** The agent ships with the 100-user launch; the current quotes-chat does not carry 8 Oct alone. The capacity bar extends to what it always meant: 100 concurrent chat asks are now 100 concurrent agent answers (model turn + tool rounds), and the load rehearsal runs the agent path. The Question window meters the agent: each Learner message that receives an agent answer is one Question, inside 30 per 5 hours.
- **The chat agent's model is `deepseek-v4.1-flash` via Avalai** (PM choice, 2026-10-04). The user-facing chat returns to Avalai from Z.AI's GLM Coding Plan (ADR-0002), retiring that ADR's "coding plan is for coding tools" scope risk for the chat path. The Cognee-internal model split (`glm-5.3-flash` / `glm-5.3`) is unchanged by this ADR.

## Considered options

Each was put to the PM in the #18 grill and answered 2026-10-04:

- **Cited-book-first agent** (LLM prose only over the cited pool, web only on a miss) — rejected: the PM chose free conversation over the citation-mandated posture.
- **Quotes stay the only first answer, agent on follow-ups** — rejected: a two-step first-answer UX.
- **Learner-facing web toggle (default off)** — rejected: agent-judged search with marking is the simpler UX.
- **After 8 Oct / dark-launch behind a flag** — rejected: the agent is launch-critical.
- **GLM-5.3 / GPT-6 family / Claude Sonnet 5.5 / Gemini 3.8 Flash** — rejected: `deepseek-v4.1-flash`.

## Consequences

- A TypeScript service enters the four-day build surface beside signup/OTP/ZarinPal/notes/TTS/capacity/waitlist; schedule risk concentrates further, and the agent service is on the launch critical path (ADR-0017's build list is amended by this ADR).
- A Question's unit economics change: one Question may burn several model calls (the agent turn, tool rounds, a web search) against the 490,000-Toman Subscription; the meter counts Questions, not tokens, so cost monitoring belongs to the Admin console's spend view.
- ADR-0016 called the citation-honest hybrid pool the differentiation; the PM accepts free prose with best-effort citations. The pool remains the agent's primary tool, and the provenance panel (ADR-0007) keeps its role for Book-sourced parts of an answer.
- Web-search route is a build-time verification: the hosted `web_search` tool (Responses API) if `deepseek-v4.1-flash` supports it there, else the raw `/v1/search` endpoint wrapped as the agent's own tool. Either way the marking is the sheet's, not the model's.
- CONTEXT.md gains the Chat agent (عامل گفت‌وگو) entry and the «بیرون از کتاب» marking; the Quote selection's first-answer role is marked superseded by this ADR.
