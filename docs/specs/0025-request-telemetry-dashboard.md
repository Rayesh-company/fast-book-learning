# Spec 0025: Request Telemetry Dashboard (One Request Id Across Mastra, Cognee, and the Ledger)

## Problem Statement

One learner request runs through three services, and today it has **three separate identities with no shared key**. `serve.py` mints `chat_id = secrets.token_hex(8)` for `/ask` and a thread id `learner-{phone}` for the agent path; the ledger records the request as a `usage_entries` row keyed by account and day; Cognee records its retrieval in Postgres session tables keyed by its own `session_id`. Nothing in any of the three carries the others' key, so answering "what happened in this one request" means reading three stores by hand and guessing at the alignment.

The request-side detail that a developer needs is **not recorded at all**:

- No request id, no timings, no latency for any hop.
- No record of the Cognee call: which dataset, which search type, how many passages came back, which passages the model actually saw. `search-books` swallows its own failures and returns `{passages: []}` silently ([search-books.ts:48-56](../../agent/src/mastra/tools/search-books.ts)).
- No token counts for the agent path. The ledger's tokens are the `ceil(len/3)` estimate, not the model's real usage ([ledger.py](../../ui/ledger.py)).
- Mastra records **nothing**: `new Mastra({ agents: { chatAgent }, storage: new LibSQLStore(...) })` with no observability configured, and `@mastra/observability` is not installed ([agent/src/mastra/index.ts](../../agent/src/mastra/index.ts), [agent/package.json](../../agent/package.json)).
- Cognee's own dashboard shows nothing for our requests: its Sessions page is populated by recall calls that carry a `session_id` ([sessions.md](https://docs.cognee.ai/cognee-cloud/ui/sessions.md)), and our recall POST sends `searchType`, `query`, `datasets`, `includeReferences`, `only_context` — no session id ([ask.py:70-92](../../ui/ask.py)).

## Solution

**One request id, minted at the edge, stamped on every hop.** `serve.py` mints `request_id = secrets.token_hex(16)` — 32 hex chars, exactly the shape `tracingOptions.traceId` accepts (1-32 hex chars, [reference-agents-generate.md:219](../../agent/node_modules/@mastra/core/dist/docs/references/reference-agents-generate.md)) — and carries it to all three stores. Studio becomes the trace viewer; Cognee's own UI becomes the memory-side view; a page in `serve.py` is the join.

### 1. The request id

`request_id` is minted at the entry of `/agent/chat` and `/ask` in `serve.py`, before any downstream call, and stamped on:

- the Mastra call, as `tracingOptions.traceId` plus `tracingOptions.metadata` (`phone`, `chat_id`, `datasets`) — Studio renders metadata keys as trace-list columns ([docs-studio-observability.md:101](../../agent/node_modules/@mastra/core/dist/docs/references/docs-studio-observability.md));
- the Cognee recall POST, as `session_id` — Cognee's own first-class key, which is what populates its Sessions page;
- the ledger row, as a new `request_id` column on `usage_entries`;
- the chat row, as a new `request_id` column on `chat_store.chats` and `chat_store.agent_chats` (the guarded-ALTER migration pattern the store already uses for `agent_chats`).

The id is the join key. Nothing else in the design invents a second key.

### 2. Mastra observability, so Studio shows the tree

Install `@mastra/observability` and `@mastra/duckdb`; route the `observability` domain and add `MastraStorageExporter` with the `realtime` strategy (libSQL supports the observability domain and is the documented local-development choice; libsql docs: *"libSQL supports observability and is ideal for local development"* ([integrations-databases-libsql.md:159](../../agent/node_modules/@mastra/libsql/dist/docs/references/integrations-databases-libsql.md))). Metrics — token totals, cost, p50/p95 latency — require an OLAP store; relational stores do not support metrics ([docs-studio-observability.md:95](../../agent/node_modules/@mastra/core/dist/docs/references/docs-studio-observability.md)), so DuckDB carries metrics and libSQL carries traces and logs.

Studio runs at `http://localhost:4111` in `mastra dev` (the `dev` script in [agent/package.json](../../agent/package.json)). The production container runs the built server ([agent/Dockerfile:30](../../agent/Dockerfile)), so Studio is a developer-facing view, not a deployed surface.

### 3. Cognee's detail inside the trace

The `search-books` tool already wraps the Cognee HTTP call, so it is the natural parent span. Inside the tool, the Cognee call gets its own span carrying: the dataset, the search type, the query Cognee saw, the number of passages returned, each passage's length and `Page N:` marker, the latency of the call, and the failure path that today returns `{passages: []}` silently. The span is written from inside Mastra, so no Python-side span writing is needed.

### 4. Cognee's own UI for the memory side


Stamping `request_id` as Cognee's `session_id` makes Cognee write its session rows keyed by that id, and Cognee's own UI — `cognee/cognee-ui`, already in the stack as `chat-with-books-ui` on port 3000 under the `ui` profile ([compose.yaml:315-329](../../compose.yaml)) — shows the session: observations, tool calls, tokens, cost, duration, the Q&A transcript, per-turn feedback. Zero UI code.

The honest limit: Cognee's **Activity, Analytics, and Memory Coverage pages are Cognee Cloud features**; in the local UI they render *"Build your own dashboard from the API, or use the hosted one in Cognee Cloud"* ([local-ui.md](https://docs.cognee.ai/cognee-cloud/local-ui.md)). The request-level list must be built; Cognee will not hand it to us.

### 5. The join page, in `serve.py`

A page in the session service, admin-gated, in the shape of Cognee's Activity page:

- **Request list**: one row per request — time, phone, question, datasets, duration, tokens, Toman cost, status, request id. Filters: date, phone, dataset, status. Filters reflected in the URL so a view can be shared.
- **Request view** (click a row): the request's full record, joined by `request_id` —
  - the Mastra trace: the span tree (agent run → model generations → tool calls → memory operations), read via `POST /api/observability/traces/query` container-to-container, the same shape as `AGENT_URL` ([trace-query reference](../../agent/node_modules/@mastra/server/dist/docs/references/reference-observability-tracing-trace-query.md));
  - Cognee's rows for that `session_id`, read from Postgres;
  - the ledger entry (tokens, Toman cost);
  - the citations and the answer text from `chat_store`;
  - the guard verdict and the question-window state that gated the request.

The page is admin-gated, in the same admin surface that already reads the console and audit stores ([serve.py:2296-2378](../../ui/serve.py)).

## User Stories

1. As the developer, I want to open one request and see every hop in order — the question, the Cognee call, the model calls, the tool calls, the answer — so that I can find where a request went wrong.
2. As the developer, I want to see which passages Cognee returned and which ones the model actually saw, so that I can tell a retrieval failure from a model failure.
3. As the developer, I want the Cognee call's latency and the model's real token usage recorded per request, so that "slow" and "expensive" are measurable claims, not guesses.
4. As the developer, I want to filter requests by phone, dataset, date, and status, so that I can find the one I am debugging.
5. As the developer, I want the Toman cost of one request next to its token counts, so that I can evaluate the tariff against what the request actually cost.
6. As the developer, I want Cognee's own session view for the same request, so that I see the graph-side detail in Cognee's own words.
7. As the developer, I want a request's full trace as JSON, so that I can attach it to a bug report.
8. As the developer, I want the join to work for the `/ask` path and the `/agent/chat` path, so that both request shapes are debuggable.

## Implementation Decisions

- **The join key is minted in Python, not in Mastra.** `serve.py` owns the request boundary, so `serve.py` mints the id. Mastra accepts an incoming trace id (`tracingOptions.traceId`, 1-32 hex) and nests its root span under it ([reference-agents-generate.md:219-221](../../agent/node_modules/@mastra/core/dist/docs/references/reference-agents-generate.md)).
- **The id rides the existing seam bodies.** `agent_client.py`'s `to_request_body()` is the one body both routes carry ([agent_client.py:212-231](../../ui/agent_client.py)); `tracingOptions` is added to it, and `requestContextKeys` extracts the keys Studio should show.
- **Cognee's `session_id` is the same id**, not a derived one. Cognee's session cache is keyed by `(user_id, session_id)` and its Sessions UI reads that key ([sessions-and-caching](https://docs.cognee.ai/core-concepts/sessions-and-caching.md)).
- **The ledger and chat stores gain a `request_id` column**, with the guarded-ALTER migration pattern `chat_store.py` already uses for `agent_chats`.
- **The join page lives in `serve.py`**, admin-gated, beside the existing console and audit reads. It reads Mastra over HTTP, Cognee over Postgres, and the ledger/chats over SQLite. It does not duplicate any of their logic.
- **Studio is the raw span viewer**, not the product surface. The join page links to Studio for a request.

## Testing Decisions

- **External behavior only**: tests pin the HTTP contracts — that `/agent/chat` sends `tracingOptions.traceId` with the minted id, that the recall POST carries `session_id`, that the ledger row carries `request_id`, that the join page returns the joined record for a known id. No test asserts Studio internals.
- **Prior art**: `tests/test_agent_chat.py` (pins `/agent/chat` and the SSE relay), `tests/test_agent_recall.py` (pins `/agent/recall`), `agent/src/mastra/stream-shape.test.ts` (pins the streaming frames and tool-result records). The new tests extend these seams.
- **The join is tested at the seam, not in the UI**: a request run end-to-end produces one id present in the ledger row, the chat row, Cognee's session rows, and the Mastra trace. That is the acceptance check.

## Out of Scope

- Aggregate charts, revenue views, per-day charts — the Admin console already covers the business views.
- Cognee's cloud-only Activity, Analytics, and Memory Coverage pages. We do not rebuild Cognee's graph canvas.
- Modifying Cognee's internal tables, migrations, or pgvector dimensions.
- Making Studio the product surface, exposing it to learners, or securing it for shared deployment.
- Metrics dashboards beyond what Studio's metrics view gives us for free.

## Further Notes

- Records the developer-facing telemetry gap that ADR-0020 (Mastra top layer, Cognee as retrieval tool) created: two services, one seam, no shared request identity.
- Cognee's Activity page is a Cognee Cloud feature; the local UI renders a notice. The join page is our answer to that page.
