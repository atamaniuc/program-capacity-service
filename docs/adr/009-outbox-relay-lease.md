# 009. Transactional outbox with a single relay under a TTL lease with epoch fencing

- Status: accepted
- Date: 2026-10-28

## Context

Downstream consumers (treasury, risk, notifications) need `ReservationCreated`,
`ReservationReleased`, `ProgramCapacityChanged` and `ReconciliationDriftDetected` in order per
program. Publishing to Kafka inside the request would couple the API to the broker and could lose
or invent events on a crash between the commit and the send.

## Decision

Every use case inserts an `outbox_event` row in the transaction of the change, with a gap-free
per-program `program_seq` taken under the program lock. A relay in the `worker` role publishes the
rows to `capacity.events.v1`, keyed `tenantId:programId`, in `(tenant, program, program_seq)`
order, with the event id and type in headers and the common envelope as value. It waits for the
broker acknowledgement (acks=all, idempotent producer) and then sets `published_at`.

Only one relay publishes, to keep the order. The `outbox_relay_lease` row holds `owner`, `epoch`
and `expires_at`:

- TTL 30 s, renewed on every batch. Time comes from the database (`now()`), not from workers.
- A worker takes the lease when it is free or expired (`epoch + 1`); the holder keeps its epoch
  while it renews in time.
- "Mark published" is one statement that updates the rows only if the lease row still has the
  caller's owner and epoch and has not expired. A stale holder that was paused or partitioned marks
  nothing; what it already sent is a duplicate.
- A graceful stop releases the lease so a standby takes over immediately.

Delivery is at least once. Consumers drop duplicates by event id and order by `program_seq`.

## Consequences

- A Kafka outage never touches the API; rows wait and drain on recovery (NFR-06). Lag is visible
  as `outbox_lag` and `outbox_oldest_unpublished_age_seconds`, with an alert.
- A crashed holder delays publishing by at most the TTL; that bounds the outage of the relay, not
  its correctness.
- One relay is a throughput ceiling (batches of 200 by default). The scale path is one lease per
  partition range of programs; not needed at the stated volumes.

## Alternatives rejected

Change data capture with Debezium (extra infrastructure for one table); `SELECT … FOR UPDATE SKIP
LOCKED` with many relays (breaks per-program order); advisory locks (session state, NFR-15);
publishing from the request path; Kafka transactions across the database and the broker (not
atomic with PostgreSQL).
