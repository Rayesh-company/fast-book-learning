# ADR 0017 — The B2C launch posture: self-signup, SMS OTP, ZarinPal subscription

Date: 2026-10-04
Status: accepted
Amends: ADR-0013 (Accounts replace the phone gate) — its "explicitly out" list and per-use billing posture, for the B2C launch

## Context

Wayfinder #13 (PM grilling, 2026-10-04) set the launch bar the PM fixed the same
day: کتاب‌خوان (mode 1) production-ready for 100 users by 2026-10-08 — four
days out. ADR-0013's B2B posture cannot carry a paid B2C launch: accounts are
admin-issued with no signup page, verification is none, the only payment
mechanism is admin-manual Balance top-up, and per-use Toman billing presumes a
handful of known operators. The grill settled each open edge by explicit PM
decision.

## Decision

- **Self-signup with Iranian SMS OTP verification** (provider chosen at build
  time). Registration is open until **100 accounts** exist; beyond that a
  **waitlist** collects interest and the Admin admits from it.
- **Payment via ZarinPal.** A **monthly Subscription** — 490,000 Toman at
  launch — grants کتاب‌خوان: the reader with page provenance, **notes**,
  **TTS**, and chat-with-book inside the **Question window**.
- **The Question window** replaces the 5-ask daily quota: **30 Questions
  (one ask + its answer) per 5 hours per Account**. Reading, notes, and TTS
  are unmetered. A lapsed Subscription keeps reading, notes, and TTS; only
  chat stops (the honest Farsi note).
- **The Subscription replaces per-use Balance billing at launch.** The
  Balance/Tariff machinery stays in the code, dormant, re-armable by config
  without a rebuild.
- **TTS is once-generated full-book audio**, produced as a one-time batch and
  served to the Learner's device — and it is **launch-critical**: no complete
  verified audio for the beachhead Book, no launch.
- **Research Mode is hidden** for the launch (surface intact, not offered).
- **Capacity bar: 100 concurrent chat asks**, verified by a load rehearsal
  before launch on the existing single-node stack plus whatever scaling the
  rehearsal demands.

## Considered options

Each was put to the PM in the #13 grill and answered 2026-10-04:

- **Admin-issued accounts, no signup** (ADR-0013 as-is) — rejected: the PM
  wants self-service B2C registration.
- **Email (SMTP) verification** — rejected: the PM wants an Iranian SMS OTP.
- **Manual activation first, gateway after 8 Oct** — rejected: the PM chose
  ZarinPal for launch.
- **Subscription + Balance stacked** — rejected: replace, dormant underneath.
- **TTS trails if generation is incomplete** — rejected: TTS is critical; no
  audio, no launch.
- **100 concurrent readers / ≤20 concurrent asks** as the capacity reading —
  rejected: the bar is 100 concurrent asks.

## Consequences

- ADR-0013's "explicitly out, layerable later" posture is superseded for B2C:
  signup, SMS OTP, and the payment gateway all arrive now (that ADR predicted
  them "layerable without rework" — this is that layer arriving early and at
  B2C shape).
- Build surface inside the four days: signup + OTP flow, ZarinPal integration
  (merchant account is a prerequisite), Subscription state + lapse handling,
  notes, full-book TTS generation + serving, Question-window meter, capacity
  work for 100 concurrent asks, waitlist. The backup/restore drill re-runs
  before 8 Oct (last backup: 2026-09-28 — see the usage-evidence research).
- Launch-critical dependency: complete verified full-book audio. Schedule risk
  concentrates there and in the capacity rehearsal.
- CONTEXT.md gains the vocabulary: Subscription (اشتراک), Question (پرسش),
  Question window (پنجرهٔ پرسش).
