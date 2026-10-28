# Tasks — 0004 Production polish (M3)

Planned proofs are plain text; a ticked box carries a resolving proof marker (an HTML comment starting with `proof:`).
Cut order inside this lane, last cut first: NFR-10 OTel profile → FR-15 → FR-12 → FR-13.

## P0

- [x] T1 — NFR-06 and NFR-07: outage and SIGTERM behaviour with stopped containers.
  <!-- proof: test/fault/outage.fault.test.ts#NFR-06 --> <!-- proof: test/fault/shutdown.fault.test.ts#NFR-07 -->
- [x] T2 — FR-13 outbox relay: single relay under a TTL lease (30 s) with epoch fencing,
  producer, `outbox_lag` metric. <!-- proof: test/kafka/outbox-relay.kafka.test.ts#FR-13 -->
- [x] T3 — FR-12 list reservations (filters `invoiceId`, `status`) and program ledger with
  cursor pagination. <!-- proof: test/e2e/queries.e2e.test.ts#FR-12 -->
- [x] T4 — FR-15 invariant job every 5 minutes; retention cleanup job (NFR-11).
  <!-- proof: test/integration/invariant-job.int.test.ts#FR-15 -->
- [ ] T5 — README honest (built / not built / cut order / production mapping / time spent),
  `docs/runbook.md` for CP-1..CP-5, remaining ADRs (001, 002, 009, 013, 017, 021), dated facts
  re-checked. proof (planned): `docs/runbook.md`

## P1

- [ ] T6 — NFR-10 OpenTelemetry traces across HTTP, PostgreSQL and Kafka; `observability`
  compose profile with Prometheus, Grafana dashboard and Jaeger; alert rules as code.
  proof (planned): `test/e2e/observability.e2e.test.ts#NFR-10`
