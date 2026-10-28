# 012. Data access with Kysely and SQL migrations

- Status: accepted
- Date: 2026-10-28

## Context

The capacity invariant is held by PostgreSQL row locks, `ON CONFLICT` and `RETURNING` inside
one transaction per use case. Review has to see lock order and isolation in the query text.

## Decision

Use Kysely over a `pg` pool for queries, and plain SQL migration files
(`src/capacity/adapters/out/postgres/migrations/NNNN_name.sql`). The migrate entry point
applies unapplied files in name order, one transaction per file, under a transaction-scoped
advisory lock, and records each file in `schema_migrations`. The compose `migrate` job runs it
before `api` and `worker` start.

## Consequences

- Locking queries stay explicit and reviewable; no ORM hides them.
- Migrations are forward-only SQL; there is no generated down step.
- Table types in `Database` are written by hand next to each migration.

## Alternatives rejected

Prisma (raw SQL on the critical path anyway), TypeORM (implicit behaviour), Drizzle (v1 still
a release candidate on 2026-10-28).
