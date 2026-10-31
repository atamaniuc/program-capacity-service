# 002. PostgreSQL as the single source of truth; no Redis

- Status: accepted
- Date: 2026-10-28

## Context

Capacity is money exposure. Reserve and release must be atomic with their ledger entry, their
idempotency record, their inbox mark and their outbox event, and the invariants (I1 to I8 in PRD §6) must
hold under concurrency and a crash between any two steps.

## Decision

All state lives in PostgreSQL 18: program, reservation, release, ledger, idempotency keys, inbox,
outbox and FX rates. Row locks, unique constraints, `CHECK` constraints and one transaction per
use case enforce the invariants. Kafka carries facts in and out but is never a source of truth.
There is no cache: a capacity read is a primary-key lookup and reads go to the primary so a
client reads its own writes (FR-01). Idempotency uses the database (ADR 006), not a key-value
store.

## Consequences

- Correctness needs no distributed coordination; a crash rolls everything back together.
- A hot program serialises its writers on one row. The documented scale path is capacity buckets,
  a read replica for list endpoints and tenant partitioning (PRD §8), driven by measurement.
- The design stays pooler-safe (NFR-15): no session state, so PgBouncer transaction mode or RDS
  Proxy works.

## Alternatives rejected

Redis for locks, counters or idempotency (cannot commit together with the database; two copies
of exposure to reconcile); DynamoDB (no multi-row transaction at snapshot size, so invariants
would move into code); event sourcing (ADR 010).
