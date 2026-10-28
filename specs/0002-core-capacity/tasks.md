# Tasks — 0002 Core capacity (M1)

Planned proofs are plain text; a ticked box carries a resolving proof marker (an HTML comment starting with `proof:`).
Write AC-01 first (PRD §15: "AC-01 test written first").

## P0

- [ ] T1 — Schema migration for all eight tables of PRD §6 plus the outbox relay lease row:
  composite PK `(tenant_id, id)` on `program`; unique `(tenant_id, program_id, invoice_id)`
  and `(reservation_id, release_ref)`; `CHECK (reserved_minor >= 0)`, `CHECK (0 <=
  released_minor AND released_minor <= amount_minor)`; `NUMERIC(20,10)` rates; ledger
  append-only by trigger (and grants). proof (planned): `test/integration/schema.int.test.ts#NFR-09`
- [ ] T2 — Domain core (no framework imports): `Money` with ISO 4217 scales (JPY 0, USD 2,
  KWD 3), decimal-string parse/format, `FxRate` as scaled integer with round-up conversion,
  proportional floor release with exact final remainder, `Program` capacity policy
  (ACTIVE, `limit − reserved ≥ amount`, `overLimitBy`, `available ≥ 0`), Result types,
  domain events. proof (planned): `src/capacity/domain/money.test.ts` and
  `test/property/release.property.test.ts#AC-05`
- [ ] T3 — Ports and PostgreSQL adapters: ProgramRepository (lock by `(tenant_id, id)`),
  ReservationRepository, Ledger, Outbox, FxRates, IdempotencyStore, TransactionRunner with
  `lock_timeout`/`statement_timeout` per transaction, Clock, IdGenerator (UUIDv7).
  proof (planned): `test/integration/reserve-concurrency.int.test.ts#AC-01`
- [ ] T4 — `reserve-capacity` slice per PRD §8 steps 1–6, incl. idempotency insert `ON
  CONFLICT DO NOTHING RETURNING` and stored business rejections.
  proof (planned): `test/integration/reserve-concurrency.int.test.ts#AC-01`,
  `test/integration/idempotency.int.test.ts#AC-02`, `#AC-03`, `#AC-17`,
  `test/integration/reserve.int.test.ts#AC-04`
- [ ] T5 — `release-reservation` slice: `release_ref` insert with fingerprint, replay or
  `release-ref-mismatch`, floor/remainder, status transition, ledger and outbox.
  proof (planned): `test/integration/release.int.test.ts#AC-05`, `#AC-06`
- [ ] T6 — Read side: `GET /v1/programs/{programId}/capacity` (FR-01, `ETag` = version),
  `GET …/reservations/{reservationId}` with releases. proof (planned): `test/e2e/capacity.e2e.test.ts#FR-01`
- [ ] T7 — HTTP adapter: controllers, zod bodies, RFC 9457 problem filter with the PRD §9
  problem types, JWT guard via `jose` remote JWKS (iss, aud, exp, skew), scopes, tenant
  filter returning 404. proof (planned): `test/e2e/auth.e2e.test.ts#AC-13`, `#AC-16`
- [ ] T8 — OpenAPI 3.1 generated from zod (`zod-openapi`) to `contracts/openapi.yaml`;
  `npm run contracts:check` fails on drift; e2e responses validated against it; `/docs`
  only on the ops port. proof (planned): `test/e2e/contract.e2e.test.ts#openapi`

## P1

- [ ] T9 — Property suite: random reserve/release/limit sequences keep I1–I5.
  proof (planned): `test/property/capacity.property.test.ts#I1-I5`
- [ ] T10 — ADRs 003, 004, 005, 006, 010, 011, 014, 015, 019 in `docs/adr/`.
  proof (planned): `docs/adr/003-concurrency-lock-order.md`
