# Plan 0025: Request Telemetry Dashboard

Spec: `docs/specs/0025-request-telemetry-dashboard.md`

## Global Constraints

- The join key is one id: `request_id = secrets.token_hex(16)` — 32 hex chars, the shape Mastra accepts as `tracingOptions.traceId` (1-32 hex). No second key is invented.
- The id is minted in `serve.py` at the request boundary, before any downstream call.
- The id rides the existing seam bodies; no new endpoint is created for it.
- Cognee's `session_id` is the same id, not a derived one.
- Store migrations use the guarded-ALTER pattern `chat_store.py` already uses, so a rebuild keeps existing rows.
- Tests pin external HTTP contracts, not Studio internals.
- The dashboard page is admin-gated, in the same admin surface that already reads the console and audit stores.
- Studio is a developer-facing view; it is not exposed to learners and is not secured for shared deployment.

### Task 1: The request id, minted at the edge

**What to build:** every learner request gets one identity minted at the session service's request boundary, landed on the ledger row and the chat row. Today a request has three separate identities — the chat row's id, the agent thread, Cognee's session key — and answering "what happened in this one request" means reading three stores by hand.

**Blocked by:** none.

**Acceptance criteria:**
- A request through the agent chat path produces one request id minted before any downstream call.
- The same minting applies to the ask path.
- The ledger row for the request carries the request id.
- The chat row carries the same id.
- Both stores gain the column with the guarded-migration pattern the chat store already uses, so a rebuild keeps existing rows.
- A test runs a request end to end and finds the same id in the ledger row and the chat row.

### Task 2: Mastra observability on, so Studio shows the tree

**What to build:** a request run produces a trace in Mastra's store, visible in Studio at `http://localhost:4111`. Today Mastra records nothing: no observability is configured and `@mastra/observability` is not installed. libSQL carries traces and logs; DuckDB carries metrics, because relational stores do not support metrics.

**Blocked by:** none.

**Acceptance criteria:**
- A request through the agent path produces a trace in the observability store.
- Studio's trace list shows the request.
- The trace detail shows the agent run, the model generations, and the tool calls nested under the root.
- The existing agent tests still pass.

### Task 3: The request id becomes the trace id

**What to build:** the request id minted at the edge becomes the trace id the agent runs under, so Studio's trace list shows the learner's request keyed by the same id the ledger and chat rows carry. The request's phone, book selection, and datasets ride as trace metadata, which Studio renders as trace-list columns.

**Blocked by:** Task 1, Task 2.

**Acceptance criteria:**
- A request through the agent path produces a trace whose trace id is the minted request id.
- The trace list shows the request's phone and dataset as metadata columns.
- The request id in the ledger row matches the trace id in Studio.

### Task 2: Cognee's own UI shows the request

**What to build:** the recall call carries the request id as Cognee's session key, so Cognee writes its session rows under that key and its Sessions page — already in the stack, on port 3000 — shows the request: observations, tool calls, tokens, cost, duration, and the question-and-answer transcript. Zero UI code; the work is stamping the key and confirming Cognee records the turn.

**Blocked by:** Task 1.

**Acceptance criteria:**
- The recall POST carries the request id as Cognee's session key.
- A request run end to end produces Cognee session rows keyed by that id.
- Cognee's Sessions page shows the request with its observations, tool calls, tokens, cost, and duration.
- The session key in Cognee matches the request id in the ledger row.

### Task 5: The request list, admin-gated

**What to build:** one page in the session service listing requests in the shape of Cognee's Activity page — one row per request (time, phone, question, datasets, duration, tokens, Toman cost, status, request id), with date, phone, dataset, and status filters reflected in the URL so a view can be shared. Cognee's Activity page is a Cognee Cloud feature and renders a notice in the local UI, so this list is ours to build.

**Blocked by:** Task 1, Task 2.

**Acceptance criteria:**
- The page lists one row per request with the fields above.
- Filters by date, phone, dataset, and status work, and the filtered view is reproducible from the URL.
- The page is admin-gated: an unauthenticated caller gets the standard 401, a logged-in non-admin gets the console's 403.
- A test drives the page's renderer with plain dicts and pins the markup, the console's pattern.

### Task 6: The request view, the join

**What to build:** clicking a row opens that request's full record joined by the request id — the Mastra span tree read over HTTP, Cognee's rows for the session key, the ledger entry, the citations and answer text, and the guard verdict that gated the request. This is the page that answers "what happened in this one request".

**Blocked by:** Task 1, Task 2, Task 5.

**Acceptance criteria:**
- Opening a request shows the joined record for its request id.
- The trace, the Cognee rows, the ledger entry, and the chat row all carry the same id.
- The trace is downloadable as JSON.
- A request run end to end produces one id present in the ledger row, the chat row, Cognee's session rows, and the Mastra trace. That is the acceptance check.
