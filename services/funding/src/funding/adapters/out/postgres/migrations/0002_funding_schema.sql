-- Funding schema (ADR 023, ADR 025). Money is BIGINT minor units; ids default to UUIDv7.

CREATE TABLE funding_request (
  id                     uuid        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id              text        NOT NULL,
  program_id             text        NOT NULL,
  invoice_id             text        NOT NULL,
  currency               text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor           bigint      NOT NULL CHECK (amount_minor > 0),
  state                  text        NOT NULL CHECK (state IN (
    'RECEIVED', 'RESERVING', 'DISBURSING', 'COMPENSATING',
    'COMPLETED', 'REJECTED', 'FAILED', 'NEEDS_ATTENTION')),
  reason                 text,
  reservation_id         text,
  payment_id             text,
  attempts               integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at        timestamptz NOT NULL DEFAULT now(),
  reserve_deadline_at    timestamptz,
  disburse_deadline_at   timestamptz,
  resolution_deadline_at timestamptz,
  lease_owner            text,
  lease_until            timestamptz,
  version                bigint      NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- A step with a business deadline always has one: a missing deadline must never mean unbounded retries.
  CONSTRAINT funding_request_reserve_deadline CHECK (state <> 'RESERVING' OR reserve_deadline_at IS NOT NULL),
  CONSTRAINT funding_request_disburse_deadline CHECK (state <> 'DISBURSING' OR disburse_deadline_at IS NOT NULL),
  CONSTRAINT funding_request_resolution_deadline CHECK (
    state <> 'COMPENSATING' OR reservation_id IS NOT NULL OR resolution_deadline_at IS NOT NULL),
  -- One funding request per invoice of a program (the natural key).
  UNIQUE (tenant_id, program_id, invoice_id),
  UNIQUE (tenant_id, id)
);
-- The driver claims due, unleased rows of a non-terminal state.
CREATE INDEX funding_request_due_idx ON funding_request (next_attempt_at)
  WHERE state IN ('RECEIVED', 'RESERVING', 'DISBURSING', 'COMPENSATING');

-- Append-only audit of every step attempt, with the key that was sent.
CREATE TABLE saga_step_attempt (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  request_id    uuid        NOT NULL REFERENCES funding_request (id),
  step          text        NOT NULL CHECK (step IN ('risk', 'reserve', 'disburse', 'release')),
  step_key      text,
  outcome_class text        NOT NULL CHECK (outcome_class IN ('success', 'failure', 'unknown')),
  state_before  text        NOT NULL,
  state_after   text        NOT NULL,
  detail        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saga_step_attempt_request_idx ON saga_step_attempt (request_id, created_at);

CREATE FUNCTION saga_step_attempt_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'saga_step_attempt is append-only' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER saga_step_attempt_no_update_delete
  BEFORE UPDATE OR DELETE ON saga_step_attempt
  FOR EACH ROW EXECUTE FUNCTION saga_step_attempt_append_only();
CREATE TRIGGER saga_step_attempt_no_truncate
  BEFORE TRUNCATE ON saga_step_attempt
  FOR EACH STATEMENT EXECUTE FUNCTION saga_step_attempt_append_only();

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

CREATE TABLE outbox_event (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    text        NOT NULL,
  request_id   uuid        NOT NULL REFERENCES funding_request (id),
  type         text        NOT NULL,
  payload      jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_event_unpublished_idx ON outbox_event (request_id, created_at)
  WHERE published_at IS NULL;
