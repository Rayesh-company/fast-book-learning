# Request Telemetry Dashboard — Implementation Plan

**Goal:** one `request_id` per request, stamped on every record the system writes, so a developer opens one request and sees everything that happened inside it.

**Architecture:** `serve.py` mints `request_id = secrets.token_hex(16)` (32 hex = a valid Mastra `traceId`) at the gate, before any upstream call. It stamps that one value on: the Mastra request body's `tracingOptions.traceId` + `requestContext.requestId`; Cognee's `session_id` on the recall POST and the `POST /api/v1/remember/entry` write; the ledger's `usage_entries` row; and the `chat_store` chat/agent-chat row. Mastra's `MastraStorageExporter` persists the span tree into its LibSQL store; Cognee's session cache holds the memory-side rows under the same id. A new admin-gated page in `serve.py` reads all three legs by that id.

**Tech stack:** Python 3.12 (`ui/`, stdlib `urllib`/`sqlite3`), Mastra TS on node 22 (`@mastra/core` 1.74, `@mastra/libsql` 1.25, `@mastra/observability`), Cognee 1.6.3 (HTTP API only), pytest + vitest.

**Spec:** `docs/specs/0025-request-telemetry-dashboard.md` (approved, commit `e492293`). Branch: `feat/request-telemetry-dashboard`.

## Global Constraints

- `request_id = secrets.token_hex(16)` — exactly 32 lowercase hex chars. Mastra accepts `traceId` of 1–32 hex chars.
- **One id, four places.** The same string must appear in the Mastra body, Cognee's `session_id`, `usage_entries`, and `chat_store`. A mismatch is the bug this plan exists to kill.
- **Completion-anchored persistence** (issue #26 rule, unchanged): a failed, stalled, or abandoned stream records and persists nothing. The Cognee QA write follows the same rule — it fires only when an answer completed.
- **The agent seam stays unmetered** (ADR-0018): `/agent/recall` carries `session_id` and nothing else new — no metering, no chat row.
- **Cognee is written through its HTTP API only.** Never touch Cognee's Postgres tables, migrations, or pgvector. Reads of Cognee go through `GET /api/v1/sessions/{id}`.
- **Admin-gated page**, the console's gate verbatim: 401 unauthenticated, 403 for a logged-in non-admin.
- **Farsi copy**, the console's conventions (`ui/console.py`'s `console_html` pattern).
- **Tests pin HTTP contracts at the `urlopen` seam** (`tests/helpers.py`, the scripted-upstream rule) — never Studio internals, never Cognee internals.
- The tariff stays in compose env, never in code (`ui/ledger.py`'s rule).
- No aggregate/business charts — the Admin console owns those.

**Review Focus** — the five failure modes the reviewer must check:
1. An abandoned mid-stream leaves no ledger row, no chat row, and no Cognee write (completion-anchored).
2. Cognee unreachable: the tool returns `{passages: []}` silently today; the request view must show the failure, not a silent empty.
3. The `/ask` path has no Mastra span at all — the join must degrade honestly, not render an empty trace tree as "nothing happened".
4. The same `request_id` must be the value in all four places; a re-minted id per leg is the bug.
4. The `/agent/recall` seam must gain `session_id` without gaining metering or a chat row.
5. The page is admin-gated with the console's exact gate shape (401 unauthenticated, 403 non-admin).

---

## File Structure

| File | Role |
| --- | --- |
| `ui/agent_client.py` | the ONE body both routes carry — gains `request_id` + `tracingOptions` |
| `ui/serve.py` | mints `request_id` at the gate; stamps ledger/chat rows; the Cognee write; the two admin routes |
| `ui/ledger.py` | `usage_entries` gains `request_id` |
| `ui/chat_store.py` | `chats` + `agent_chats` gain `request_id` |
| `ui/ask.py` | `only_context_request` gains `session_id` |
| `ui/telemetry.py` | **new** — Cognee write, Cognee read, Mastra read, the join, the page HTML |
| `agent/src/mastra/observability.ts` | **new** — the observability config |
| `agent/src/mastra/index.ts` | wires `observability` into the Mastra instance |
| `agent/src/mastra/tools/search-books.ts` | carries `requestId` to the seam; records the Cognee span |
| `tests/test_request_id.py` | **new** — the join key, pinned |
| `tests/test_cognee_session_stamp.py` | **new** — Cognee's session leg |
| `agent/src/mastra/observability.test.ts` | **new** — spans land in the store |
| `agent/src/mastra/cognee-span.test.ts` | **new** — the Cognee span inside the tool |
| `tests/test_telemetry_page.py` | **new** — the join page |

---

### Task 1: The request id, minted and stamped in Python

**Files**
- Modify `ui/agent_client.py` (`LearnerTurnContext`, `to_request_body`, `from_request`)
- Modify `ui/serve.py` (`/ask` gate at :1507, `_ask` at :1828, `/agent/chat` gate at :1530, `_agent_chat` at :1860)
- Modify `ui/ledger.py` (`_connect`, `record`, `record_size_estimate`, `record_composer_call`)
- Modify `ui/chat_store.py` (`_connect`, `create_chat`, `record_agent_exchange`)
- Create `tests/test_request_id.py`

**Interfaces produced**
- `LearnerTurnContext` gains field `request_id: str = ""`; `LearnerTurnContext.from_request(phone, account, payload, request_id=None)` accepts it.
- `to_request_body()` emits, when `request_id` is set:
  ```python
  body["requestContext"]["requestId"] = self.request_id
  body["tracingOptions"] = {
      "traceId": self.request_id,
      "metadata": {"thread": self.thread_id, "resource": self.resource_id},
      "requestContextKeys": ["datasets", "userProfile", "pageContext", "selectionText"],
  }
  ```
  (`traceId` accepts 1–32 hex; `metadata` lands on the root span; `requestContextKeys` are dot-notation keys copied into span metadata.)
- `ledger.record(account, kind, input_tokens, output_tokens, metered, request_id=None)`; `record_size_estimate(account, kind, input_bytes, request_id=None)`; `record_composer_call(account, kind, prompt, reply, request_id=None)` — all pass `request_id` through to `record`.
- `ui/ledger.py::_connect` guarded ALTER: `if "request_id" not in columns: ALTER TABLE usage_entries ADD COLUMN request_id TEXT` (the existing `web_sourced` pattern at `ui/chat_store.py:54-65` is the pattern to copy).
- `ui/chat_store.py::_connect` guarded ALTER adds `request_id TEXT` to `chats` and `agent_chats`; `create_chat(chat_id, phone, question, datasets, sources, request_id=None)`, `record_agent_exchange(phone, thread_id, question, answer, web_sourced, sources, request_id=None)`.
- `ui/serve.py`: `/ask` mints `request_id = secrets.token_hex(16)` **before** `record_size_estimate` (:1507) so the ledger row carries it; `_ask` passes `session_id=request_id` to `ask_pool` and `request_id` to `create_chat`, and the reply gains `"request_id": request_id`. `/agent/chat` mints `request_id` before `LearnerTurnContext.from_request`, and at completion `record_agent_exchange(..., request_id=request_id)`.

**Tests** — `tests/test_request_id.py`, on the `tests/test_agent_chat.py` `AgentUpstream` pattern (canned replies at `ui.agent_client`'s urlopen seam, payloads captured):
- `test_the_agent_body_carries_a_32_hex_trace_id` — `payloads[0]["tracingOptions"]["traceId"]` matches `^[0-9a-f]{32}$`.
- `test_the_ledger_row_carries_the_same_request_id` — the `usage_entries` row's `request_id` equals the body's `traceId`.
- `test_the_agent_chat_row_carries_the_same_request_id` — `agent_chats.request_id` equals the body's `traceId`.
- `test_the_ask_ledger_row_carries_the_request_id` — `/ask` records its size estimate with the minted id.
- `test_an_abandoned_stream_stamps_nothing` — the abandoned-stream case (`stream.abort()`) leaves no ledger row, no chat row, no Cognee write.

**Run:** `python -m pytest tests/test_request_id.py -x` then the full suite `python -m pytest -q`.

---

### Task 2: Cognee's session leg — stamp the read, write the answer

**Files**
- Modify `ui/ask.py` (`only_context_request`, `_dataset_passages`, `ask_pool`)
- Create `ui/telemetry.py`
- Modify `ui/serve.py` (`_ask`, `_agent_chat`, `_agent_recall`)
- Create `tests/test_cognee_session_stamp.py`

**Interfaces produced**
- `ui/ask.py::only_context_request(dataset, query, session_id=None)` — the body gains `"session_id": session_id` when set (snake_case, the DTO's field name; the camelCase alias `sessionId` also exists).
- `ui/ask.py::ask_pool(query, datasets=None, session_id=None)` and `_dataset_passages(dataset, query, session_id=None)` pass it through.
- `ui/telemetry.py::write_qa_entry(session_id, question, answer, dataset)` → `POST {COGNEE_URL}/api/v1/remember/entry` with
  ```json
  {"entry": {"type": "qa", "question": "...", "answer": "..."},
   "session_id": "<request_id>", "dataset_name": "<dataset>"}
  ```
  Returns `True`/`False`; never raises — the telemetry must never break an answer. `COGNEE_URL` read at call time, the `ui/ask.py::_recall_url` rule.
- `ui/serve.py::_agent_recall` accepts `session_id` in the tool's body (string, optional) and passes it to `ask_pool`; no metering, no chat row (ADR-0018 unchanged).

**Why the write is needed:** Cognee's DTO says `only_context=True` is *"No LLM call is made and nothing is written to the session"* verbatim. Stamping `session_id` on the recall POST alone leaves Cognee's Sessions page empty — the write path is `POST /api/v1/remember/entry`.

**Tests** — `tests/test_cognee_session_stamp.py`, on the `tests/test_ask.py` `AskUpstream` pattern (scripted upstream at `ui.ask.urlopen`, plus a second scripted seam for the remember POST):
- `test_the_recall_post_carries_the_session_id`
- `test_the_completed_answer_lands_as_a_cognee_qa_entry` — the captured remember body has `entry.type == "qa"`, `session_id` == the minted request id, `question` and `answer` verbatim.
- `test_a_failed_cognee_write_never_breaks_the_answer` — the upstream raises; the answer still lands.
- `test_the_agent_seam_carries_the_session_id_without_metering` — `/agent/recall` with `session_id` returns the pool, no ledger row, no chat row.

**Run:** `python -m pytest tests/test_cognee_session_stamp.py tests/test_ask.py tests/test_agent_recall.py -q`

---

### Task 3: Mastra observability enabled

**Files**
- Modify `agent/package.json` — add `@mastra/observability` (same version line as the other `@mastra/*` deps)
- Create `agent/src/mastra/observability.ts`
- Modify `agent/src/mastra/index.ts`
- Create `agent/src/mastra/observability.test.ts`

**Interfaces produced**
```ts
// agent/src/mastra/observability.ts
import { Observability, MastraStorageExporter, SensitiveDataFilter } from "@mastra/observability";

export const observability = new Observability({
  configs: {
    default: {
      serviceName: "chat-with-books",
      exporters: [new MastraStorageExporter()],
      spanOutputProcessors: [new SensitiveDataFilter()],
    },
  });
```
`agent/src/mastra/index.ts` gains `observability` on the `new Mastra({...})` — the existing `LibSQLStore` stays the single store (LibSQL supports the `observability` domain; metrics are out of scope, so no DuckDB). `MastraStorageExporter` picks libSQL's preferred strategy (`batch-with-updates`) automatically; do not override it.

**Test** — `agent/src/mastra/observability.test.ts` (vitest, the `agent/src/mastra/stream-shape.test.ts` pattern): build the Mastra instance with the observability config, run `chatAgent.generate()` with `tracingOptions: {traceId: "0123456789abcdef0123456789abcdef"}`, then read the store's observability domain (`store.getStore("observability").getTrace({traceId})`) and assert the trace exists with that traceId and a `tool_call` span for `search-books`.

**Run:** `cd agent && npx vitest run src/mastra/observability.test.ts`

---

### Task 4: Cognee's work as a span inside the tool

**Files**
- Modify `agent/src/mastra/tools/search-books.ts`
- Create `agent/src/mastra/cognee-span.test.ts`

**Interfaces produced**
- The tool reads `requestContext.get("requestId")` and sends it as `session_id` in the `POST {PYTHON_CORE_URL}/agent/recall` body: `JSON.stringify({ query, datasets: selection, session_id: requestId })`.
- Around the fetch, a child span on the tool's own span:
  ```ts
  const span = context.tracing?.currentSpan?.createChildSpan({
    type: "generic",           // SpanType.GENERIC — the documented escape hatch
    name: "cognee-recall",
    metadata: { request_id: requestId, datasets: selection },
    input: { query },
  });
  ```
  On a non-OK response or a thrown fetch, `span.error({ error: ..., attributes: { status: "error", status_code: res.status } })`; on success `span.end({ output: { passages: n }, attributes: { passage_count: n, status: "success", latency_ms } })`. The tool's silent `{passages: []}` failure (`search-books.ts:78-82`) becomes visible in the trace.
- `context` is the execute second argument (`ToolExecutionContext` extends `Partial<ObservabilityContext>` → `tracing.currentSpan`); the current signature is `execute: async ({ query, datasets }, { abortSignal, requestContext })` — add `tracing` to the destructure.

**Test** — `agent/src/mastra/cognee-span.test.ts`: run the tool with a canned fetch (the seam's shape from `stream-shape.test.ts`), assert the child span record carries `type: "generic"`, `name: "cognee-recall"`, `metadata.requestId` = the minted id, and `attributes.passage_count`; a second case pins the failure path records `status: "error"`.

**Run:** `cd agent && npx vitest run src/mastra/cognee-span.test.ts`

---

### Task 5: The join page in `serve.py`

**Files**
- Extend `ui/telemetry.py` (readers + HTML)
- Modify `ui/serve.py` (routes + gate)
- Create `tests/test_telemetry_page.py`

**Interfaces produced**
- `telemetry.recent_requests(limit=50, day=None, phone=None, dataset=None, status=None) -> list[dict]` — newest first, from `chat_store.agent_chats` + `chat_store.chats` + `ledger.usage_entries` joined on `request_id`: `{request_id, ts, account, question, cost_toman, metered, has_answer, cognee_status}`.
- `telemetry.request_view(request_id) -> dict` — the five legs:
  - `ledger`: the `usage_entries` rows for that id
  - `chat` / `agent_chat`: the question, answer, sources, web_sourced
  - `cognee`: `GET {COGNEE_URL}/api/v1/sessions/{request_id}` (Cognee's sessions route, verified live)
  - `mastra`: `GET {AGENT_URL}/api/observability/traces/{request_id}` (the built server's route, `observability.cjs:255`; LibSQL supports `getTrace`, not `trace-query`, so the route is the trace-by-id route, not `POST /traces/query`) — the span tree, and the model spans' real `promptTokens`/`completionTokens` attributes (spec story 3: real usage, not the `ceil(len/3)` estimate).
  - `window`: the question-window state that gated the request (`ui/question_window.py::window_state`, read at the request's own `ts`).
  Every leg degrades honestly: a missing leg renders as an explicit "no record" note, never a silent empty.
- `telemetry.request_json(request_id) -> dict` — the same joined record as plain JSON (spec story 7, "attach it to a bug report"), served at `GET /admin/requests/<id>/trace.json`.
- `telemetry.telemetry_list_html(...)`, `telemetry_detail_html(view)` — the Activity-shaped list (time, request id, question, Book set, cost, answer, Cognee status) and the detail page, in the console's Farsi conventions (`ui/console.py`).
- `ui/serve.py` routes: `GET /admin/requests` (list), `GET /admin/requests/<request_id>` (detail), `GET /admin/requests/<request_id>/trace.json` (JSON), gated by the console's gate pattern (`_admin_gate` at `ui/serve.py:2400`): 401 unauthenticated, 403 non-admin, admin-only, audited on read like the console's reads.
- **Filters in the URL** (spec story 4): `GET /admin/requests?day=YYYY-MM-DD&phone=…&dataset=…&status=…` — the filter values render back into the form, so a shared URL reproduces the exact view.


**Tests** — `tests/test_telemetry_page.py`, on the `with_gate`/`AskUpstream` pattern:
- `test_the_page_is_admin_only` — a learner gets 403, an unauthenticated caller gets 401.
- `test_the_list_shows_the_request_by_its_id` — after an `/agent/chat`, the list shows the minted request id.
- `test_the_detail_joins_all_five_legs` — canned ledger/chat/Cognee/Mastra upstreams; the page shows the question, the cost, the Cognee session, the span list, and the window state.
- `test_the_real_tokens_are_the_models_not_the_estimate` — a canned Mastra trace whose model span carries `promptTokens: 2400` renders 2400, not the `ceil(len/3)` estimate.
- `test_the_filters_survive_the_url` — `?day=…&phone=…&dataset=…&status=…` filters the list and renders back into the form.
- `test_the_trace_downloads_as_json` — `GET /admin/requests/<id>/trace.json` returns the joined record as JSON.
- `test_a_missing_leg_says_so` — Cognee unreachable and no Mastra trace: the page renders the honest absence, not a blank.
- `test_the_page_never_breaks_the_answer` — telemetry read failures are confined to the page.


**Run:** `python -m pytest tests/test_telemetry_page.py -q`

---

### Task 6: Studio in the container, and the wiring

**Files**
- Modify `agent/Dockerfile` (`mastra build --studio`, `MASTRA_STUDIO_PATH`)
- Modify `compose.yaml` (the `agent` service env)
- Modify `compose.mobile.yaml` (`AGENT_URL` for the join page's trace read)

**Changes**
- `agent/package.json` build script: `mastra build --studio` → `.mastra/output/studio` exists.
- `agent/Dockerfile`: `ENV MASTRA_STUDIO_PATH=/app/.mastra/output/studio` so the production server serves Studio at `:4111` (the documented pattern: `MASTRA_STUDIO_PATH=.mastra/output/studio node .mastra/output/index.mjs`).
- `compose.yaml` `agent` service gains `MASTRA_STUDIO_PATH`; the `frontend`'s `ui` profile stays as Cognee's own UI on `:3000` (unchanged).
- The join page reads the trace over the container network: `AGENT_URL` (default `http://127.0.0.1:4111`, `http://chat-with-books-agent:4111` in the mobile stack). The agent container publishes no host port today (`4111/tcp` only) — the join page reads it container-to-container; a developer who wants Studio in the browser needs a published port, which the plan adds as `127.0.0.1:4111:4111` on the `session` profile.

**Verification (no unit tests — this is deployment wiring):**
1. `docker compose build agent` then `docker compose up -d agent`.
2. One `/agent/chat` through the sheet.
3. `GET http://<agent>:4111/api/observability/traces/<request_id>` returns the span tree.
4. `http://<agent>:4111` serves Studio with the trace visible.
5. Cognee's `/sessions` page shows the session id.

---

### Task 7: End-to-end proof against the live stack

**Files**
- Create `tests/test_telemetry_live.py` (skipped unless `TELEMETRY_LIVE=1`)

**Test** — the full loop against the running containers, the only test that touches real Cognee and real Mastra:
- `test_one_request_is_one_id_everywhere` — mint via a real `/agent/chat`, then assert: the Mastra trace with that id exists; Cognee's `GET /api/v1/sessions/{id}` returns the session; Cognee's `cache_qa_entries` has a row for that `session_id`; the ledger row and the `agent_chats` row carry the same id.

This is the spec's acceptance test. It is opt-in (`TELEMETRY_LIVE=1`) so the suite stays hermetic on the fakes.

---

## Out of Scope (unchanged from the spec)
Aggregate/business charts (the Admin console covers them), Cognee's cloud-only Activity/Analytics/Memory Coverage pages, modifying Cognee's tables/migrations/pgvector, exposing Studio to learners, DuckDB/ClickHouse metrics.
