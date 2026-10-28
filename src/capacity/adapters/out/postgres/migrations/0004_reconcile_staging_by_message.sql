-- Reconciliation staging is keyed by the snapshot's message id and one execution (run) of it,
-- so two overlapping deliveries of the same snapshot never collide on the primary key (AC-10).
-- Staged rows are transient; any left by the old per-program layout are dropped. `staged_at`
-- lets the retention job sweep rows orphaned by a crash between planning and apply.

DELETE FROM reconcile_snapshot_row;

ALTER TABLE reconcile_snapshot_row
  ADD COLUMN message_id text NOT NULL,
  ADD COLUMN run_id     text NOT NULL,
  ADD COLUMN staged_at  timestamptz NOT NULL DEFAULT now();

ALTER TABLE reconcile_snapshot_row DROP CONSTRAINT reconcile_snapshot_row_pkey;
ALTER TABLE reconcile_snapshot_row
  ADD PRIMARY KEY (tenant_id, program_id, message_id, run_id, invoice_id);
