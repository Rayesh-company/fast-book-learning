# Usage evidence from the deployed chat-with-books product

Question (ticket #40): what usage evidence exists from the deployed product — asks, sessions, research turns, Balance consumption on the VPS (http://94.183.176.80:8765, /data stores) — about how people actually used it, especially learning behavior versus one-off Q&A? What is accessible, what is not, and what does the evidence show or not show? No invented numbers.

Researched 2026-10-02. All `file:line` references are to this repo at the current tree; production numbers are **not** reported because the production rows could not be read from this machine (see Accessibility).

## TL;DR

- The product records usage in **six SQLite stores** on the session container's `/data` volume, with schemas fully knowable from source. Asks (quota rows + ledger entries), full ask text + answers (chats store), complete research-session state and transcripts (research store), per-call token/Toman metering (ledger), and Accounts + Balance (accounts store) are all recorded by design.
- The deployed service **is up** at http://94.183.176.80:8765 (read-only probes: `/livez` → 200 `ok`, `/health` → 200 `{"status":"ready","health":"healthy","version":"1.5.4-local"}`), and every data-bearing endpoint correctly refuses anonymous reads (401).
- **No production usage rows were read from this machine.** No VPS credentials (SSH host/user/key) are documented anywhere in the repo, and the operator-side backup directory `D:\code\CHATBOT\backups` named in the README does not exist on this machine. That is the key gap. This file therefore delivers the evidence inventory plus the exact read-only extraction procedure to run on the VPS.
- Probe evidence indicates the **deployed build is older than this repo tree** (it lacks the `/chat/latest` route, i.e. it predates the ask chat store, ADR-0014) — so `chats.sqlite3` (the ask-question text) very likely does not exist yet on the VPS. Production ask evidence then rests on the quota rows and the ledger, not on stored question text.
- One incidental ops finding: port **8765 is publicly reachable on the bare IP** today, which contradicts the README's "nothing binds a public port anymore (2026-09-10)" — worth an owner's look, independent of this ticket.

## 1. What the product records (evidence inventory)

All stores are single-file SQLite DBs living on the `session_quota` Docker volume, mounted at `/data` in the session service (`compose.yaml:210-211`, `compose.yaml:181-209` sets each path). Every store opens per request (`timeout=5`) and creates its table on first touch, so the files exist wherever the service has run.

### 1.1 `/data/usage.sqlite3` — the ask counter (quota store)

- Module: `ui/quotas.py` (`QUOTA_DB`, `ui/quotas.py:21-25`; table `chats (phone TEXT, day TEXT)`, `ui/quotas.py:43-45`).
- One row = **one ask that passed the gate**, written by `record_chat` (`ui/quotas.py:61-69`), called once per ask at the gate (`ui/serve.py:836`). The gate enforces `DAILY_CHAT_LIMIT = 5` asks per phone per server-local day (`ui/quotas.py:20`); the Quoted answer of an ask does not add a second row.
- Semantics: this is the coarsest ask-volume series — per phone, per day. It does **not** store the question text.
- Identity: rows are keyed by the Account's attached phone, normalized 10–13 digits (`ui/quotas.py:31-34`, resolver at `ui/serve.py:430-456`).

### 1.2 `/data/chats.sqlite3` — the ask chat store (full question + answer text)

- Module: `ui/chat_store.py` (`CHAT_DB`, `ui/chat_store.py:24-28`; table `chats`, `ui/chat_store.py:33-40`).
- Columns: `id` (ask id), `phone`, `question` (the ask's text), `datasets_json` (Book selection), `sources_json` (retrieval pool), `selections_json` (Quote selection), `blocks_json` (Quoted answer blocks), `truncated`, `created_at`, `updated_at`.
- One row = **one complete ask sheet**. Writes: created at ask time (`ui/serve.py:1151`), pool updated incl. recall-more widening (`ui/serve.py:1236`, `ui/chat_store.py:107-110`), Quote selection (`ui/serve.py:1289`), Quoted answer (`ui/serve.py:1115`).
- All rows persist; only the newest per phone is served to the UI (`latest_chat`, `ui/chat_store.py:142-168`). So the table is a **full ask archive** even though the product only ever shows the latest.
- Caveat: added by ADR-0014 — and the deployed build appears to predate it (see §3), so this store may be absent in production.

### 1.3 `/data/research.sqlite3` — Research Mode sessions and transcripts

- Module: `ui/research_store.py` (`RESEARCH_DB`, `ui/research_store.py:31-35`).
- Table `research_sessions (id, phone, state_json, created_at, updated_at, version)` (`ui/research_store.py:80-95`): one row per research session; `state_json` holds the whole investigation state — `turns` counter (`ui/research.py:716`), stage, map (destination / fog / out-of-scope), subquestions with statuses, claims ledger, evidence ledger, brief plan versions, section contracts, the standing Brief document (`brief_document.complete` / sections, `ui/research.py:703`), closing-review versions (`ui/research.py:708`), `closed` (`ui/research.py:717`).
- Table `research_messages (id, session_id, role, payload_json, created_at)` (`ui/research_store.py:96-101`): the **full transcript**, append-only, role `user` or `assistant` (`append_message`, `ui/research_store.py:246-265`).
- Behavioral bounds baked in: evidence floor 6 (`ui/research.py:478`), turn cap 40 per session (`RESEARCH_SESSION_TURN_CAP`, `ui/research.py:488`), at most 3 concurrent sessions globally (`ui/research.py:2362`).
- This is the richest learning-behavior source: turns per session, user messages per session, whether a Brief was completed, and the actual research questions asked.

### 1.4 `/data/usage_ledger.sqlite3` — metered spend (Balance consumption)

- Module: `ui/ledger.py` (`LEDGER_DB`, `ui/ledger.py:49-51`; table `usage_entries`, `ui/ledger.py:58-70`).
- Columns: `id` (autoincrement), `phone`, `ts` (full timestamp), `day`, `kind`, `metered` (1 = token counts reported by upstream; 0 = estimated), `input_tokens`, `output_tokens`, `cost_toman`.
- `kind` values and their capture sites:
  - `ask` — one entry per ask, input-side size estimate (`ui/serve.py:987-989` for `/ask`, `ui/serve.py:1009-1011` for the recall proxy route);
  - `writer` — the Quoted-answer composer calls (`ui/serve.py:1020-1024`);
  - `picker` — the Quote-selection calls (`ui/serve.py:1034-1038`);
  - `composer` — recall-more calls (`ui/serve.py:1048-1052`);
  - `turn` — every composer call a Research Mode turn makes (`ui/research.py:4542-4546`).
- Honesty marking: an entry without upstream usage numbers is estimated from text volume at ~3 chars/token and stored `metered=0` (`ui/ledger.py:78-84`, `record_composer_call` `ui/ledger.py:142-162`) — never passed off as measured.
- Tariff: Toman per million tokens from config, defaults input 2,000 / output 8,000 (`ui/ledger.py:31-36`, `compose.yaml:200-201`). Every entry's cost leaves the Account's Balance through exactly one deduction path (`ui/serve.py:311-314` → `deduct_balance`, `ui/accounts.py:237-242`).
- Semantics: this is the **only time-series of spend**, per phone and per kind. `kind='turn'` volume vs `kind='ask'` volume is a direct research-mode-vs-Q&A usage ratio; `metered` splits measured from estimated spend.

### 1.5 `/data/accounts.sqlite3` — Accounts and Balance

- Module: `ui/accounts.py` (`ACCOUNTS_DB`, `ui/accounts.py:32-36`; table `accounts (email PK, password_hash, phone, role, created_at, balance_toman)`, `ui/accounts.py:56-62`).
- Roles: `operator` / `admin` (`ui/accounts.py:46`); no signup — Accounts are Admin-issued only (`ui/accounts.py:8-18`).
- `balance_toman` is the current prepaid Balance (the meter's deductions land here, `ui/accounts.py:218-234`); `created_at` gives account age. **Note:** balance is a level, not a history — the spend history is the ledger (§1.4); top-ups are not separately journaled.

### 1.6 `/data/sessions.sqlite3` — declared but not read by any code

- `compose.yaml:202-209` declares `SESSIONS_DB: /data/sessions.sqlite3` ("The Session store (T27 stage 3)"), but **no module in this tree reads `SESSIONS_DB`** (repo-wide grep: the string exists only in `compose.yaml`). Either the store landed in a tree state not present here, or it is planned-but-unwired config. Treat `/data/sessions.sqlite3` as **not evidence** until confirmed on the VPS.

### 1.7 What is NOT recorded anywhere

- No page-level reading telemetry (Book page views, reading time, reading position) — `/books/` routes serve files, no logging store (`ui/serve.py:544-546`, `549+`).
- No per-user feedback, ratings, or survey data.
- No session-duration metric (research session `created_at`/`updated_at` span is a coarse proxy at best).
- Cognee/Postgres (`cognee_db`, pgvector) holds the ingested Books and retrieval metadata — memory-layer data, **not** user behavior; it is out of scope for usage evidence.

## 2. Production accessibility from this machine

- **VPS location:** the README documents the public deployment on an Ubuntu VPS behind **https://booksai.rayesh-team.ir**, sheet on `127.0.0.1:8765` under systemd unit `cwb-session.service` or the compose `session` profile (`README.md:155-157`), tarball-swap deploys (`README.md:159-161`).
- **No credentials in the repo:** `scripts/pull_backup.ps1` defaults `VpsHost = "CHANGE-ME"` (`scripts/pull_backup.ps1:14`); repo-wide grep finds no VPS IP, hostname, or SSH config documented anywhere. The IP in the ticket (94.183.176.80) appears nowhere in the repo.
- **No local backup copies:** the README says nightly archives are pulled to `D:\code\CHATBOT\backups` on the operator machine (`README.md:176`, `scripts/pull_backup.ps1:17`) — checked 2026-10-02: that path **does not exist on this machine** (`D:\code` exists, `CHATBOT` does not).
- **Not yet accessible from this machine:** production rows. SSH was not attempted (no documented credentials). This is an honest gap, not a finding of absence — the data almost certainly exists on the VPS (the stores auto-create on first use and the service has been running; see §3).
- **Backup coverage gap (evidence risk):** the nightly archive copies only `usage.sqlite3`, `research.sqlite3`, `chats.sqlite3` off `/data` (`scripts/backup.sh:97-99`) — **`accounts.sqlite3` and `usage_ledger.sqlite3` are NOT in the backup**. Balance and spend history exist only on the VPS itself.

## 3. Service-liveness check (read-only HTTP probes, 2026-10-02)

All probes were plain unauthenticated GETs, `-m 10`, no payloads, no mutation.

| Probe | Result |
|---|---|
| `http://94.183.176.80:8765/livez` | 200, body `ok` (2.3 s) |
| `http://94.183.176.80:8765/health` | 200, body `{"status":"ready","health":"healthy","version":"1.5.4-local"}` (1.7 s) |
| `http://94.183.176.80:8765/` | 200, the sheet's `index.html` (247,180 bytes) |
| `https://booksai.rayesh-team.ir/livez` and `/` | 200 (5.0 s) — the nginx-fronted domain also serves the same stack |
| `http://94.183.176.80:8765/auth/me`, `/research/state`, `/research/messages`, `/usage/live` | **401** — every data endpoint refuses anonymous reads; no usage data leaks without an Account |
| `http://94.183.176.80:8765/chat/latest` | **404 static-file error page** — see below |

Two deductions from the probes (facts about the deployment, inference clearly marked):

1. **Deployed build predates the ask chat store.** In this tree `/chat/latest` is a routed, identity-gated endpoint (`ui/serve.py:541-543`, handler `ui/serve.py:1157-1166`) that answers 401 to anonymous calls, like its siblings do on the deployed box. On the deployed box it instead returns the static-handler 404 page (byte-identical shape to an unrouted path), and the served `index.html` contains no `chat/latest` reference (it does contain `usage/live`, `research/turn`, `research/report`, `recall-more`, and the login overlay strings). Inference: the deployed tree predates ADR-0014, so `/data/chats.sqlite3` — and with it the stored ask-question text — likely does not exist in production yet. The Research Mode routes and the usage ledger ARE deployed (their gated endpoints answer 401, the UI references them).
2. **Port 8765 is publicly bound on the bare IP.** README says nothing binds a public port since 2026-09-10 (loopback-only, nginx in front; `README.md:157`). The probes show the bare-IP port answering anyway. Which process owns the bind (systemd unit on 0.0.0.0 vs the compose profile's `0.0.0.0:8765` publish, `compose.yaml:216-217`) cannot be determined from outside; either way it is a live deviation from the documented posture, flagged here for the owner.

## 4. Exact read-only extraction procedure (to run on the VPS)

Read-only throughout: copy or `.backup` the files out, never write into them; run SELECTs only. Two variants depending on how the sheet runs there.

**Step 0 — locate the stores.**

- If the sheet runs as the compose `session` container: the stores are at `/data/*` inside container `chat-with-books-session`; on the host, the volume is `<project>_session_quota`'s mount (README:161 records the VPS compose project as `chat-withbooks`, so expect `/var/lib/docker/volumes/chat-withbooks_session_quota/_data/`).
- If the sheet runs as the systemd unit: `systemctl cat cwb-session.service` → read `EnvironmentFile=` → the `SESSION_UI_QUOTA_DB` / `SESSION_CHAT_DB` / `SESSION_RESEARCH_DB` / `LEDGER_DB` / `ACCOUNTS_DB` / `SESSIONS_DB` values in that file name the actual paths.
- Verify first: `ls -la` the directory — which of the six files exist is itself evidence (per §1.6 and §3.1, expect at most usage / research / ledger / accounts on the deployed vintage).

**Step 1 — snapshot safely** (the service holds these files open; a raw `cp` can catch a mid-write state):

```bash
mkdir -p ~/usage-evidence && cd ~/usage-evidence
for db in usage.sqlite3 chats.sqlite3 research.sqlite3 usage_ledger.sqlite3 accounts.sqlite3 sessions.sqlite3; do
  [ -f "/data/$db" ] && sqlite3 "/data/$db" ".backup '$PWD/$db'"
done
```

(`.backup` is SQLite's online-consistent copy; if the `sqlite3` CLI is missing on the host, use `docker cp chat-with-books-session:/data/<db> .` immediately followed by `sqlite3 <db> 'PRAGMA integrity_check;'`, or `python3 -c "import sqlite3; sqlite3.connect('/data/<db>').execute(\"VACUUM INTO '<out>'\")"`.)

**Step 2 — the queries and what each answers.**

Ask volume and spread (`usage.sqlite3`):

```sql
SELECT day, COUNT(*) FROM chats GROUP BY day ORDER BY day;                 -- asks per day, whole product lifetime
SELECT phone, COUNT(*) asks, COUNT(DISTINCT day) active_days
  FROM chats GROUP BY phone ORDER BY asks DESC;                            -- per-user ask count and active-day count
SELECT COUNT(*) FROM (SELECT phone FROM chats GROUP BY phone
  HAVING COUNT(DISTINCT day) >= 2);                                        -- returning users (came on 2+ days)
```

Ask text and answers, if present (`chats.sqlite3` — repo schema; likely absent on the deployed vintage):

```sql
SELECT created_at, updated_at, phone, question, truncated
  FROM chats ORDER BY created_at;                                          -- every question actually asked, with timestamps
SELECT phone, COUNT(*) FROM chats GROUP BY phone;                          -- asks that completed a sheet row
```

Research Mode depth (`research.sqlite3`):

```sql
SELECT phone, COUNT(*) sessions FROM research_sessions GROUP BY phone;     -- who used Research Mode at all, how often
SELECT id, phone, created_at, updated_at, version,
       json_extract(state_json,'$.turns')            AS turns,
       json_extract(state_json,'$.closed')           AS closed,
       json_extract(state_json,'$.brief_document.complete') AS brief_done
  FROM research_sessions;                                                  -- per-session depth: turn count, completion
SELECT session_id, role, COUNT(*) FROM research_messages
  GROUP BY session_id, role;                                               -- user vs assistant messages per session
SELECT role, payload_json FROM research_messages
  WHERE session_id = '<id>' ORDER BY id;                                   -- one session's full transcript (questions in the user rows)
```

Spend and Balance (`usage_ledger.sqlite3`, `accounts.sqlite3`):

```sql
SELECT kind, metered, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cost_toman)
  FROM usage_entries GROUP BY kind, metered;                               -- spend split ask/writer/picker/composer/turn, measured vs estimated
SELECT day, COUNT(*), SUM(cost_toman) FROM usage_entries
  GROUP BY day ORDER BY day;                                               -- spend time-series
SELECT phone, COUNT(*) entries, SUM(cost_toman) total_toman,
       SUM(kind='turn') research_entries, SUM(kind='ask') ask_entries
  FROM usage_entries GROUP BY phone;                                       -- per-account: total spend, research-vs-Q&A mix
SELECT email, role, created_at, balance_toman FROM accounts;               -- who holds an Account, current Balance
```

**Step 3 — the learning-vs-one-off read of those numbers.** Pre-registered interpretation, so the numbers speak when pulled:

- One-off Q&A signature: quota rows concentrated on single days per phone; `research_entries = 0`; no research sessions.
- Learning-behavior signature: `active_days >= 2` per phone; research sessions with `turns >= 2` (a real investigation, not a first reply); `user`-role message counts > 1 per session; any `brief_done = 1` (a completed Brief is the product's walk-away learning artifact); sustained `kind='turn'` ledger volume per phone across days.
- The ask counts are bounded by design (`DAILY_CHAT_LIMIT = 5`/day, `ui/quotas.py:20`) — ask volume alone can never show heavy use; depth must come from the research store and the ledger.

## 5. Facts vs gaps

Facts (verified):

- Six stores' schemas, locations, and capture semantics, exactly as §1 with file:line refs.
- The deployed service is up on both the bare IP and the booksai domain; data endpoints are auth-gated (401 anonymous); `/health` reports Cognee 1.5.4-local healthy (probe table §3).
- The deployed build lacks `/chat/latest` (static 404) while its siblings 401 — deployed tree predates ADR-0014.
- No VPS credentials documented in the repo; the operator backup directory does not exist on this machine.
- The nightly backup excludes `accounts.sqlite3` and `usage_ledger.sqlite3` (`scripts/backup.sh:97-99`).
- `SESSIONS_DB` is compose-declared but read by no code in this tree.

Gaps (not accessible / not recorded):

- All production usage numbers: not read from this machine — the central gap this ticket surfaces. Nothing above estimates them.
- Ask-question text in production: likely not recorded yet (deployed vintage predates the chat store) — unconfirmable until Step 0 runs on the VPS.
- Reading behavior (page views, time-on-book), user satisfaction, session durations: not recorded by the product at all, on any vintage.
- Balance top-up history: not journaled (only current level + spend ledger).

## Sources

- `E:\code\fast-book-learning\compose.yaml` (lines 152-225: session service, /data store env vars, volume `session_quota`)
- `E:\code\fast-book-learning\ui\quotas.py` (20-25, 31-45, 61-69)
- `E:\code\fast-book-learning\ui\chat_store.py` (24-40, 48-73, 107-168)
- `E:\code\fast-book-learning\ui\research_store.py` (31-35, 78-101, 118-136, 246-265)
- `E:\code\fast-book-learning\ui\research.py` (478, 488, 700-718, 2362, 4536-4548)
- `E:\code\fast-book-learning\ui\ledger.py` (31-51, 56-84, 97-171, 182-219)
- `E:\code\fast-book-learning\ui\accounts.py` (32-46, 53-72, 204-242)
- `E:\code\fast-book-learning\ui\serve.py` (311-316, 430-456, 502-546, 819-836, 963-1080, 1151-1166, 1355-1370)
- `E:\code\fast-book-learning\ui\report.py` (1-22 — the Session report is rendered from the research state, not separately persisted)
- `E:\code\fast-book-learning\scripts\backup.sh` (60-99 — dry-run plan and the three copied stores)
- `E:\code\fast-book-learning\scripts\pull_backup.ps1` (13-19 — `VpsHost = "CHANGE-ME"`, `D:\code\CHATBOT\backups`)
- `E:\code\fast-book-learning\README.md` (155-176 — VPS deploy, public-port posture, nightly backup)
- Live probes (2026-10-02, read-only GET): `http://94.183.176.80:8765/{livez,health,auth/me,research/state,research/messages,usage/live,chat/latest,}`, `https://booksai.rayesh-team.ir/{livez,/}`
