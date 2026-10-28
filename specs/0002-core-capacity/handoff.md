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

Not started. Lane 0001 closed (see specs/TRACKS-LOG.md): Nest bootstrap in `src/platform/bootstrap/`, Kysely pool in `src/capacity/adapters/out/postgres/db.ts`, migration runner `migrate.ts` applies `migrations/*.sql` in order, Testcontainers PG18 helper `test/support/postgres.ts`. `zod-openapi` is not installed yet. JWT audience is `capacity-service`; mock OAuth issuer `http://localhost:8081/default` (compose).

## Decisions taken

- No `SELECT … FOR UPDATE` on the idempotency row; the unique-index wait is the mechanism
  (review D3, verified on PostgreSQL 16).
- Program key is `(tenant_id, id)`; every query filters by tenant; another tenant's program → 404.
- Business rejections under a key are stored and replayed (A13); validation/auth errors never take the key.
- Release of `release_ref` with a different body → 422 `release-ref-mismatch` (D9 closed).

## First step

Write `test/integration/reserve-concurrency.int.test.ts` with the test
`AC-01 exactly 10 of 50 concurrent reservations succeed` against Testcontainers PostgreSQL;
watch it fail; then T1 migration.
