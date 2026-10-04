# Issue tracker: GitHub

Issues and specs for this project live as GitHub issues on `Rayesh-company/fast-book-learning` — this clone's origin. Use the `gh` CLI for all operations.

## Conventions

Every command pins the repo explicitly (`-R Rayesh-company/fast-book-learning`), so it works from any clone:

- **Create an issue**: `gh issue create -R Rayesh-company/fast-book-learning --title "..." --body-file <file>`. Use a body file for multi-line bodies.
- **Read an issue**: `gh issue view <number> -R Rayesh-company/fast-book-learning --comments`.
- **List issues**: `gh issue list -R Rayesh-company/fast-book-learning --state open` (add `--label "..."` as needed).
- **Comment on an issue**: `gh issue comment <number> -R Rayesh-company/fast-book-learning --body-file <file>`.
- **Labels**: pass `--label "ready-for-agent"` at create time; create a missing label with `gh label create -R Rayesh-company/fast-book-learning <name> --color <hex> --description "..."`.
- **Close**: `gh issue close <number> -R Rayesh-company/fast-book-learning`.
- **Blocking edges** (used by `/to-tickets`): native GitHub relationships — `gh issue edit <n> -R ... --add-blocked-by <m>` (and `--parent <p>` for sub-issues).
- **PM state**: canonical PM records, labels, and the workflow live per `docs/agents/project-management.md`; PM writes go through the bundled `github_adapter.py` configured by `docs/agents/github-pm.json`.

## Archives (read-only)

- Pre-rebrand engineering tracker: self-hosted GitLab `mohamadreza/chatbot-v1` on `gitlab.rayesh-team.ir`. History only — file nothing new there. Note: the installed `glab` rejects the old `--hostname` conventions, so treat it as unreachable from this machine.
- Pre-move PM repo: `aubed9/chat-with-books` — issues #34+ moved here 2026-10-02 and were renumbered from #1; its earlier issues stay there as history.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents.
