# ADR 0024 — The customer PDF stays in git history: the exposure accepted, not rewritten away

Date: 2026-10-30
Status: accepted
Closes: F-006 of the 2026-10-24 security review (`docs/security-review-2026-10-24.md`), the last open non-supply-chain finding of it

## Context

Blob `6a3b6298` (`books/tarhe-kolli.pdf`) entered history in commit 9aadb29
("Ship the book PDF in git…") and was later removed from the tip — but it lives
in history, so every clone and fork carries the customer's copyrighted book.
`.gitignore` now blocks `books/*.pdf`, and the review's full-history scan
(262 commits) found no secrets, no dumps, no personal data — the PDF is the
only residual. The review's two closes were `git filter-repo` (force-push,
clone/build/deploy coordination) or a recorded acceptance.

## Decision

**Accept the exposure.** The leak carries commercial (copyright) risk only:
the same content ships to production as account-gated reader material, the
customer holds the original, and no credential or personal data rode with it.
Rewriting a live repo's history — force-push, re-cloning every working copy,
re-seating the deploy pipeline — outweighs that residual. History stays
untouched; `books/*.pdf` stays gitignored; no binary book content re-enters
git.

## Considered options

- **`git filter-repo` + force push** — rejected: a destructive rewrite whose
  coordination cost (every clone, the deploy key, open PRs) buys only the
  removal of an already-circulated copyright file.
- **Leave it implicit** — rejected: the exposure must be a recorded decision,
  not an accident nobody owns.
