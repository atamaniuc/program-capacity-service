# 014. REST conventions

- Status: accepted
- Date: 2026-10-28

## Context

Clients of a money API need stable, machine-readable outcomes.

## Decision

Versioned path `/v1`; additive changes only. Errors are RFC 9457 `application/problem+json`
with `type`, `title`, `status`, `detail` and no internals. `type` is the absolute URI
`https://errors.capacity.example/<problem>` (an identifier, not a page); clients branch on it,
not on status. Business problems: `insufficient-capacity`, `program-over-limit`,
`program-suspended`, `fx-rate-unavailable`, `release-exceeds-remaining` (422),
`reservation-conflict` (409), `idempotency-key-mismatch`, `release-ref-mismatch` (422),
`validation-error` (400), `not-found` (404). The transport adds `unauthorized` (401),
`forbidden` (403), `service-unavailable` (503, lock or statement timeout) and `internal-error`.
Use cases return `Outcome` values carrying the status; only the controller writes HTTP.
Amounts are decimal strings. `GET …/capacity` sets `ETag` to the program version and answers 304
to `If-None-Match`. Created reservations answer 201 with `Location`; replays 200.

## Consequences

Stored idempotent responses replay byte-for-byte equivalent bodies.

## Alternatives rejected

Error codes in a custom envelope, GraphQL (settled), HTTP status alone.
