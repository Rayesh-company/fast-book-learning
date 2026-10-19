# ADR 0020 — The mobile client and the shared API: one backend, both clients, a live line

Date: 2026-10-02
Status: accepted
Context for: the operator's «آپ اندرویدشو هم با expo بده … یک بک اند داریم که هم برای سایت استفاده میشه و میره روی سرور و بعدشم api وصل میشه به هم به وب هم به موبایل»

## Context

The product's backend is already ONE service: `ui/serve.py` serves the sheet AND the JSON API the sheet's own JavaScript speaks — `/auth/*`, `/sessions`, `/ask`, `/quote-selection`, `/quoted-answer`, `/recall-more`, `/research/*`, `/notes`, `/usage/live`, `/chat/latest` — every payload a JSON document, every identity an Account (ADR-0013). A mobile client needs no second backend; it needs the same API reachable without a browser's cookie jar, and the server's settles visible the moment they land.

Two browser assumptions live in the current contract, and one rhythm is missing:

1. **Auth rides the HttpOnly cookie alone** — right for the sheet's JS (which must never hold the token), useless to a native client's `fetch`.
2. **CORS never mattered** — the sheet is same-origin by construction; an Expo WEB client (and any browser dev tool) calling `booksai.rayesh-team.ir` from another origin is refused by the browser, not by the server.
3. **The settles are silent** — an ask's chat row, the picker's selections, the Quoted answer, the widen, a research turn's start, a saved note: each lands server-side and only the acting device's page knows. The second device learns on its next manual refresh.

## Decision

- **One backend, both clients.** The mobile app (`mobile/`, Expo + TypeScript, the `mobile/` README documents its run) speaks the sheet's own wire protocol verbatim — same routes, same payload shapes, same Account. The VPS deployment needs no new service: `booksai.rayesh-team.ir` IS the API (nginx already fronts it with the long timeouts the phases need).
- **The Bearer token is the native credential.** `/auth/login`'s body now carries the signed token beside the Set-Cookie — the same string, one `verify_token` path. A native client stores it in the device's secure store (`expo-secure-store`) and rides `Authorization: Bearer` on every call; `resolve_identity`/`resolve_account` accept cookie first, header second, and a tampered or expired Bearer refuses exactly like a bad cookie (the tests pin the pair). The web sheet ignores the field: its JS cannot touch the HttpOnly cookie, and shouldn't.
- **CORS exists only where a browser needs it.** `SESSION_UI_ALLOWED_ORIGINS` (comma-separated, read per request) stamps `Access-Control-Allow-*` for an allowlisted Origin — the Expo web dev server in dev — and `do_OPTIONS` answers the preflight bare. Empty (the recorded production shape) means no stamps, no change for the sheet.
- **The live line (`GET /events`) is the real-time surface.** One in-process hub — per-Account subscriber queues, the turn registry's shape — fed by the settle points: `chat.asked`, `chat.selected`, `chat.quoted`, `chat.widened`, `research.started`, `note.saved`, heartbeats between. A native client holds the SSE connection open (its Bearer in the header) and learns a settle the moment it lands: an ask on one device opens the sitting on the other. The web sheet keeps its own rhythms for now (its phases run in the browser; its research poll is the recorded shape) — adopting the line is a later, optional step. A turn's COMPLETION still rides the existing `/research/turn` poll on every client: the registry completes asynchronously and the poll is its recorded surface.
- **The app's scope is the sitting**: login, the Sessions list (فته /sessions), a sitting's thread (the ask's pool, the Quote selection's quoting paragraphs with their page labels, the Quoted answer's blocks, the research conversation with its turn progress), the composer, and the live line. The Book reader's raster pipeline, the notebook's full panel, and the Admin console stay web-first — recorded, not forgotten.
- **The app's strings are Farsi DRAFT**, pinned in `mobile/src/strings.ts` beside the roster's words they reuse («نشست», «ورود», «حالت پژوهش»); the manifest naming (ADR-0019) carries over.

## Consequences

- The deploy story is unchanged for the server (the API ships with the sheet) and gains one client artifact: the Android build rides Expo's own pipeline (`npx expo run:android` for a device on the LAN, EAS Build for the store track) — the repo builds no APK itself.
- The events hub is in-process: a restart empties it, the clients reconnect (EventSource semantics), and the stores stay the truth — the stream is a bell, never a record.
- `/events` holds one server thread per connected client (the ThreadingHTTPServer's per-connection thread); heartbeats (20 s) keep idle clients and intermediaries honest, and a hung-up client's write breaks and unregisters it. nginx needs no change (`proxy_buffering off` is already the sheet's law).
- A browser client is only as trusted as its Origin header is honest — CORS is a browser courtesy, never the gate; the Account gate stays the only gate.
- The suite pins the whole contract (`tests/test_mobile_api.py`): the login body's token, the Bearer pair, the tampered refusal, the CORS stamps' presence and absence, and a live line that opens, receives a settle, and unregisteres cleanly.
