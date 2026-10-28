# Tasks — 0003 Treasury ingest (M2)

Planned proofs are plain text; a ticked box carries a resolving proof marker (an HTML comment starting with `proof:`).

## P0

- [ ] T1 — Message contracts: zod envelope and payloads (`ProgramLimitSet`,
  `RepaymentReceived`, `ProgramReconciled`, `FxRatePublished`), exported to
  `contracts/json-schema/` and `contracts/asyncapi.yaml`. proof (planned): `test/kafka/contracts.test.ts#schemas`
- [ ] T2 — Consumer runner on `@confluentinc/kafka-javascript`: one message in flight per
  partition, manual offset commit after DB commit, inbox insert, pause-and-backoff on
  transient errors, DLQ publish with `x-error-*` headers on permanent errors.
  proof (planned): `test/kafka/treasury-consumer.kafka.test.ts#AC-10`, `#AC-11`
- [ ] T3 — `apply-treasury-event` slice: limit set (create or update program, over-limit
  semantics), repayment → release path of FR-03, stale-seq skip, tenant ownership check.
  proof (planned): `test/kafka/treasury-consumer.kafka.test.ts#AC-07`, `#AC-09`
- [ ] T4 — `ingest-fx-rate` slice and FX lookup with `FX_MAX_AGE`.
  proof (planned): `test/integration/fx.int.test.ts#AC-12`
- [ ] T5 — `reconcile-program` slice: staging table, diff outside the lock, version
  re-check, set-based apply, HOLD default, tolerance, drift events, size cap.
  proof (planned): `test/integration/reconcile.int.test.ts#AC-08`, `#AC-14`, `#AC-15`
- [ ] T6 — Seeds (3 tenants, 6 programs in USD/EUR/AED/KWD, rates, ~200 invoices, fixed
  random seed) and the treasury simulator with scenarios `limit-cut`, `repayments`,
  `late-snapshot`, `duplicate-delivery`, `out-of-order`, `poison-message`, `fx-stale`;
  `make seed` and `make demo`. proof (planned): `make demo`
- [ ] T7 — Readiness reports consumer state; `make dlq-replay`. proof (planned): `make dlq-replay`

## P1

- [ ] T8 — ADRs 007 and 008. proof (planned): `docs/adr/008-reconciliation.md`
