# Usage evidence from the deployed chat-with-books product — assembled and assessed for کتاب‌خوان

Question (Wayfinder ticket [#14](https://github.com/Rayesh-company/fast-book-learning/issues/14)): what does the deployed chat-with-books product's usage evidence actually show, and what does it prove — and not prove — for کتاب‌خوان as a B2C product?

Researched 2026-10-04, from primary sources only. This document supersedes the pre-restart Phase-0 inventory `docs/research/2026-10-02-usage-evidence-chat-with-books.md` (commit `cc73d2d`, old ticket #40): that pass could read no production rows; this one reads two verified VPS snapshots. Per the ticket: regathered from primary sources, nothing trusted from remembered summaries.

**Method.** The DBs named in the ticket (`ui/usage.sqlite3`, `ui/accounts.sqlite3`, `ui/usage_ledger.sqlite3`) do **not exist in the repo working tree** — they are gitignored (`.gitignore:8-10,20`) and never tracked (`git log --all --diff-filter=A -- "*.sqlite3"` is empty). The real evidence is two full VPS backup archives on this machine, extracted to a temp dir and opened read-only (`sqlite3.connect("file:...?mode=ro")`); originals untouched. Every number below comes from a named query against those snapshots; nothing is estimated.

## TL;DR

- Production usage evidence exists and is trustworthy: two MD5-verified snapshots of the VPS's `session_quota` volume (2026-09-19 and 2026-09-28), covering the deployed product's whole observed life 2026-09-14 → 2026-09-27. The ledger reconciles with account balances **to the Toman** for all six accounts — the metering chain works.
- The observed lifetime total is tiny: **37 asks, 15 Research-Mode sessions (78 user messages), 25 ask-side sessions, 3,635 Toman of metered spend** — and the only identifiable humans are the PM (the deepest user: 18-turn research session, 2 active days) and, by strong signal, the operator's own tests. Five of the six accounts are scripted benchmark identities (`bench-*@pilot.local`, created by the PM on 2026-09-27, running the repo's `benchmark/` suite against production). 11 of 13 asker-identities used the product on exactly one day.
- This is **B2B-era usage of a cited-Q&A/research tool** (admin-issued Accounts, operator role, prepaid Balance, Toman tariff, 5-asks/day cap). It says **nothing** about B2C Learner (فراگیر) demand for کتاب‌خوان: of mode 1's four surfaces (free reading, notes, TTS, chat-with-book), **notes and TTS do not exist in the product at all**, free reading has **no telemetry**, and chat-with-book's observed use is 37 asks, mostly operator-side. No external user ever paid, topped up, or returned beyond two days.
- What it does prove: the product ran publicly for two weeks, served real Farsi book-Q&A over two Books, its control plane (Accounts/Balance/Tariff/quotas) worked end-to-end, and Research Mode can hold a human for a 78-minute, 18-turn investigation. That is evidence the **machinery and instrumentation** work — not evidence anyone wants it.
- Data gap: no backup was pulled after 2026-09-28, so 2026-09-28 → 2026-10-04 usage (including the newly deployed ADR-0014 ask-text store) is unobserved from this machine.

## 1. Evidence base and provenance

| Source | What it is | Verified how |
|---|---|---|
| `E:\code\booksai-backup-20260919\download\volume_session_quota.tar.gz` (25,765 B) | VPS `session_quota` volume, 2026-09-19: `usage.sqlite3` (8,192 B) + `research.sqlite3` (163,840 B) | `RESTORE.md` in the same dir: source `ubuntu@94.183.176.80` (https://booksai.rayesh-team.ir), project `chat-with-books`; `SHA256SUMS` verified after transfer |
| `E:\code\booksai-backup-20260928\booksai-session-data-20260928.tar.gz` (169,301 B) | VPS `session_quota` volume, 2026-09-28: all six DBs — `accounts`, `audit`, `research`, `sessions`, `usage`, `usage_ledger` (sqlite3 backup-API snapshots) | `MANIFEST.md` in the same dir: source `ubuntu@94.183.176.80:6041`, MD5 `3763599e083942240184b6e01a747095`, MD5-verified against the server after download |
| Live read-only HTTP probes, 2026-10-04 | Current deployment state | This pass (§6) |
| Git history, `compose.yaml`, README, ADRs, `benchmark/` | Deployment surfaces and timeline | §5, §7 |
| Local Docker volume `chat-with-books_session_quota` | A faithful, untouched local restore of the 09-28 snapshot (container `booksai-session`, created 2026-09-28T08:31Z; file mtimes and row counts identical to the tarball; no local use added after restore) — **not** additional evidence, used only as a cross-check | `docker inspect booksai-session`; volume listing via read-only mount |
| Local Docker volume `chat-withbooks_session_quota` | Old **local-dev** data, pre-VPS: 9 asks on 2026-09-11 (6) and 09-12 (3), file mtime 2026-09-12 — excluded from production numbers below, noted as context | Read-only volume mount, same queries |

Naming note: README:161 records the VPS compose project as `chat-withbooks` (no dash); both backup manifests say `chat-with-books`. Immaterial to the data — the manifests name the host, path, and checksums.

## 2. Timeline — deployments cross-dated against usage rows

| Date | Git (this repo) | Production rows (snapshots) |
|---|---|---|
| 2026-09-11/12 | — | 9 asks on the **local dev** instance only (old volume) |
| 2026-09-14 | — | First VPS asks: 5 (phone-era quota rows) |
| 2026-09-18 | — | Peak phone-era day: 9 asks + all 6 phone-era research sessions |
| 2026-09-19 13:07–23:22 | `0e323b0` ops floor/Session report (T14-T18), `d597b17` restore drill (T15), `a8b66e3` **ADR-0013 Accounts** (T20), `2aee372` sheet report (T19), `bcb345e` **T22 usage capture + tariff**, `5c9291a` **T23 metered research turns + Balance gate** | Snapshot A pulled 12:28–13:05 local (16 asks, 6 research sessions at that point) |
| 2026-09-22 21:46 | `79d174f` Session store rides /data (T27 stage 3) | 1 ask (last phone-era ask) |
| 2026-09-24 | — | `admin_seeded` pm@chat-with-books.ir (audit row) ⇒ Accounts vintage live on VPS |
| 2026-09-25 | — | PM tops own balance +99,999,999 Toman (audit row) |
| 2026-09-26 | — | First ledger row 10:18:38; PM's 4 asks, 11 research turns |
| 2026-09-27 | — | Heaviest day: 16 asks, 107 research turns; PM creates 5 bench accounts 17:25–18:55 and runs the benchmark suite through 22:53 (last ledger row) |
| 2026-09-28 | — | Snapshot B pulled 11:31–11:52 local; local restore drill same day |
| 2026-09-29 00:12 | `1a72db8` **ADR-0014** retrieval-only ask + `/chat/latest` + `chats.sqlite3` | — |
| 2026-10-02 16:07 | `961fc8c` tracker consolidation (GitLab → this GitHub repo) | — |
| 2026-10-03 12:43 | `d468286` two-mode product defined; **کتاب‌خوان re-scoped to mode 1** | — |
| 2026-10-04 | — | Live probes (§6) show `/chat/latest` answering 401 anonymous ⇒ the ADR-0014 vintage is now deployed |

Citation for commit identities: `git log --format="%h %ad %s"` on this repo, 2026-10-04. The 09-28 snapshot contains **no** `chats.sqlite3` (consistent: ADR-0014 postdates it), and the deployed build on 2026-10-02 still lacked `/chat/latest` (static 404, per the superseded Phase-0 doc's probe table) — by 2026-10-04 it answers 401 like its gated siblings.

## 3. Who used it

Six accounts (2026-09-28 snapshot, `accounts` table; `audit` table) and, before Accounts existed, nine phone identities (`usage.chats` rows keyed by phone). Three cohorts:

**Cohort 1 — the operator/PM (the only verifiable human user).** `pm@chat-with-books.ir`, role `admin`, seeded 2026-09-24T18:50:41 (audit `admin_seeded`), self-topped +99,999,999 Toman on 2026-09-25. Used the product on 2 days (2026-09-26, 09-27): 6 asks, 5 ask-side sessions with persisted message rows, 5 research sessions (deepest: 18 turns, stage `synthesizing`, span 10:26→11:44 on 09-27 ≈ 78 min), 71 ledger entries, 1,417 Toman spent. The PM's questions are substantive and varied Farsi religious-studies/research questions on both Books (e.g. «جایگاه عدالت در اندیشۀ قرآنی چیست؟», «نقش امام خمینی در بیداری اسلامی ایران چه بود؟» — `sessions` titles; `research_messages` first user rows).

**Cohort 2 — scripted benchmarks (not users).** Five accounts `bench-simple-{1,2,1b}@pilot.local`, `bench-research-{1,2}@pilot.local`, all created by the PM 2026-09-27 17:25–18:55 (audit `account_created`), each topped exactly 5,000,000 Toman (audit `balance_topped`). Their traffic is mechanical: `bench-simple-1` and `bench-simple-2` each hit the 5-asks/day cap (`ui/quotas.py:20`, `DAILY_CHAT_LIMIT = 5`) with the **same fixed question repeated** per account («کتاب طرح کلی اندیشه اسلامی درباره چیست؟» / «کتاب انسان ۲۵۰ ساله چه ساختی دارد؟» — 20 `sessions` rows, zero persisted messages); `bench-research-1/2` ran fixed research prompts («سیر تحول اندیشه اسلامی از عصر پیامبر تا امروز…», «چهار دوره پنجاه‌ساله زندگی انسان…») 1–3 times each. This matches the repo's `benchmark/` suite (fixed TKI question set, scripted runner — `benchmark/README.md`, `benchmark/questions.json`). On 2026-09-27 the benchmark ran **against production** (these rows live in the VPS snapshot).

**Cohort 3 — phone-era identities, authenticity unverifiable (9 numbers, 2026-09-14 → 09-22).** 16 asks and 6 research sessions, keyed by phone under the pre-Accounts gate. Signals, stated as facts: `09028233998` made 5 asks and 3 research sessions on 09-18, each session repeating **the same question verbatim, same typos included** («تفاوت اصلی رابطه بین پیامبر با امیر المومنیین حصرت علی (ع) … پطور بود ؟ شو آیا …»); `09929731909` (09-14 + 09-18, the only phone-era returning identity) and `09929731905` (09-18) opened research sessions with that **same near-identical text**; `09121111111` (2 asks, 09-14) is a placeholder-shaped number; one distinct question exists — `09032574444` asked «شرایط یمن و ایران در سال قبل از ظهور» (5-turn session). *Inference, clearly marked:* the verbatim repetition across three numbers plus the placeholder number strongly suggest one operator-adjacent person testing from several SIMs, not three independent users — but the rows cannot prove that.

## 4. How much — totals and per-surface volume

Whole observed production lifetime (2026-09-14 → 2026-09-27, 14 calendar days, 7 active days), 2026-09-28 snapshot:

**Asks (`usage.sqlite3`, table `chats(account, day)`; one row = one ask that passed the gate):**

| Day | 09-14 | 09-15 | 09-16 | 09-18 | 09-22 | 09-26 | 09-27 | total |
|---|---|---|---|---|---|---|---|---|
| asks | 5 | 1 | 1 | 9 | 1 | 4 | 16 | **37** |

By cohort: phone-era 16 (9 identities), PM 6, bench-simple 15 (3 identities; bench-research 0). Per-account query: PM 6 asks / 2 active days; every other identity ≤5 asks / 1 active day except `09929731909` (4 asks / 2 days). Returning identities (≥2 distinct days): **2 of 13** (the PM and `09929731909`).

**Research Mode (`research.sqlite3`, tables `research_sessions`, `research_messages`):** 15 sessions total — 6 phone-era (09-18), 5 PM (09-26/27), 4 bench (09-27). 78 user-role messages (phone 14, PM 30, bench 34). Turns per session 1–18; stages reached: `orientation` 8, `mapping` 3, `investigating` 3, `synthesizing` 2 (PM's 18-turn; bench 10-turn), `drafting` 2 (both bench). `brief_document.complete = true`: **2 sessions, both bench**. No human-completed Brief exists. Session spans (coarse proxy, includes idle): longest human session 78 min / 18 turns (PM); longest bench session 16 min.

**Ask-side sessions (`sessions.sqlite3`, the T27 store):** 25 rows (PM 5, bench 20); message rows exist only for the PM's 5 (12 messages total).

**Spend (`usage_ledger.sqlite3`, table `usage_entries`; deployed with T22 — first row 2026-09-26 10:18:38, so pre-09-26 usage was never metered):** 191 entries, **3,635 Toman** total, all on 09-26/27. By kind: `turn` 118 (research; PM 46, bench 72), `writer` 35, `picker` 17, `ask` 20 (estimated, `metered=0`, cost 0 by design), `composer` (recall-more/dive) **1**. Tariff context: 2,000/8,000 Toman per MTok in/out (`compose.yaml:200-201`). Human (non-bench) metered usage: the PM only — 71 entries, 1,417 Toman, 46 research turns.

**Books used:** exactly two datasets — `tarhe-kolli` (طرح کلی اندیشه اسلامی در قرآن) and `70143-336` (انسان ۲۵۰ ساله) — in every `sessions.book` value and the repo's `books/` indexes (`books/tarhe-kolli.pages.json`, `books/70143-336.pages.json`).

**Instrument integrity (why these numbers can be trusted):** the ledger reconciles exactly with balances for all six accounts — e.g. PM 99,999,999 − 1,417 = 99,998,582 = stored `balance_toman`; each bench account 5,000,000 − (111 / 198 / 1,097 / 460 / 352) = stored balance. Top-ups are journaled in `audit`; logins are not audited at all (only `admin_seeded`, `account_created`, `balance_topped` appear — 12 rows total).

## 5. Which surfaces were deployed — and which the evidence actually touches

Deployed surfaces (compose.yaml `session` service env, lines 152–225; ADRs; README:155–165): the sheet UI, the ask path with Quote picker + Quoted-answer writer (ADR-0003/0006), recall-more/dive (ADR-0010), the split-view reader with the ADR-0007 provenance panel, Research Mode (ADR-0008/0009: fog probe T13, Host side answers T5, Brief assembly T8/T9), the Session report (T14-T18), Accounts/login (ADR-0013), prepaid Balance + Toman tariff + live price (T22/T23), the durable Session store (T27), and — since between 2026-10-02 and 2026-10-04 — the ADR-0014 retrieval-only ask with `/chat/latest` and `chats.sqlite3`.

Evidence coverage per surface: asks ✓ (37 quota rows + ledger), research ✓ (15 sessions + 118 turn entries), sessions ✓ (25 rows), accounts/balance/tariff ✓ (6 accounts, 12 audit events, reconciled ledger), recall-more ✗ essentially (1 `composer` entry ever), reader/provenance panel ✗ **no telemetry exists by design** (no page-view/reading store anywhere in `ui/`), notes ✗ **feature does not exist**, TTS ✗ **feature does not exist** (repo-wide grep for TTS/speech in `ui/` returns nothing), sheet report / dive / Host side answers — not separable in the stores (no per-surface marking beyond ledger kinds).

## 6. Live deployment state (read-only probes, 2026-10-04)

`http://94.183.176.80:8765/livez` → 200; `/health` → 200 `{"status":"ready","health":"healthy","version":"1.5.4-local"}`; `https://booksai.rayesh-team.ir/livez` → 200; `/auth/me` and `/chat/latest` → 401 anonymous (data gated; `/chat/latest` being routed at all shows the ≥ADR-0014 vintage is now live — on 2026-10-02 it was a static 404). No payloads were sent; nothing was mutated. The service is up ~3 weeks after the last usage row in any pulled snapshot.

## 7. What this proves — and does not prove — for کتاب‌خوان as a B2C product

کتاب‌خوان is mode 1: "the Learner reads the Book freely — reading, notes, TTS, and chat with the Book" (CONTEXT.md:143-145, settled 2026-10-03; the ADR-0007 panel is its first surface). Assess against that.

**Proven (facts):**

1. A real public deployment served Farsi cited book-Q&A over two Books for at least the observed window 2026-09-14 → 09-27, with working auth and gating (snapshots; 2026-10-04 probes).
2. The B2B control plane works end-to-end in production: admin-issued Accounts, prepaid Balance, Toman tariff, per-day ask cap, audit trail — and its books reconcile exactly (§4). The instrumentation needed to run and judge a 100-user launch **exists and is honest** (metered vs estimated split included).
3. Research Mode can sustain depth from a real human: the PM's 18-turn, ~78-minute session reaching `synthesizing` (09-27). Depth capability is demonstrated; adoption is not.
4. Usage magnitude is operator-scale: 37 asks / 15 research sessions / 3,635 Toman over the whole observed lifetime; the single heaviest day (09-27, 16 asks) is benchmark-inflated.

**Not proven — stated plainly:**

1. **Nothing about B2C فراگیر demand.** No organic external user is identifiable in the data. The verifiable humans are the PM; the bench accounts are scripted; the phone-era identities are unverifiable and carry strong same-person test signals (§3). Zero acquisition events, zero external signups (signup does not exist — Accounts are admin-issued, `ui/accounts.py`), zero paid top-ups by anyone but the PM.
2. **Nothing about three of کتاب‌خوان's four surfaces.** Notes and TTS were never built; free reading emits no telemetry; so 100% of the usage evidence concerns only chat-with-book (the ask/Quote path) plus Research Mode — a B2B-flavored research tool, not the B2C reader. The observed chat-with-book volume (37 asks, ~2 asks/active-day per identity, 5/day cap binding only for benchmarks) cannot be read as demand for a reading product.
3. **No retention or habit signal.** 11 of 13 asker-identities used the product on exactly one day; the max human streak is 2 days (PM). No cohort, no repeat rate, no session cadence can be estimated at this n.
4. **No pricing or willingness-to-pay signal.** Every Toman in the system was operator-seeded. The tariff produced 3,635 Toman of deductions — an operating datum, not a demand datum.
5. **The evidence predates the product definition.** All rows predate the 2026-10-03 two-mode re-scope; the thing being used was the B2B-era chat-with-books, not کتاب‌خوان. Even the ask surface changed afterwards (ADR-0014 retrieval-only).
6. **Observation gap.** No backup since 2026-09-28; the ADR-0014 `chats.sqlite3` (full ask text) has never been captured in any pulled snapshot; usage 09-28 → 10-04 is unknown from here.

**Fact/inference ledger.** Facts: every count, date, and reconciliation in §1–§6, each tied to a named query/file/commit. Inferences (marked where they occur): (a) phone-era identities being one operator-adjacent tester — from verbatim question repetition; (b) 09-27 bench traffic being the repo's benchmark suite — from account names, fixed repeated prompts, cap-exact volumes, and `benchmark/`'s documented flow; (c) ADR-0014 now deployed — from the `/chat/latest` 401-vs-404 change between 2026-10-02 and 2026-10-04.

## 8. What to pull next (read-only, for whoever needs fresher numbers)

The VPS stores have grown since 09-28 and now include `chats.sqlite3` (ask text). On the VPS (`ubuntu@94.183.176.80:6041`, project dir `/home/ubuntu/chat-with-books`), for each DB: `sqlite3 <db> ".backup '<out>'"`, then the §4 queries. The extraction procedure and per-question query set are already written out in `docs/research/2026-10-02-usage-evidence-chat-with-books.md` §4 (still accurate for the schema; note `account`-keyed columns, not `phone`, since ADR-0013). The nightly backup still copies only `usage`/`research`/`chats` (`scripts/backup.sh`) — `accounts`/`ledger`/`sessions` ride only full manual pulls like the 09-28 one.

## Sources

- `E:\code\booksai-backup-20260919\` — `RESTORE.md`, `download/volume_session_quota.tar.gz`, `SHA256SUMS`
- `E:\code\booksai-backup-20260928\` — `MANIFEST.md`, `booksai-session-data-20260928.tar.gz` (MD5 in manifest)
- Extracted snapshots queried read-only (mode=ro) at `%TEMP%\usage-ev-0919\` and `%TEMP%\usage-ev-0928\`; all queries reproduced in this doc's text
- Local Docker cross-checks: volumes `chat-with-books_session_quota` (restore, untouched) and `chat-withbooks_session_quota` (old local-dev, 9 asks 09-11/12), read-only mounts
- `compose.yaml:152-225` (session service, store env, tariff); `README.md:155-171` (VPS deploy, backup); `.gitignore:8-10,20`
- `ui/quotas.py:14-25` (DAILY_CHAT_LIMIT=5, QUOTA_DB); `ui/accounts.py`; `ui/ledger.py`; `ui/research_store.py`; `ui/chat_store.py` (schemas as shipped)
- `docs/adr/0007` (provenance panel), `0013` (Accounts), `0014`/`0015` (ask/chat), `0008`/`0009` (research mode); `CONTEXT.md:143-148` (کتاب‌خوان / Learning mode)
- `benchmark/README.md`, `benchmark/setup.json`, `benchmark/questions.json` (the scripted suite behind the bench accounts)
- Commits: `0e323b0`, `d597b17`, `a8b66e3`, `2aee372`, `bcb345e`, `5c9291a`, `79d174f`, `1a72db8`, `961fc8c`, `d468286` (dates in §2)
- Live probes 2026-10-04 (read-only GETs): `http://94.183.176.80:8765/{livez,health,auth/me,chat/latest}`, `https://booksai.rayesh-team.ir/livez`
- Superseded prior pass: `docs/research/2026-10-02-usage-evidence-chat-with-books.md` (commit `cc73d2d`)
