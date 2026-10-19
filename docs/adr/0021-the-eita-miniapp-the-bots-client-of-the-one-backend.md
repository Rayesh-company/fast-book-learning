# ADR 0021 — The Eita برنامک: the bot's client of the one backend

Date: 2026-10-18
Status: accepted
Context for: the operator's «برو داکیومنت ایتا و یک برنامک ایتا بات درست کن»

## Context

Eita (the Iranian messenger) documents a mini-app platform — «برنامه و برنامک» — at
developer.eitaa.com: the bot is registered on the Eitaayar panel and gets a bot token;
Eita's client opens the app's URL in a WebView, stamping the open with a query-string
`initData` (`user`, `auth_date`, `chat_instance`, `chat_type`, `hash`, …); an official JS
SDK (`developer.eitaa.com/eitaa-web-app.js`, never vendored) exposes the Telegram-shaped
WebApp surface (`initData`, `ready`, `expand`, `BackButton`, `HapticFeedback`,
`showAlert`, `themeParams`); the server verifies the signature offline — the documented
six-step HMAC scheme (pairs sorted, newline-joined, key = HMAC-SHA256("WebAppData",
bot_token), hexdigest compared) plus an `auth_date` freshness bound; and the server can
message the user back through `eitaayar.ir/api/app/sendMessage` (token, chat_id =
the Eita user id, markdown text), a courtesy rationed by Eita's own daily quota and
conditional on the user's write access.

The product's laws stand untouched: the Account is the only identity (ADR-0013), Login
is the one door, and one backend serves every client (ADR-0020) — the sheet, the Expo
app, and now whatever Eita's WebView carries.

## Decision

- **A third client, still one backend.** The برنامک is a page the sheet's own server
  serves (`/eitaa` → `ui/eitaa_app.html`, read from disk per request, the index.html
  rule). It speaks the shared API verbatim — `/sessions`, `/ask`, `/quote-selection`,
  `/quoted-answer`, `/usage/live` — riding `Authorization: Bearer` with the SAME
  signed token `/auth/login` mints. No second backend, no new wire dialect.
- **The initData is the credential; the exchange mints the token.** `POST /eitaa/auth`
  validates the WebView's initData (`ui/eitaa.py`'s `validate_init_data`: the six-step
  HMAC check, an hour's freshness bound, `hmac.compare_digest` throughout) and, when
  the caller's Eita user is already linked, answers the Account's ordinary token. A
  tampered, stale, or unsigned string — and an unconfigured bot (503) — refuse exactly
  one way each; the caller never learns which failure it was.
- **The link is the one door, asked once.** Eita's initData names no Account — no
  email, no phone — so an unlinked user sees the product's own Login: `POST /eitaa/link`
  takes the initData beside a real email and password, checks the credentials through
  `/auth/login`'s own path (the identical 401 for unknown email and wrong password,
  ADR-0013's rule), and records the binding. `ui/eitaa_store.py` (the note_store
  pattern, its own `EITAA_DB` file) keeps one row per Eita user — Account, chat_id
  (the Eita id, INTEGER, the number sendMessage's doc carries), names. One Eita user
  holds one binding (re-linking upserts); an Account may carry several. The برنامک
  never issues, never registers.
- **«خروج از ایتا» moves only the caller's own row.** `POST /eitaa/unlink` needs the
  caller's token (the Account) AND the validated initData (the Eita user); a row
  belonging to both is the only one that goes.
- **The push is a bell, opt-in and off by default.** When `EITAA_PUSH_ENABLED=1`,
  the settled Quoted answer — beside the live line's `chat.quoted` — pings the
  Account's bound Eita users through `sendMessage` (`EITAA_PUSH_SETTLED_TEXT`). Eita's
  daily quota is not ours to spend, an outage costs a bell and never the answer
  (`send_message` fails soft), and the stream stays the stores' inferior (the events
  law): the push is never a record.
- **The page degrades honestly.** Outside Eita's client the SDK object never appears;
  the page says so and stops. The strings are Farsi DRAFT pinned in the page's own `S`
  table and CONTEXT.md's draft row — the roster's words («فهرست نشست‌ها»، «نشست تازه»،
  «بپرس»، «هزینۀ نشست:») reused verbatim, the mobile app's phase notes carried over,
  and the NEW ones (the برنامک's name, the link door, «خروج از ایتا») parked for the
  PM's approval.

## Consequences

- `EITAA_BOT_TOKEN` (compose + .env) is the برنامک's single credential: the initData
  signature's key and sendMessage's token. Unset, `/eitaa/auth` answers 503 and the
  page names it; the rest of the product never notices Eita exists.
- The remote `eitaayar.ir/api/app/verify` (one-minute, single-use, 20 rps) is NOT
  used: the local signature plus the freshness bound is the documented offline check,
  and the minted token carries its own expiry. Revisit only if Eita makes the
  signature diverge from its docs.
- The v1 برنامک's scope is the sitting — the list, the thread, the ask, the cost line.
  The Book reader, the notebook, and the research journey stay web-first (ADR-0020's
  recorded shape); a fresh ask with no Book pick searches the whole Book set.
- The suite pins the contract (`tests/test_eitaa_app.py`): the HMAC vector and its
  five refusals, the exchange → shared token → silent re-open, the door's identical
  401, the unlink's ownership, the push's opt-in/off default/soft failure, the settle
  hook firing, and a doc test that locks the page's fetches to routes serve.py serves.
