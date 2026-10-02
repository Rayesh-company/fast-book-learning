# Project management

Canonical product: **agentic book-learning (B2C)** — the 2026-10-02 rebrand of chat-with-books; working name until the PM picks the rebrand name. PM tracker: GitHub Issues (`Rayesh-company/fast-book-learning`) — moved there 2026-10-02 from `aubed9/chat-with-books`, whose issues #34+ were renumbered from #1 (the old repo stays as the archive; its issues #1–#33 never moved). Structured index: GitHub Project [fast-book-learning Product Delivery](https://github.com/orgs/Rayesh-company/projects/2). Adapter config: `docs/agents/github-pm.json`. Single tracker for PM and engineering since the 2026-10-02 consolidation: GitHub Issues (`Rayesh-company/fast-book-learning`) per `issue-tracker.md`; the pre-rebrand GitLab tracker and the pre-move PM repo are read-only archives.

Canonical records: project [**#1**](https://github.com/Rayesh-company/fast-book-learning/issues/1) · active phase [**#2**](https://github.com/Rayesh-company/fast-book-learning/issues/2) (Phase 0 — Research & business planning) · Wayfinder map [**#3**](https://github.com/Rayesh-company/fast-book-learning/issues/3). History: the 2026-10-02 PM-state restart superseded the first records (aubed9/chat-with-books#1 project, #2 Phase 2 record, #3 Wayfinder map — closed, evidence preserved in their bodies); later that day the restarted records (old #34/#35/#36) moved here as #1/#2/#3.

Issue bodies are the work contract. Project fields are sortable indexes only. Assignment is the authoritative claim.

## Product phases

| Phase | Name | Purpose |
| --- | --- | --- |
| 0 | Research & business planning | Credible problem/opportunity and bilingual proposal before a Demo |
| 1 | Demo | Convince that the core value proposition justifies an MVP |
| 2 | MVP | Real target users succeed with a minimally complete product |
| 3 | V1 | Reliable enough for repeatable commercial or organizational use |
| 4 | Full product | Operate and evolve the mature product at intended scale |

A phase ends when its exit criteria have evidence and the PM chooses a transition. An empty backlog is not an exit criterion.

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

**1-week sprints.** No active sprint since the 2026-10-02 restart; plan the next sprint's goal and dates at the first status review. Sprint planning commits only `pm:ready` work. Unassigned ready work stays claimable.

## Definition of claim

A teammate **claims** a ticket by becoming its GitHub assignee. That assignment is the lock. `pm:claimed` must not exist without an assignee. Re-read live assignment before claiming; do not steal an existing assignee. Run `project-management prepare <ticket>` before grilling/decision-heavy work or nontrivial prerequisites.

## Tracker notes

- Preferred write path: `github_adapter.py` (`issue-create`, `enroll`, `relate`, `claim`, `state`, `done`).
- Native parent/sub-issue and blocking relationships; do not duplicate dependency truth in comments.
- GitHub Project fields: `PM Status`, `Product Phase`, `Sprint`, `Effort`, `Deadline`, `Technical Depth`, `Work Type`, `Priority`.
- Known limitation (see `project_field_sync_warning` in `github-pm.json`): `gh project item-edit` in this environment rejects the adapter's `--owner` flag, so Project field sync fails while issue/label/relationship writes succeed. Issues stay canonical; fix by aligning adapter and gh CLI before relying on Project field values.
- If Projects access drops, continue in Issues-only mode. Labels, assignment, and relationships still apply.
- Engineering and PM work share this repo's issues (engineering work carries `work:engineering` and the triage vocabulary); the pre-rebrand GitLab tracker (`mohamadreza/chatbot-v1`) and `aubed9/chat-with-books` are archives — link their history from issue bodies rather than reopening work there.

## Phase 0 specifics

The phase goal, exit criteria, scope, and evidence live in [#2](https://github.com/Rayesh-company/fast-book-learning/issues/2). The bilingual English/Farsi proposal is the phase's required deliverable (structure: the PM skill's `PHASE-0-PROPOSAL.md`); it may live in this repo as Markdown linked from #2, which holds status and pointers only. Defaults set by the agent at the 2026-10-02 restart (PM absent for the goal interview; revisable at any status review): the thesis go/no-go goal shape, the six exit criteria, and "no target date yet".
