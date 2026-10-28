# Handoff — 0002 Core capacity (M1)

## Context

The P0 money path: schema, Money/FX domain, reserve, release, read, idempotency, JWT auth,
ledger. Planned slot 0:45–2:40. Every diff in this lane touches money,
concurrency or idempotency, so `architect` reviews it with a fresh context before the gate.

## What to load

1. `specs/0002-core-capacity/spec.md` and `tasks.md`.
2. `docs/PRD.md` §6 (tables, invariants, money rules), §8 "Lock order", "Reserve", "Release",
   §9 REST table, problem types and auth model.
3. `src/capacity/` as left by lane 0001.

**What NOT to load:** PRD §8 treasury consumer, reconciliation and outbox relay (lanes
0003/0004), §10–§15 beyond the stack row you need.

## Owns

- src/capacity/domain/**
- src/capacity/application/ports/**
- src/capacity/application/use-cases/reserve-capacity/**
- src/capacity/application/use-cases/release-reservation/**
- src/capacity/application/use-cases/queries/get-capacity/**
- src/capacity/application/use-cases/queries/get-reservation/**
- src/capacity/adapters/in/http/**
- src/capacity/adapters/out/postgres/repositories/**
- src/capacity/adapters/out/postgres/unit-of-work.ts
- src/capacity/adapters/out/postgres/migrations/0002_core_schema.sql
- src/capacity/capacity.module.ts
- contracts/openapi.yaml
- tools/contracts/**
- test/integration/schema.int.test.ts
- test/integration/reserve-concurrency.int.test.ts
- test/integration/reserve.int.test.ts
- test/integration/idempotency.int.test.ts
- test/integration/release.int.test.ts
- test/property/**
- test/e2e/auth.e2e.test.ts
- test/e2e/capacity.e2e.test.ts
- test/e2e/contract.e2e.test.ts

## Depends on


## State

T1-T10 done and ticked with proof markers; `make verify` green (coverage 97.98% lines on domain and
application), `npm run test:int` green. Waiting for the architect review of the diff. Reserve and release
transactions: `src/capacity/application/use-cases/{reserve-capacity,release-reservation}/*.ts`,
`src/capacity/application/shared/idempotent.ts`, `src/capacity/adapters/out/postgres/{unit-of-work.ts,repositories/*}`,
`src/capacity/adapters/out/postgres/migrations/0002_core_schema.sql`.

Implementation notes (deviations and findings for the reviewer):

- Deadlock found and fixed by the concurrent release test: an immediate FK
  `reservation_release.reservation_id -> reservation` takes `FOR KEY SHARE` on the reservation when
  the `release_ref` row is claimed, before the program lock; a second release of the same reservation
  (program lock held, wants the reservation `FOR UPDATE`) then deadlocked with it. The FK is
  `DEFERRABLE INITIALLY DEFERRED` (checked at commit, when the row is already locked by us). ADR 003.
- `reservation_release` has nullable `invoice_amount_minor`, `amount_minor` and `result` (jsonb) that are
  filled in the claiming transaction (CHECK: all set or all null). The stored `result` is the original
  outcome, replayed verbatim. A refused release (`release-exceeds-remaining`, wrong currency) deletes its
  own claim so the same `releaseRef` can be retried; with an `Idempotency-Key` the refusal is stored.
- `release_ref` fingerprint covers {reason, amount|null}; the `Idempotency-Key` fingerprint covers
  {method, route template, programId, reservationId, body}.
- `not-found` under an `Idempotency-Key` is stored like any business rejection (decision, simple and
  consistent with A13). Validation errors, auth errors and `idempotency-key-mismatch` store nothing.
- Order inside reserve: key claim, program lock, natural-key lookup, suspended/over-limit (decided
  before FX), FX lookup, `insufficient-capacity`, guarded UPDATE (ACTIVE and capacity), reservation insert,
  ledger, outbox, key completion.
- Application outcomes carry the HTTP status number (`Outcome`), because the idempotency store keeps
  `status_code`; only the controller writes HTTP. Problem `type` is the URI
  `https://errors.capacity.example/<problem>` (ADR 014); transport adds `unauthorized`, `forbidden`,
  `service-unavailable` (lock/statement timeout, connection errors) and `internal-error`.
- Domain events: there are no separate domain event types; outbox payloads are the application views
  (`ReservationView`, `ReleaseView`) plus `tenantId`, `programId`, `programSeq`. Revisit in lane 0004
  when the relay publishes an envelope.
- Edits outside `## Owns`, needed to wire the lane: `src/platform/bootstrap/{app.module,start}.ts`
  (`CapacityModule` registered with auth and FX config; `/docs` documents on the ops port),
  `src/platform/health/{ops-server,api-docs}.ts` (`documents` option, `/docs`, `/docs/openapi.json`),
  `test/integration/migrations.int.test.ts` (expects both migrations), `package.json`
  (`contracts`, `contracts:check`, deps `zod-openapi` 6.0.2, `yaml` 2.9.1, dev `ajv` 8.20.0,
  `ajv-formats` 3.0.1), `.prettierignore` (`contracts`, generated), `test/support/*`.
- Not done: wiring `npm run contracts:check` into `make verify` (Makefile is the lead's); grants on
  `ledger_entry` (the trigger covers every role); `GET /reservations` list and ledger read (lane 0004).

## Decisions taken

- No `SELECT … FOR UPDATE` on the idempotency row; the unique-index wait is the mechanism
  (review D3, verified on PostgreSQL 16).
- Program key is `(tenant_id, id)`; every query filters by tenant; another tenant's program → 404.
- Business rejections under a key are stored and replayed (A13); validation/auth errors never take the key.
- Release of `release_ref` with a different body → 422 `release-ref-mismatch` (D9 closed).

## First step

Architect review of the lane diff; then the gate (`make verify`, `npm run test:int`,
`npx harnessimo check`), wire `npm run contracts:check` into `make verify`, close the lane in
`specs/TRACKS-LOG.md`. Lane 0003 can start: tables `inbox_message`, `fx_rate`, `outbox_event` and
`outbox_relay_lease` exist; `PostgresUnitOfWork` and the repositories are reusable.
