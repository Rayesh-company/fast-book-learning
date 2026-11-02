# ADR 0025 — booksai.rayesh-team.ir stays the public name; fahva is a quiet alias

Date: 2026-11-01
Status: accepted (supersedes the two same-day reversals recorded below)
Context for: the operator's «https://booksai.rayesh-team.ir/mobile/ کلاً بردار — بشه https://fahva.rayesh-team.ir/؛ هرکی booksai/mobile زد 404 بدهد؛ ولی قبلش تست کن که منتقل شده؛ و اپ اندروید هم به fahva اشاره کند»

## Context

One day, three acts. The brand is «فحوا» (bot @fahvabook_app) but everything
public lived on `booksai.rayesh-team.ir`. Act I migrated everything to fahva
with booksai as a phased redirect — reversed within hours: the 301s stranded
every web/برنامک session on a subdomain its host-scoped cookie could not
follow, forcing re-logins for no visible gain. Act II restored booksai fully
and kept fahva as a bare alias (needed because that morning's OTA payload
had fahva baked into it). Act III — this decision — moves only what the
operator actually wanted to move: the APP'S FACE, not the API's identity.

What made the reversal painful in Act I was moving the SHEET's users across
hosts. What the operator wanted all along was the app — the برنامک page and
the Android client — living on the brand's own domain, with the booksai
/mobile path gone.

## Decision

- **fahva.rayesh-team.ir's bare root IS the app** (`ops/nginx/fahva.conf`):
  an exact-match internal proxy serves the backend's `/mobile/` page at `/`
  — not a redirect, so the URL bar holds just the domain. The page's asset
  references are absolute (`/mobile/*`, `/vendor/*`, `/book-reader/*`) and
  flow through the general proxy unchanged. The bernamek's registered
  address becomes `https://fahva.rayesh-team.ir/` (eitayar panel).
- **booksai's /mobile forwards to fahva** (`location /mobile` in
  `ops/nginx/booksai.conf`): the operator sent that address to too many
  people for anything less than a redirect (a brief 404 interlude was
  reversed within a day). ONE shape for every hop: the root, with the
  query string riding it (`$is_args$args`) — plain links land on the bare
  root, and برنامک opens carrying `?initData=…` land on
  `https://fahva.rayesh-team.ir/?initData=…`: the app reads everything
  from the query string (app.mjs: URLSearchParams(location.search)), so
  the WebView's signed payload survives the hop with no path anywhere in
  the bar. Everything else on booksai is untouched — the web sheet at
  `/`, every API route, and `/ota`, the manifest address the installed
  APKs hold NATIVELY (rule 001: no OTA can ever change it; it proxies
  verbatim for the life of those binaries). New builds bake `fahva/ota`
  (mobile/app.json); both doors serve the same payload.
- **The Android app points at fahva** — `mobile/src/api.ts` default and
  CI's export env are `https://fahva.rayesh-team.ir`; the OTA wave published
  under this decision (manifest `05c23d3f`, RSA-signed per F-019) carries
  that base to every install on its next launch, whichever /ota door it
  downloads from.
- **The door order was the 2026-10-29 law**: fahva's root went live and was
  verified from the outside (page + assets + API) BEFORE booksai's /mobile
  404 was installed, then the 404 was verified itself.

## Consequences

- برنامک users moving hosts re-authenticate through initData automatically
  (the server-side link is host-agnostic) — no password wall this time; the
  APK uses Bearer tokens, host change is invisible to it.
- The web sheet's users stay on booksai untouched; nobody's cookie strands.
- Two certs renew (the fix-tls hook covers both); booksai's cert can never
  lapse while any old APK lives, because its native /ota door rides that
  vhost.
- The Act-I lesson stands, now sharpened: what a host-scoped credential
  (cookie) cannot follow is a HOST move — a PATH move on a fresh host,
  where auth re-establishes itself (initData/Bearer), is free. Choose moves
  by credential topology, not by brand.
