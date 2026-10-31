# 010. Ledger as audit trail behind a projection

- Status: accepted
- Date: 2026-10-28

## Context

Every number must be explainable (requirement FR-11, invariant I5 of the PRD), but event sourcing is a settled non-goal.

## Decision

`program` holds the mutable projection. Each change to `reserved_minor` or `credit_limit_minor`
appends one `ledger_entry` in the same transaction with the deltas, `limit_after`,
`reserved_after`, cause (`http` plus request id or idempotency key), and actor (token `sub` or
`client_id`). Rows are append-only: a trigger raises on UPDATE, DELETE and TRUNCATE (NFR-09).
Ledger sums reproduce the projection; the invariant job (lane 0004) checks it.

## Consequences

- The ledger is evidence, not the source of truth; a mismatch is a bug alarm, not a rebuild.
- The table grows without bound; retention keeps it (PRD §5, NFR-11).

## Alternatives rejected

Event sourcing (settled), updating balances without an audit trail, privileges only (the table
owner can bypass grants; the trigger holds for every role).
