# 008. Reconciliation: staged diff, contiguous watermark, tolerance, HOLD default

- Status: accepted
- Date: 2026-10-28

## Context

A `ProgramReconciled` snapshot carries the limit, every open reservation with outstanding
amounts in invoice and program currency, and a contiguous `platformWatermark`. Applying it
must follow the PRD §8 case table without holding the program lock for the length of the
snapshot (acceptance criteria AC-08, AC-14, AC-15 of the PRD).

## Decision

The snapshot is loaded into the staging table `reconcile_snapshot_row`
(`tenant_id, program_id, invoice_id, invoice_currency, outstanding_invoice_minor,
outstanding_program_minor`) with one set-based `DELETE` + `INSERT … SELECT * FROM unnest`.
A set-based SQL query then partitions the rows outside the program lock into:

- `both` — snapshot row joined to its reservation;
- `snapshot-only` — treasury knows a reservation we do not (adopt it);
- `ours-only` — we have a reservation the snapshot omits (keep, hold or release).

The pure `planReconciliation` policy turns those three sets into the diff (overwrites,
adoptions, tolerated notes, drifts, kept-unseen, reserved delta). The plan runs in a first
transaction that reads the program without a lock; the only writes are to the staging table.
In a second transaction the inbox row is claimed, the program row is locked, the version is
re-checked, and the plan is recomputed from the staging table if the program moved between
planning and the lock. The apply is set-based: one `UPDATE … FROM unnest` for overwrites, one
`INSERT … SELECT * FROM unnest` for adoptions, both scoped to the locked tenant and program.
Staging rows are replaced by the next snapshot of the same program.

The comparison follows the case table:

| Case | Action | Recorded as |
| --- | --- | --- |
| `seq` ≤ `treasury_seq` | Skip as stale | Log line |
| Limit differs | Treasury wins | `LIMIT_SET` |
| In both, difference within tolerance | Keep ours | within-tolerance log line |
| In both, invoice amount differs or program amount beyond tolerance | Treasury wins | `RECON_ADJUST` + drift event |
| Only in the snapshot | Adopt with origin `TREASURY` | `RECON_ADJUST` + drift event |
| Only ours, `platform_seq` > watermark | Keep: treasury has not seen it | Nothing |
| Only ours, `platform_seq` ≤ watermark | HOLD by default (or RELEASE by config) | Drift event |

Amounts are compared in invoice currency first, which involves no FX. Program-currency
differences up to `RECON_TOLERANCE_MINOR` (default 1 minor unit per reservation) are logged
and left alone; larger differences let treasury win. `platformWatermark` = N means treasury
has applied every platform event 1..N; without a watermark the snapshot `asOf` is compared
with the reservation creation time minus a skew margin, and every use logs
`reconciliation_fallback`. Snapshots above `RECON_MAX_RESERVATIONS` are parked in the DLQ
as a resource guard before any other check. Duplicate and stale checks run before the
remaining payload validation, so a stale snapshot with a semantic defect is skipped as
stale, never parked (AC-09).

The staging table has no foreign key to `program` or `reservation`: an immediate key would
take `FOR KEY SHARE` on the program row before the program lock, breaking the lock order of
ADR 003. The use case validates tenant and program before loading the snapshot; an invoice
currency that differs between the snapshot and an existing reservation is detected on the
joined rows, after the diff and before any write, and parks the message (`currency-mismatch`).

### Why staging rows are keyed by message and run

Staging rows are keyed `(tenant_id, program_id, message_id, run_id, invoice_id)`; `run_id` is a
fresh id per execution of the use case (migration 0004). The first layout keyed them by
`(tenant_id, program_id, invoice_id)` and failed like this:

1. A consumer-group rebalance hands the same snapshot to two workers at once (Kafka is at
   least once; nothing stops this).
2. Both planning transactions run `DELETE` + `INSERT` for the same program. The second `INSERT`
   waits on the first one's uncommitted rows, then fails with `23505 unique_violation` when the
   first commits.
3. The consumer classifies SQLSTATE class 23 as permanent, so a valid snapshot was parked in the
   DLQ instead of being skipped as a duplicate.

With a run id, each execution plans over its own rows and never touches another's. The inbox
claim in the apply transaction still decides which one applies; the other returns
`duplicate`. Each execution deletes its own rows inside the apply transaction on every outcome
(applied, duplicate, stale) and in a best-effort cleanup if apply throws. Rows orphaned by a
crash between planning and apply carry `staged_at` and are swept by the retention job after one
hour. Proof: `AC-10 two concurrent deliveries of the same snapshot apply once and neither fails`
(`test/integration/reconcile.int.test.ts`).

Advisory locks and temporary tables were rejected for this fix: both pin a connection behind
RDS Proxy, and the run key needs neither.

## Consequences

- The program lock is held only for the version re-check and the set-based apply, not for
  parsing or comparing a large snapshot.
- Staging rows live only for one execution; nothing accumulates.
- `ReconciliationDriftDetected` lists at most 100 drifts and carries `driftCount` and
  `truncated`, so a snapshot with thousands of drifts cannot exceed Kafka's 1 MB message limit
  and block the outbox for every tenant. Every drift is still logged and recorded in the
  ledger.
- Treasury wins wherever it has an opinion; where it is silent about something it should
  know, the service keeps the larger exposure (HOLD).

## Alternatives rejected

Planning the diff in memory without a staging table (PRD §8 non-conformance), a staging
table with immediate foreign keys (lock-order violation, ADR 003), reading all reservations
inside the program lock (writers wait for the whole snapshot).
