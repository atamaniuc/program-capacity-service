# Handoff — 0003 Treasury ingest (M2)

## Context

Kafka input from treasury: limits, repayments, FX rates, reconciliation snapshots. Planned
slot 2:40–3:55. Reconciliation and consumer semantics get an
independent `architect` review before the gate.

## What to load

1. `specs/0003-treasury-ingest/spec.md` and `tasks.md`.
2. `docs/PRD.md` §8 "Treasury consumer" and "Reconciliation" (incl. the case table), §9 Kafka
   topics, §12 seeds and scenarios.
3. Lane 0002's ports in `src/capacity/application/ports/` and the release slice.

**What NOT to load:** PRD §9 REST detail, §10 rationale, outbox relay text (lane 0004).

## Owns

- src/capacity/adapters/in/kafka/**
- src/capacity/application/use-cases/apply-treasury-event/**
- src/capacity/application/use-cases/reconcile-program/**
- src/capacity/application/use-cases/ingest-fx-rate/**
- src/capacity/adapters/out/postgres/migrations/0003_treasury.sql
- contracts/asyncapi.yaml
- contracts/json-schema/**
- tools/simulator/**
- tools/dlq-replay/**
- tools/demo/**
- db/seeds/**
- test/kafka/treasury-consumer.kafka.test.ts
- test/kafka/contracts.test.ts
- test/kafka/support/**
- test/integration/reconcile.int.test.ts
- test/integration/fx.int.test.ts

## Depends on

- core-capacity

## State

Not started; waits on 0002.

## Decisions taken

- Watermark = contiguous applied prefix of `platform_seq`; fallback on `asOf` is degraded
  and alerts every time (D4).
- Compare outstanding amounts in invoice currency first; program-currency tolerance
  `RECON_TOLERANCE_MINOR` (default 1 minor unit per reservation) (D5).
- DLQ duplicates are possible on a crash between DLQ publish and offset commit; tooling
  dedups by `messageId` (D7).

## First step

Write `test/kafka/treasury-consumer.kafka.test.ts` with `AC-10 a redelivered message has no
effect` against Testcontainers Kafka and PostgreSQL; watch it fail; then T1.
