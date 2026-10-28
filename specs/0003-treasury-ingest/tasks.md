# Tasks — 0003 Treasury ingest (M2)

Planned proofs are plain text; a ticked box carries a resolving proof marker (an HTML comment starting with `proof:`).

## P0

- [x] T1 — Message contracts: zod envelope and payloads (`ProgramLimitSet`,
  `RepaymentReceived`, `ProgramReconciled`, `FxRatePublished`), exported to
  `contracts/json-schema/` and `contracts/asyncapi.yaml`. <!-- proof: test/kafka/contracts.test.ts#schemas -->
- [x] T2 — Consumer runner on `@confluentinc/kafka-javascript`: one message in flight per
  partition, manual offset commit after DB commit, inbox insert, pause-and-backoff on
  transient errors, DLQ publish with `x-error-*` headers on permanent errors.
  <!-- proof: test/kafka/treasury-consumer.kafka.test.ts#AC-10 --> <!-- proof: test/kafka/treasury-consumer.kafka.test.ts#AC-11 -->
- [x] T3 — `apply-treasury-event` slice: limit set (create or update program, over-limit
  semantics), repayment → release path of FR-03, stale-seq skip, tenant scoping by the
  `(tenantId, programId)` pair.
  <!-- proof: test/kafka/treasury-consumer.kafka.test.ts#AC-07 --> <!-- proof: test/kafka/treasury-consumer.kafka.test.ts#AC-09 --> <!-- proof: src/capacity/application/use-cases/apply-treasury-event/apply-treasury-event.test.ts#AC-16 -->
- [x] T4 — `ingest-fx-rate` slice and FX lookup with `FX_MAX_AGE`.
  <!-- proof: test/integration/fx.int.test.ts#AC-12 -->
- [x] T5 — `reconcile-program` slice: staging table, diff outside the lock, version
  re-check, set-based apply, HOLD default, tolerance, drift events, size cap.
  <!-- proof: test/integration/reconcile.int.test.ts#AC-08 --> <!-- proof: test/integration/reconcile.int.test.ts#AC-14 --> <!-- proof: test/integration/reconcile.int.test.ts#AC-15 -->
- [x] T6 — Seeds (3 tenants, 6 programs in USD/EUR/AED/KWD, rates, ~200 invoices, fixed
  random seed) and the treasury simulator with scenarios `limit-cut`, `repayments`,
  `late-snapshot`, `duplicate-delivery`, `out-of-order`, `poison-message`, `fx-stale`;
  `make seed` and `make demo`. <!-- proof: make seed --> <!-- proof: make demo -->
- [x] T7 — Readiness reports consumer state; `make dlq-replay`. <!-- proof: make dlq-replay -->

## P1

- [x] T8 — ADRs 007 and 008. <!-- proof: docs/adr/007-kafka-consumer-semantics.md --> <!-- proof: docs/adr/008-reconciliation.md -->
