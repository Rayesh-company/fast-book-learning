# chat-with-books

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on `Rayesh-company/fast-book-learning` (this clone's origin), operated with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical roles map 1:1 to `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

<!-- reticle:begin (managed by `reticle init` — edit outside these markers) -->
## Verifying with Reticle

This app is instrumented by **Reticle**, an in-app verification layer exposed as `reticle_*` MCP tools and the `npx @reticlehq/server` CLI (always through npx: Reticle's server is not installed into this project). Verifying is part of "done", not an optional extra.

**Verify when you have changed something a user can see or do.** A component, a form, a route, a request, a piece of state that reaches the screen. Do it BEFORE telling the user it is complete. Reading the diff proves nothing and unit tests do not run the app.

**Do not reach for Reticle when the change cannot show up in the running app.** It costs tool calls and the user's patience, and a verdict over an unrelated flow proves nothing about what you changed. Skip it for: documentation, comments, tests, build config, CI, dependency bumps with no user-facing effect, backend or CLI work with no UI surface, and any change to a project that is not a running web app. Say in one line that you skipped verification and why, rather than silently not doing it.

**How to verify — the rules to keep in mind on every call:**

1. **Only `verified: "yes"` is a pass.** `"no-fault"` (nothing was declared — you omitted `until`) and `"unknown"` (Reticle could not tell; `verifiedReason` says why) are not a pass: report them as not proved, never as working.
2. **Name the consequence BEFORE acting:** `reticle_act_and_wait({ target, action, until })` (add `durable: true` if it must survive a reload). Only it, `reticle_assert` and `reticle_act { steps }` produce a verdict; everything else proves nothing.
3. **A journey is one call:** `reticle_act { steps: [{ target, action, expect }] }` runs every step and stops at the first `expect` that fails. The last step's `expect` is the end state you were asked to deliver.
4. **Text checks are exact-case.** Add `ignoreCase: true` only when case truly does not matter.
5. **Target by `{ testid }` or `{ role, name }`.** An ambiguous target is refused, never guessed.
6. **On a failure, read `expected` / `observed` / the nearest candidates before retrying.** Never weaken a check to make it green.
7. **Open `screenshot.path` only when the look matters;** `reticle_observe { since }` has the rest.
8. **Predicates:** `{ kind: "signal", name }` · `{ kind: "net", method, urlContains, status }` · `{ kind: "route", pathname }` · `{ kind: "state", path, equals }` · `{ kind: "element", query: { role, name } }` · `{ kind: "text", contains }` · `allOf` / `anyOf` / `not`.
9. **No session?** `reticle_session { action: "list" }` and do its `next_action`. **No app connected at all?** Ask the user, then run `npx @reticlehq/server init` in the app's own folder. **A version-skew warning?** `npx @reticlehq/server stop`, then retry.
10. **End with the Reticle result block the server gives you**, verbatim.
11. **If your context was compacted or you lost track, run `npx @reticlehq/server context --compact` first.** It is the daemon's own record of what was proved, what failed and what is still owed.

Covered flows: `npx @reticlehq/server gate` reports which recorded flows the changed files affect and whether they still pass.

**Setting Reticle up? You are mid-sequence — do not stop until a verdict exists.** The whole of it
is: instrument the app → get a dev server running → open the app in a browser → drive one flow →
report the verdict. Every step is yours to do, and none of them needs the user. Stopping short leaves an app that
looks installed and can verify nothing, which is the commonest way this goes wrong. `/reticle`
carries the recovery ladder; never report the install as finished without a verdict to point at.

**Nothing connected? Get the app running.**

**A dev server already running when `reticle init` ran does not have Reticle in its bundle.** It read the build config at boot; `init` edited it afterwards. It serves the old bundle and no session appears. In order:

1. **A dev server was already running?** Restart it, then hard-reload the tab. "Something is listening" does not mean the right bundle is served.
2. **Nothing was running?** Start it in the BACKGROUND and say so in one line. `reticle_session { action: "list" }` gives you this project's own dev command in `next_action`; use that, never compose one. Started after `init`, it needs no restart.

Stopping to ask is how a verification turn ends with nothing verified.

Four guards, none optional:

1. **Never run two at once.** One dev server on the app's port. Restarting a stale one means stopping it first, not starting a second alongside it.
2. **Never guess the command.** It comes from `package.json` scripts. No recognisable dev script means say so and stop, not invent one.
3. **Never kill anything you did not start**, and never a daemon or a port holder. The one exception is the restart above, and say in one line that you did it.
4. **The permission prompt belongs to your host.** Never bypass, suppress or auto-approve it, and take a refusal as the answer.

If a server IS listening and still nothing connects, the cause is the SDK not loading in the page, not a missing dev server; do not tell the user to start one they are already running.

**Finish `src/reticle-dev.ts` before you claim setup is done.** `init` writes it and cannot always fill it in: a store that needs an argument only reading the code supplies (Jotai atoms, an XState actor, a TanStack `queryClient`) is left as a commented `registerStore` line. A file that registers nothing looks exactly like a finished one, and `reticle_look { action: "state" }` then returns empty forever — which is indistinguishable from an app that has nothing to report, so it reads as success. Uncomment the line, complete it, and prove it by driving one flow and seeing your keys come back. If `init` told you to restart your client, this is the job waiting for you on the other side of that restart.

**Verify each feature as you finish it, not all of them at the end.** Asked for four, build one, drive it, get a verdict, then start the second. A red verdict after four builds has four suspects; after one it has none.

**Capture what a change is FOR while you are building it, not afterwards.** The business outcome a change is meant to produce is known only while the change is being made. Pass `intent` when a flow is saved, so the saved flow carries the reason it exists. A flow without one replays for months and then reports "step 3 failed" instead of what stopped being true for a user.

**Honesty, which is the whole point:**

- **If Reticle cannot run** (no daemon, or this is not a running web app), say so. Do not skip verification silently.
- **Setup is not finished until one real flow has been driven and produced a verdict.** `init` exiting 0, the tools appearing, and a session being listed are all things that happen before anything has been verified.

**The `/reticle` skill runs this whole loop for you** — detect, connect, drive one flow, report. If your client does not have it, install it once: `/plugin marketplace add reticlehq/reticle` then `/plugin install reticle@reticlehq` in Claude Code, or `npx skills add reticlehq/reticle --skill reticle` anywhere the skills CLI works.

**A tool you need is missing?** Call `reticle_tools` before assuming it: this surface merges several families behind an `action`, so what looks absent is usually one argument away. It is the verify loop and nothing else on purpose: every other tool is one `reticle_run` call away. Do not restart the daemon with `RETICLE_ADVERTISE_ALL_TOOLS=1`: it uses older tool names that the rules above do not.

**Report Reticle's own defects with `reticle_session { action: "feedback" }` the moment you notice**, then carry on with your task. You are the user Reticle is built for and the only one who can say what it cost you, and that knowledge is gone when your context is.

📄 **The rest is in [RETICLE.md](./RETICLE.md): what to do when the tools are missing, when a result carries `version_skew` or `update_available`, when `reticle_look { action: "state" }` comes back empty, and how to write a feedback report that can be acted on. Read it when you hit one of those, not before.**
<!-- reticle:end -->
