# chat-with-books

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on `Rayesh-company/fast-book-learning` (this clone's origin), operated with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical roles map 1:1 to `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `docs/CONTEXT.md` beside `docs/adr/`. See `docs/agents/domain.md`.

## Product laws

`docs/rules/` holds the PM's standing laws — they bind every session, human and agent, until the PM revokes them in writing. Read the index (`docs/rules/README.md`) before touching the product.

**001 — No new APKs** (`docs/rules/001-no-new-apks.md`): never build a new Android binary (`gradlew assembleRelease`, `expo run:android`, EAS Build — all forbidden). Every mobile change ships over-the-air (`npx expo export` + `py scripts/publish_ota.py` → `ui/ota/`, served by `/ota`); each installed app updates itself on its next launch — the user does nothing. A native-only change (new native module, permission, native app.json field) is the sole exception and requires the PM's explicit written go. The shipping procedure is the skill `ship-mobile-update` (`docs/skills/ship-mobile-update/SKILL.md`).
