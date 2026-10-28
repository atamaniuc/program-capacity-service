# 006. Idempotency: stored responses under a tenant-scoped key

- Status: accepted
- Date: 2026-10-28

## Context

A platform retry must have exactly one effect, even while the first request runs (AC-02).

## Decision

`Idempotency-Key` is optional on every POST. The row is `(tenant_id, key, fingerprint,
status_code, response_body)`; the fingerprint is the sha256 of the canonical JSON of method,
route template, path ids and the normalised body. The claim is `INSERT … ON CONFLICT DO NOTHING
RETURNING` inside the business transaction; the response is written in the same transaction.
Same fingerprint: replay the stored response. Different: 422 `idempotency-key-mismatch`, nothing
stored. Business rejections (422, 409, and 404 for an unknown program or reservation) are stored
and replayed, so a new attempt needs a new key (AC-17). Validation and auth errors return before
the key is taken. Infrastructure errors roll everything back, including the key. Without a key,
natural keys deduplicate: one reservation per invoice, one release per `release_ref`. Keys are
kept 24 h or more (NFR-11).

## Consequences

- No lease or in-progress state: no external call; a crashed claim vanishes with its transaction.

## Alternatives rejected

Redis (PRD §7), a separate transaction for the key (crash window), storing only successes
(a retry could flip a 422 into a 201).
