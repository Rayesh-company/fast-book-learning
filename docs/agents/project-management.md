# Project management

Canonical product: **agentic book-learning (B2C)** — the two-mode app (کتاب‌خوان reader mode + Learning mode; see [#10](https://github.com/Rayesh-company/fast-book-learning/issues/10)). **Proposal focus is کتاب‌خوان (mode 1) first** (PM decision, 2026-10-04); Learning mode's go/no-go is deferred to a later proposal. PM tracker: GitHub Issues (`Rayesh-company/fast-book-learning`). Structured index: GitHub Project [fast-book-learning Product Delivery](https://github.com/orgs/Rayesh-company/projects/3). Adapter config: `docs/agents/github-pm.json`.

Canonical records: project [**#10**](https://github.com/Rayesh-company/fast-book-learning/issues/10) · active phase [**#11**](https://github.com/Rayesh-company/fast-book-learning/issues/11) (Phase 0 — Research & business planning).

**Binding deadline (PM, 2026-10-04): کتاب‌خوان (mode 1) production-ready for 100 users by 2026-10-08.** Supersedes the 2026-10-03 launch line (19 Shahrivar 1406 ≈ 10 Sep 2027, ≥1,000 users). The Farsi proposal, the Demo funding call, and the build all land inside this window.

Issue bodies are the work contract. Project fields are sortable indexes only. Assignment is the authoritative claim.

## Product phases

| Phase | Name | Purpose |
| --- | --- | --- |
| 0 | Research & business planning | Credible problem/opportunity and proposal before a Demo |
| 1 | Demo | Convince that the core value proposition justifies an MVP |
| 2 | MVP | Real target users succeed with a minimally complete product |
| 3 | V1 | Reliable enough for repeatable commercial or organizational use |
| 4 | Full product | Operate and evolve the mature product at intended scale |

A phase ends when its exit criteria have evidence and the PM chooses a transition. An empty backlog is not an exit criterion. Given the 8-Oct line, phase transitions are expected to be rapid and evidence-driven.

## PM labels

Identity:

- `pm:project` — one canonical project record
- `pm:phase` — active phase record (`phase:<n>`)
- `pm:task` — executable work
- `pm:milestone` — roadmap milestone/meta work

Workflow:

- `pm:backlog` — not ready to claim
- `pm:ready` — claimable
- `pm:claimed` — assigned owner; valid on GitHub only when assignee is set
- `pm:in-progress` — actively being done
- `pm:blocked` — cannot proceed
- `pm:review` — validation/review
- `pm:done` — complete

Phase labels: `phase:0` … `phase:4`.

Triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) are a parallel queue. Promote `ready-for-agent` into `pm:ready` before claiming as PM work; do not remove `ready-for-agent` unless asked.

## Work-kind labels

Exactly one per task:

- `work:engineering`
- `work:research`
- `work:product`
- `work:design`
- `work:business`
- `work:docs`
- `work:ops`
- `work:meeting`
- `work:validation`
- `work:access`
- `work:other`

## Effort convention

Story points: **1 / 2 / 3 / 5 / 8**. Forecasts, not promises. Expected shape (focused / half-day / day / multi-day) still belongs in the issue body.

## Sprint cadence

**1-week sprints.** No active sprint yet; plan the next sprint's goal and dates at the first status review. Sprint planning commits only `pm:ready` work. Unassigned ready work stays claimable.

## Definition of claim

A teammate **claims** a ticket by becoming its GitHub assignee. That assignment is the lock. `pm:claimed` must not exist without an assignee. Re-read live assignment before claiming; do not steal an existing assignee. Run `project-management prepare <ticket>` before grilling/decision-heavy work or nontrivial prerequisites.

## Tracker notes

- Preferred write path: `github_adapter.py` (`issue-create`, `enroll`, `relate`, `claim`, `state`, `done`).
- Known limitation (see `project_field_sync_warning` in `github-pm.json`): adapter-driven `gh project item-edit` calls fail in this environment (`--owner` flag mismatch); issue/label/relationship writes and Project enrollment still land, and field writes work when done manually with `--project-id/--id/--field-id`. Issues stay canonical.
- If Projects access drops, continue in Issues-only mode. Labels, assignment, and relationships still apply.
- Native parent/sub-issue and blocking relationships; do not duplicate dependency truth in comments.
- GitHub Project fields: `PM Status`, `Product Phase`, `Sprint`, `Effort`, `Deadline`, `Technical Depth`, `Work Type`, `Priority`.

## Phase 0 specifics

The phase goal, exit criteria (PC-1 … PC-6), scope, and evidence live in [#11](https://github.com/Rayesh-company/fast-book-learning/issues/11). **PM overrides recorded at the 2026-10-04 init:**

- The proposal is **Farsi-only** (overrides the PM skill's bilingual English/Farsi Phase-0 default).
- The proposal is **کتاب‌خوان-scoped** — the two-mode product stands, but this go/no-go covers mode 1 only.
- The 8-Oct mode-1 launch line (above) is the phase's target date and the product's binding deadline.
