# 008. Reconciliation: staged diff, contiguous watermark, tolerance, HOLD default

- Status: accepted
- Date: 2026-10-28

## Context

A `ProgramReconciled` snapshot carries the limit, every open reservation with outstanding
amounts in invoice and program currency, and a contiguous `platformWatermark`. Applying it
must follow the PRD §8 case table without holding the program lock for the length of the
snapshot (AC-08, AC-14, AC-15).

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
ADR 003. The table is transient per program, and the use case validates tenant, program and
invoice currency before loading it.

## Consequences

- The program lock is held only for the version re-check and the set-based apply, not for
  parsing or comparing a large snapshot.
- Staging rows of an applied snapshot stay until the next snapshot of that program replaces
  them.
- Treasury wins wherever it has an opinion; where it is silent about something it should
  know, the service keeps the larger exposure (HOLD).

## Alternatives rejected

Planning the diff in memory without a staging table (PRD §8 non-conformance), a staging
table with immediate foreign keys (lock-order violation, ADR 003), reading all reservations
inside the program lock (writers wait for the whole snapshot).
