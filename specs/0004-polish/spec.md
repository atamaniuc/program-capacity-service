# 0004 — Production polish (M3)

**Status:** proposed · **Owner:** implementer (sonnet); architect reviews the relay lease

## Why

The submission point (PRD §11 M3). Query endpoints, outbound events, the invariant job,
resilience and shutdown behaviour, observability, README and ADRs. Requirements: FR-12,
FR-13, FR-15, NFR-06, NFR-07, NFR-10. Gate: success criteria S1–S8 are met and the dated
facts in PRD §10 are re-checked.

## User stories

**US-01** — As a bank operator, I want to list reservations and read a program's ledger, so
that I can explain every number.
**US-02** — As a downstream consumer, I want capacity events in order per program, so that
treasury, risk and notifications stay in sync.
**US-03** — As on-call, I want the service to survive Kafka and DB outages predictably and to
shut down cleanly, so that deploys and incidents lose nothing.

## Acceptance criteria

PRD §4 has no AC rows for these requirements; the checks below restate the FR/NFR text from
PRD §4–§5 as Given/When/Then.

**FR-12** — GIVEN 120 reservations on a program WHEN the list is read with `status=ACTIVE`
and a page size of 50 THEN three pages with stable cursors, tenant-filtered; the ledger
endpoint pages the same way.
proof (planned): `test/e2e/queries.e2e.test.ts#FR-12`

**FR-13** — GIVEN committed outbox rows for two programs WHEN the relay runs THEN events reach
`capacity.events.v1` keyed `tenantId:programId` in `program_seq` order; a stale lease holder
cannot mark rows published.
proof (planned): `test/kafka/outbox-relay.kafka.test.ts#FR-13`

**FR-15** — GIVEN a program whose `reserved_minor` was corrupted by hand WHEN the invariant job
runs THEN it reports the mismatch in a metric and a log line.
proof (planned): `test/integration/invariant-job.int.test.ts#FR-15`

**NFR-06** — GIVEN Kafka is stopped WHEN reservations are made THEN the API still answers and
the outbox drains on recovery; GIVEN PostgreSQL is stopped THEN readiness is false and the API
returns 503.
proof (planned): `test/fault/outage.fault.test.ts#NFR-06`

**NFR-07** — GIVEN in-flight requests and messages WHEN SIGTERM arrives THEN intake stops,
in-flight work finishes, offsets commit and the pool closes within 25 s.
proof (planned): `test/fault/shutdown.fault.test.ts#NFR-07`

**NFR-10** — GIVEN the `observability` profile WHEN a reservation is made THEN logs carry the
trace id and a trace spans HTTP and PostgreSQL. (Second item in the cut order.)
proof (planned): `test/e2e/observability.e2e.test.ts#NFR-10`

## Invariants

I1–I8. Delivery is at least once; consumers dedup by event id. FR-13 is the last item in the
cut order: outbox rows are always written, so the seam remains even if the relay is cut.

## Out of scope

gRPC, k6, ZAP, Kubernetes (0005).

## Tasks

See `tasks.md`.
