-- Core capacity schema (PRD section 6): eight state tables plus the outbox relay lease.
-- Money is BIGINT minor units; rates are NUMERIC(20,10); ids default to UUIDv7 (PostgreSQL 18).

CREATE TABLE program (
  tenant_id          text        NOT NULL,
  id                 text        NOT NULL,
  currency           text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  credit_limit_minor bigint      NOT NULL CHECK (credit_limit_minor >= 0),
  reserved_minor     bigint      NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  status             text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  version            bigint      NOT NULL DEFAULT 0 CHECK (version >= 0),
  treasury_seq       bigint      NOT NULL DEFAULT 0 CHECK (treasury_seq >= 0),
  platform_seq       bigint      NOT NULL DEFAULT 0 CHECK (platform_seq >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE reservation (
  id                     uuid        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id              text        NOT NULL,
  program_id             text        NOT NULL,
  invoice_id             text        NOT NULL,
  invoice_amount_minor   bigint      NOT NULL CHECK (invoice_amount_minor > 0),
  invoice_currency       text        NOT NULL CHECK (invoice_currency ~ '^[A-Z]{3}$'),
  fx_rate                numeric(20, 10) NOT NULL CHECK (fx_rate > 0),
  fx_rate_source         text        NOT NULL,
  fx_rate_at             timestamptz NOT NULL,
  amount_minor           bigint      NOT NULL CHECK (amount_minor > 0),
  released_minor         bigint      NOT NULL DEFAULT 0,
  -- Released amount in invoice currency: makes the remaining invoice amount known (money rule 5).
  released_invoice_minor bigint      NOT NULL DEFAULT 0,
  status                 text        NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED')),
  origin                 text        NOT NULL DEFAULT 'API'
                         CHECK (origin IN ('API', 'TREASURY', 'RECONCILIATION')),
  platform_seq           bigint      NOT NULL CHECK (platform_seq >= 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, program_id) REFERENCES program (tenant_id, id),
  -- I4: one reservation per (tenant, program, invoice).
  UNIQUE (tenant_id, program_id, invoice_id),
  -- I3: 0 <= released <= amount; the status follows from the numbers.
  CHECK (released_minor >= 0 AND released_minor <= amount_minor),
  CHECK (released_invoice_minor >= 0 AND released_invoice_minor <= invoice_amount_minor),
  CHECK ((status = 'RELEASED') = (released_invoice_minor = invoice_amount_minor)),
  CHECK (status <> 'RELEASED' OR released_minor = amount_minor),
  CHECK (status <> 'ACTIVE' OR released_invoice_minor = 0)
);

CREATE TABLE reservation_release (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  -- DEFERRABLE: an immediate FK check would take FOR KEY SHARE on the reservation row when the
  -- release_ref row is claimed, i.e. before the program lock, which breaks the lock order
  -- (dedup row -> program row -> reservation rows) and deadlocks two releases of one reservation.
  -- Deferred, the check runs at commit, when this transaction already holds the row FOR UPDATE.
  reservation_id       uuid        NOT NULL REFERENCES reservation (id) DEFERRABLE INITIALLY DEFERRED,
  release_ref          text        NOT NULL,
  fingerprint          text        NOT NULL,
  reason               text        NOT NULL CHECK (reason IN ('REPAID', 'CANCELLED')),
  -- Filled in the same transaction that claims the row; NULL never survives a commit.
  invoice_amount_minor bigint      CHECK (invoice_amount_minor > 0),
  amount_minor         bigint      CHECK (amount_minor >= 0),
  result               jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- I4: one release per (reservation, release_ref).
  UNIQUE (reservation_id, release_ref),
  CHECK ((invoice_amount_minor IS NULL) = (amount_minor IS NULL)
     AND (amount_minor IS NULL) = (result IS NULL))
);

CREATE TABLE ledger_entry (
  id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id            text        NOT NULL,
  program_id           text        NOT NULL,
  reservation_id       uuid        REFERENCES reservation (id),
  kind                 text        NOT NULL CHECK (kind IN ('RESERVE', 'RELEASE', 'LIMIT_SET', 'RECON_ADJUST')),
  delta_reserved_minor bigint      NOT NULL,
  delta_limit_minor    bigint      NOT NULL DEFAULT 0,
  limit_after          bigint      NOT NULL,
  reserved_after       bigint      NOT NULL,
  cause_type           text        NOT NULL,
  cause_id             text        NOT NULL,
  actor                text        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, program_id) REFERENCES program (tenant_id, id)
);
CREATE INDEX ledger_entry_program_idx ON ledger_entry (tenant_id, program_id, id);

-- NFR-09: ledger rows are never updated or deleted, enforced in the database.
CREATE FUNCTION ledger_entry_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entry is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER ledger_entry_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_append_only();
CREATE TRIGGER ledger_entry_no_truncate
  BEFORE TRUNCATE ON ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entry_append_only();

CREATE TABLE fx_rate (
  base   text            NOT NULL CHECK (base ~ '^[A-Z]{3}$'),
  quote  text            NOT NULL CHECK (quote ~ '^[A-Z]{3}$'),
  rate   numeric(20, 10) NOT NULL CHECK (rate > 0),
  source text            NOT NULL,
  as_of  timestamptz     NOT NULL,
  PRIMARY KEY (base, quote, as_of)
);

CREATE TABLE idempotency_key (
  tenant_id     text        NOT NULL,
  key           text        NOT NULL,
  fingerprint   text        NOT NULL,
  -- NULL only inside the transaction that claimed the key; a committed row is always complete.
  status_code   integer,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key),
  CHECK ((status_code IS NULL) = (response_body IS NULL))
);
CREATE INDEX idempotency_key_created_idx ON idempotency_key (created_at);

CREATE TABLE inbox_message (
  consumer     text        NOT NULL,
  message_id   text        NOT NULL,
  topic        text        NOT NULL,
  "partition"  integer     NOT NULL,
  "offset"     bigint      NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, message_id)
);

CREATE TABLE outbox_event (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    text        NOT NULL,
  program_id   text        NOT NULL,
  program_seq  bigint      NOT NULL,
  type         text        NOT NULL,
  payload      jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_event_unpublished_idx ON outbox_event (tenant_id, program_id, program_seq)
  WHERE published_at IS NULL;

-- One row: the holder with the highest epoch publishes; a stale holder's mark is rejected.
CREATE TABLE outbox_relay_lease (
  id         text        PRIMARY KEY,
  owner      text,
  epoch      bigint      NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL DEFAULT 'epoch'
);
INSERT INTO outbox_relay_lease (id) VALUES ('outbox-relay');
