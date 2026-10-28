-- Treasury ingest (lane 0003): reconciliation staging table and supporting indexes.
-- The snapshot rows are loaded here and compared with the reservations by a set-based query
-- outside the program lock; under the lock the version is re-checked and only the diff is
-- applied (ADR 008).

CREATE TABLE reconcile_snapshot_row (
  tenant_id                 text        NOT NULL,
  program_id                text        NOT NULL,
  invoice_id                text        NOT NULL,
  invoice_currency          text        NOT NULL CHECK (invoice_currency ~ '^[A-Z]{3}$'),
  outstanding_invoice_minor bigint      NOT NULL CHECK (outstanding_invoice_minor > 0),
  outstanding_program_minor bigint      NOT NULL CHECK (outstanding_program_minor > 0),
  PRIMARY KEY (tenant_id, program_id, invoice_id)
);

CREATE INDEX reservation_open_idx ON reservation (tenant_id, program_id) WHERE status <> 'RELEASED';
CREATE INDEX inbox_message_processed_idx ON inbox_message (processed_at);
