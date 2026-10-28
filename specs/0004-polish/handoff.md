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

- core-capacity

## State

Not started; waits on 0002.

## Decisions taken

- Relay lease: owner, epoch, `expires_at` (TTL 30 s, renewed each batch); a stale holder's
  "mark published" is rejected by epoch (D7).
- Docs UI and metrics stay on the internal ops port.

## First step

Write `test/fault/outage.fault.test.ts` with `NFR-06 the API answers while Kafka is down`;
watch it fail; then T1.
