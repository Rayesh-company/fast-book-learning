# ADR 0025 — booksai.rayesh-team.ir stays the public name; fahva is a quiet alias

Date: 2026-11-01
Status: accepted
Context for: the operator's «پشیمون شدم — booksai/mobile ریدایرکت به fahva را بردار و booksai برگردد سر جاش», reversing the same day's earlier «همه‌چیز به fahva اشاره کند»

## Context

The product's brand is «فحوا» (bot @fahvabook_app), but the deployment, the
APKs and the public web have always lived on `booksai.rayesh-team.ir`. On
2026-11-01 a migration to fahva went live: fahva got its own vhost and Let's
Encrypt cert, and booksai became a phased redirect (page faces 301'd to
fahva; the API face kept proxying; `/ota` never redirected — the APKs' native
`updates.url` is frozen there and no OTA can change it, rule 001). Within the
same day the operator reversed it: the redirect sent every web and برنامک
user through a subdomain their session cookie could not follow (cookies are
host-scoped), forcing a re-login for zero visible gain.

## Decision

- **booksai.rayesh-team.ir remains the one public name** — every baked URL,
  registration, workflow probe and document points here, exactly as before
  2026-11-01. Its vhost serves everything directly again (no redirects).
- **fahva.rayesh-team.ir stays as a quiet ALIAS face** (`ops/nginx/fahva.conf`,
  its own Let's Encrypt cert): it serves the same proxy with no redirects of
  its own. It exists because the OTA payload published that day (manifest
  `cbc8dd2e`) has fahva baked into it — the asset URLs in the live manifest
  and the `EXPO_PUBLIC_API_URL` inside the bundles already-downloading apps
  hold. Removing fahva would break those installs until the next update.
- **The healing path needs no dedicated wave**: `scripts/publish_ota.py`'s
  `--base` default is back on booksai, so the NEXT natural OTA publish
  re-bakes booksai into the app population, and the fahva-holding installs
  flip back on the update they download then. The alias keeps them whole
  until that day.
- The برنامک's registered address stays `https://booksai.rayesh-team.ir/mobile`
  (eitayar panel) — if the panel was flipped to fahva during the few hours
  the redirect lived, it is flipped back.
- Fix TLS provisions BOTH certs (the port-80 bootstrap block for a missing
  cert stays — it is how fahva's cert was issued through the Cloudflare
  proxy); both renewal deploy hooks reload nginx.

## Consequences

- No user ever logs in again because of a domain move; the re-login cost that
  triggered the reversal disappears with the redirects.
- Two vhosts and two certs renew for as long as the alias lives — cheap, and
  the renewal hook already covers both.
- The rule-001 fact stands unchanged and is now plain: a public name cannot
  be migrated over OTA, because the native manifest address never moves. Any
  future rename idea must be weighed against that wall, not against DNS.
