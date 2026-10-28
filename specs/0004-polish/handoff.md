# Handoff — 0004 Production polish (M3)

## Context

Submission-point lane: queries, outbox relay, jobs, resilience, shutdown, observability,
README, runbook and ADRs. Planned slot 3:55–4:40. Can run in parallel with 0003 once 0002 is
closed, because the Owns below do not overlap.

## What to load

1. `specs/0004-polish/spec.md` and `tasks.md`.
2. `docs/PRD.md` §8 "Outbox relay" and "Scheduled jobs", §5 NFR-06/07/10/11, §13 runbook entries.
3. Lane 0002's ports and `src/platform/`.

**What NOT to load:** PRD reconciliation and treasury consumer text (0003), §14 open
questions until T5.

## Owns

- src/capacity/adapters/out/kafka/**
- src/capacity/adapters/in/jobs/**
- src/capacity/application/use-cases/queries/list-reservations/**
- src/capacity/application/use-cases/queries/get-ledger/**
- src/platform/telemetry/**
- deploy/observability/**
- docs/runbook.md
- test/fault/**
- test/kafka/outbox-relay.kafka.test.ts
- test/e2e/queries.e2e.test.ts
- test/e2e/observability.e2e.test.ts
- test/integration/invariant-job.int.test.ts

## Depends on


## State

T1 (NFR-06/NFR-07), T2 (FR-13 relay) and T3 (FR-12 list reservations + ledger, `npm run contracts` regenerated) done and green. Relay: `src/capacity/adapters/out/kafka/outbox-relay.ts`, store `src/capacity/adapters/out/postgres/repositories/outbox-relay.repository.ts`, port `src/capacity/application/ports/outbox-relay.ts`; wired for the `worker`/`all` roles in `src/platform/bootstrap/worker.ts`. Worker tuning lives in `src/platform/telemetry/settings.ts` (not `Config`, to avoid colliding with lane 0003). Lock-order rule for any new writer: claim the dedup row, then `program` FOR UPDATE, then reservation rows. The `reservation_release -> reservation` FK is DEFERRABLE INITIALLY DEFERRED on purpose (ADR 003).

## Decisions taken

- Relay lease: owner, epoch, `expires_at` (TTL 30 s, renewed each batch); a stale holder's
  "mark published" is rejected by epoch (D7).
- Docs UI and metrics stay on the internal ops port.

## First step

T4: write `test/integration/invariant-job.int.test.ts` (`FR-15 ...`) against `InvariantCheckJob` / `RetentionCleanupJob` in `src/capacity/adapters/in/jobs/jobs.ts` (already wired by `src/platform/bootstrap/worker.ts`).
