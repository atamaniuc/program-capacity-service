# 0003 — Treasury ingest (M2)

**Status:** proposed · **Owner:** implementer (sonnet); architect reviews reconciliation and consumer diffs

## Why

Treasury is the bank's system of record (A1, G3). Its limit changes, repayments, FX rates and
snapshots arrive through Kafka with duplicates, reordering and late data. This lane makes them
apply exactly once, in order, without dropping in-flight reservations. Requirements: FR-05,
FR-06, FR-07, FR-08, FR-09 (verbatim in PRD §4). Gate (PRD §11 M2): AC-07 to AC-12, AC-14 and
AC-15 pass; `make demo` runs every scenario.

## User stories

**US-01** — As the treasury system, I want my limit changes and repayments applied once and
in order, so that the platform's capacity matches the bank's books.
**US-02** — As an on-call engineer, I want poison messages parked in a DLQ with the error,
so that one bad message never blocks a partition.

## Acceptance criteria

Copied verbatim from PRD §4. Test names start with the AC id.

**AC-07** (FR-05) — GIVEN limit 10,000,000, reserved 3,620,000 WHEN treasury sets the limit to
3,000,000 THEN `available` = 0, `overLimitBy` = 620,000; new reservations rejected, releases
succeed.
proof (planned): `test/kafka/treasury-consumer.kafka.test.ts#AC-07`

**AC-08** (FR-07) — GIVEN snapshot seq 41 with watermark 57 omits INV-4, created by platform
event 58 WHEN the snapshot is applied THEN INV-4 stays active; reserved = snapshot total + INV-4.
proof (planned): `test/integration/reconcile.int.test.ts#AC-08`

**AC-09** (FR-09) — GIVEN program at treasury seq 42 WHEN an event or snapshot with seq ≤ 42
arrives THEN skipped, logged and committed; no state change.
proof (planned): `test/kafka/treasury-consumer.kafka.test.ts#AC-09`

**AC-10** (FR-09) — GIVEN message M already processed WHEN M is redelivered THEN no state
change; offset committed.
proof (planned): `test/kafka/treasury-consumer.kafka.test.ts#AC-10`

**AC-11** (FR-09) — GIVEN a message fails schema validation WHEN it is consumed THEN it lands
in the DLQ with the error; the partition keeps moving.
proof (planned): `test/kafka/treasury-consumer.kafka.test.ts#AC-11`

**AC-12** (FR-08) — GIVEN newest EUR/USD rate is older than the max age WHEN a EUR reservation
arrives THEN 422 `fx-rate-unavailable`; nothing reserved.
proof (planned): `test/integration/fx.int.test.ts#AC-12`

**AC-14** (FR-07) — GIVEN snapshot shows INV-5 with the same outstanding invoice amount and a
program amount 1 minor unit away from ours WHEN the snapshot is applied THEN no adjustment; a
`within-tolerance` drift line is logged.
proof (planned): `test/integration/reconcile.int.test.ts#AC-14`

**AC-15** (FR-07) — GIVEN snapshot shows INV-5 with a different outstanding invoice amount, or
a program amount beyond tolerance WHEN the snapshot is applied THEN treasury wins:
`RECON_ADJUST` ledger entry and `ReconciliationDriftDetected`.
proof (planned): `test/integration/reconcile.int.test.ts#AC-15`

## Invariants

I1–I8; I6 (one effect per message id per consumer) and I7 (`treasury_seq` only grows) are
this lane's own. Offsets commit only after the DB commit. Repayments release through the same
domain path as FR-03. Reconciliation follows the PRD §8 case table, watermark contract
(contiguous prefix), tolerance in invoice currency first, staged diff outside the program
lock, `RECON_MAX_RESERVATIONS` cap → DLQ.

## Out of scope

Outbox relay and outbound publishing (0004), schema registry, Avro, Pact.
Depends on lane 0002's domain, ports and schema.

## Tasks

See `tasks.md`.
