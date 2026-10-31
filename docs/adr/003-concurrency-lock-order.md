# 003. Concurrency control: one lock order, no lock on the idempotency row

- Status: accepted
- Date: 2026-10-28

## Context

Many writers change one hot `program` row. Invariants I1 (reserved equals the sum of open reservations) and
I2 (a reservation commits only within the limit) of PRD §6 must hold at commit time and
writers must not deadlock. Two items of review (review finding D3) asked whether the idempotency row needs a
`SELECT … FOR UPDATE`.

## Decision

READ COMMITTED, one transaction per use case, and one lock order for every writer: dedup row
(idempotency key, `release_ref`, later inbox row), then the `program` row (`FOR UPDATE`), then
reservation rows. The idempotency claim is `INSERT … ON CONFLICT DO NOTHING RETURNING`: a
duplicate waits at the unique index for an in-flight winner (verified on PostgreSQL 16 and in the
test of acceptance criterion AC-02 on 18), then reads the committed row in a new statement. `lock_timeout` and
`statement_timeout` are set with `set_config(…, true)` inside the transaction (NFR-15).
The `UPDATE program … WHERE status = 'ACTIVE' AND credit_limit_minor - reserved_minor >= :amount`
and `CHECK (reserved_minor >= 0)` back up the application check.

Reads that only check ownership or immutable facts before the dedup row (the release's
"does this reservation belong to this tenant and program, and what is its invoice currency")
are plain `SELECT`s. They take no row lock, so they do not count as a step in the lock order.

### Why the `release_ref` foreign key is deferred

PostgreSQL checks an immediate foreign key by taking `FOR KEY SHARE` on the parent row at the
moment the child row is inserted. The `release_ref` row is the release's dedup row, so it is
inserted **before** the program lock. An immediate `reservation_release.reservation_id` key
therefore locked the reservation first, which reversed the lock order:

1. Transactions A and B release the same reservation R with different `release_ref`s. Both insert their
   `release_ref` row; each takes `FOR KEY SHARE` on R (shared locks, no conflict yet).
2. A takes the program lock, then asks for R `FOR UPDATE`. That conflicts with B's
   `KEY SHARE`, so A waits for B.
3. B asks for the program lock, held by A, and waits for A. Cycle: PostgreSQL aborts one
   transaction with `deadlock detected` (40P01), and the client sees a 503.

The key is `DEFERRABLE INITIALLY DEFERRED`, so the check runs at `COMMIT`. By then the
transaction already holds R `FOR UPDATE`, which covers `KEY SHARE`, so the check waits for
no one. A refused release has deleted its own row before commit; the deferred check skips a
deleted row. The integrity guarantee is the same: an orphan `release_ref` row still cannot
commit.

Proof: the test "AC-05 concurrent releases and reserves do not deadlock" in
`test/integration/release.int.test.ts`. The architect's review made the key immediate again,
and the test failed with `deadlock detected` in 2 of 2 runs. The other immediate keys
(`reservation → program`, `ledger_entry → program`, `ledger_entry → reservation`) are safe,
because each fires after the transaction already holds the stronger lock on the parent row.

### Rule for every new writer (treasury consumer, reconciliation, jobs)

- Take the dedup row first (idempotency key, `release_ref` or inbox row), then
  `program … FOR UPDATE`, then reservation rows. Several reservations are locked only while the
  program lock is held, so their order among themselves does not matter.
- A new foreign key from a dedup table to `reservation` or `program` must be
  `DEFERRABLE INITIALLY DEFERRED`, or the row must be inserted after the program lock.
- Never wait on a dedup row while holding the program lock.

### The conditional guard

`checkReserve` under the program lock is the primary check. The `WHERE` clause of the
`UPDATE` is the backup: if a future change drops the lock, the update matches no row, and the
use case fails with an error rather than overbooking. The backup is tested on its own in
`test/integration/program-guard.int.test.ts` (test names start with I2, the invariant they prove). The test calls the repository
directly, because under the lock the application check always answers first, and no
end-to-end test can reach the guard. The review showed why this is needed: with the guard
line deleted, all 26 reserve/release/idempotency tests still passed.

## Consequences

- No deadlock between reserve, release and later writers; waits are bounded by `lock_timeout`
  and surface as 503.
- A hot program serialises its writers; the scale path is capacity buckets (PRD §8).

## Alternatives rejected

Advisory locks (session state, NFR-15), SERIALIZABLE retries (cost on the hot row), optimistic
version checks only (retry storms on a hot row), `FOR UPDATE` on the idempotency row (blocks on
a row the winner may still roll back).
