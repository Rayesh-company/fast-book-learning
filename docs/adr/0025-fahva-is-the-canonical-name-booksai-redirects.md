# ADR 0025 — fahva.rayesh-team.ir is the canonical public name; booksai redirects

Date: 2026-11-01
Status: accepted
Context for: the operator's «می‌خوام کاملاً تبدیل بشه به fahva — ساب‌دامنه هم از booksai ریدایرکت بشه به fahva و همه موارد حتی برنامک ایتا به fahva.rayesh-team.ir اشاره کنه؛ booksai خیلی استفاده شده، حذف نمی‌شه ولی می‌شه ریدایرکت کرد»

## Context

The product's public name moved to «فحوا» (the bot re-registered as
@fahvabook_app on 2026-10-29), but the deployment, every workflow, the OTA
payload, the mobile client's baked default and ~a dozen documents still name
`booksai.rayesh-team.ir`. The old name cannot simply die:

- The installed APKs carry `https://booksai.rayesh-team.ir` as their
  `EXPO_PUBLIC_API_URL` — a JS-level constant an OTA update re-bakes to fahva
  (the next publish flips it).
- The SAME APKs carry `https://booksai.rayesh-team.ir/ota` as their NATIVE
  `updates.url` — the expo-updates manifest address, frozen at build time. No
  OTA can ever change it (rule 001: no new APKs), so that exact URL must keep
  answering for as long as any installed binary exists.
- Books, bookmarks and circulated docs name the old host; user re-login cookies
  are host-scoped, so a hard switch would log every web and برنامک session out.

## Decision

- **fahva.rayesh-team.ir is the canonical name** (ADR-0020's "booksai IS the
  API" sentence reads "fahva IS the API" from today): its vhost
  (`ops/nginx/fahva.conf`) is the full 80+443 proxy face with its own Let's
  Encrypt cert; every new registration, probe, default and document points
  here.
- **booksai.rayesh-team.ir stays as a legacy name with a split vhost**
  (`ops/nginx/booksai.conf`):
  - `/ota` is proxied verbatim and NEVER redirected — the native manifest
    address lives there for the life of the installed binaries.
  - `/`, `/mobile`, `/mobile/`, `/eitaa` 301 to fahva NOW — the human faces.
  - Everything else (the API face) keeps proxying for the transition: a 301 on
    it would rewrite the not-yet-updated installs' POSTs into GETs (okhttp
    follows 301 by dropping the method) and add a whole extra wire hop to
    every call on the slow Iran-to-box path. This face collapses into the full
    301 once the OTA wave has settled — the trigger is the box's nginx access
    log for the booksai vhost showing its non-`/ota` hits falling to ~zero.
  - The booksai cert keeps renewing for as long as the face exists (the
    renewal deploy hook covers both certs).
- **The phased redirect is the closing of an old door that the new door's
  verification gates** (the 2026-10-29 ssh-lockout law): fahva goes live and
  is verified from the outside first; only then does booksai's human face
  start redirecting.
- **Both names ride Cloudflare's proxy** (orange, since 2026-10-28 for
  booksai) — the records target the same origin, whose nginx still terminates
  TLS.
- The برنامک's registered web address becomes `https://fahva.rayesh-team.ir/mobile`
  (one panel edit on eitayar.ir); old openers reach it through the booksai 301.

## Consequences

- Web and برنامک users coming through old links land on fahva and log in once
  more — cookies are host-scoped, so they cannot follow a redirect across
  subdomains. Sessions recover by design (ADR-0013's one door); nothing else
  is lost.
- The repo's baked defaults flip to fahva (`mobile/src/api.ts`,
  `mobile/app.json` updates.url, CI's `EXPO_PUBLIC_API_URL`, publish_ota's
  `--base`) — the app.json line only matters for future builds (forbidden
  today, rule 001) but must not name a host that would die.
- The historical records stay as they were: the 2026-10-24/30 security
  reviews and the earlier ADRs keep their booksai names — they describe the
  world at their date.
- Fix TLS (the manual workflow) now provisions BOTH certs and vhosts, with a
  port-80 bootstrap block for any name whose cert does not exist yet, so a
  rebuilt box can issue before the full vhost can pass `nginx -t`.
