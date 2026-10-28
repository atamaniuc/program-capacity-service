# 003. Concurrency control: one lock order, no lock on the idempotency row

- Status: accepted
- Date: 2026-10-28

## Context

Many writers change one hot `program` row. Invariants I1 and I2 must hold at commit time and
writers must not deadlock. Two items of review (D3) asked whether the idempotency row needs a
`SELECT … FOR UPDATE`.

## Decision

READ COMMITTED, one transaction per use case, and one lock order for every writer: dedup row
(idempotency key, `release_ref`, later inbox row), then the `program` row (`FOR UPDATE`), then
reservation rows. The idempotency claim is `INSERT … ON CONFLICT DO NOTHING RETURNING`: a
duplicate waits at the unique index for an in-flight winner (verified on PostgreSQL 16 and in the
AC-02 test on 18), then reads the committed row in a new statement. `lock_timeout` and
`statement_timeout` are set with `set_config(…, true)` inside the transaction (NFR-15).
The `UPDATE program … WHERE status = 'ACTIVE' AND credit_limit_minor - reserved_minor >= :amount`
and `CHECK (reserved_minor >= 0)` back up the application check.

A foreign key checked immediately takes `FOR KEY SHARE` on the parent row. The
`reservation_release.reservation_id` key is therefore `DEFERRABLE INITIALLY DEFERRED`: claimed
first, an immediate check locked the reservation before the program and deadlocked two releases
of one reservation (found by the concurrent release test).

## Consequences

- No deadlock between reserve, release and later writers; waits are bounded by `lock_timeout`
  and surface as 503.
- A hot program serialises its writers; the scale path is capacity buckets (PRD §8).

## Alternatives rejected

Advisory locks (session state, NFR-15), SERIALIZABLE retries (cost on the hot row), optimistic
version checks only (retry storms on a hot row), `FOR UPDATE` on the idempotency row (blocks on
a row the winner may still roll back).
