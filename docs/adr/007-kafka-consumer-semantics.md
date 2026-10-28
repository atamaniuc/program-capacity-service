# 007. Kafka consumer semantics: commit after DB, inbox dedup, DLQ and replay

- Status: accepted
- Date: 2026-10-28

## Context

Treasury messages arrive through Kafka and may be duplicated, reordered or late (FR-09).
A capacity change and its ledger, inbox, outbox and idempotency rows must commit in one
transaction, and a redelivered message must have no second effect (AC-10, I6).

## Decision

The consumer runs on `@confluentinc/kafka-javascript` (KafkaJS-compatible API), not plain
`kafkajs`, because it is the maintained Confluent client for JavaScript. One consumer group
`program-capacity-treasury` reads `treasury.capacity.v1` and `treasury.fx-rates.v1`; the
handler names the inbox consumer `treasury-capacity` and `treasury-fx` per topic. Records are
keyed by `tenantId:programId` (FX rates by currency pair), and the runner processes at most
one message in flight per partition while up to three partitions run concurrently.

For every record the order is:

1. Decode JSON and validate the envelope with zod. A record that cannot be decoded or
   validated is a permanent error.
2. For capacity messages, check that the Kafka key equals `tenantId:programId` of the body;
   a key that names another tenant or program is refused (`tenant-mismatch`).
3. Run the use case in one PostgreSQL transaction. The inbox row `(consumer, message_id)` is
   the dedup row: `INSERT … ON CONFLICT DO NOTHING` claims it, a duplicate skips. Then the
   program row is locked and a message with `seq ≤ treasury_seq` is skipped as stale (I7).
4. Commit the Kafka offset only after the DB commit, with `commitOffsets` and `autoCommit`
   off. A crash between the two replays the message, and the inbox absorbs it.

Transient failures (database down, DLQ publish failed) pause the partition and retry with
exponential backoff. Permanent failures (schema-invalid, unknown program, tenant mismatch,
unknown reservation, currency mismatch, release refused, snapshot invalid or oversized) are
published to `<topic>.dlq` with `x-error-code`, `x-error-message`, `x-original-topic`,
`x-original-partition` and `x-original-offset` headers, and the offset is then committed so
the partition keeps moving. A crash between the DLQ publish and the offset commit can park
the same record twice, so `tools/dlq-replay` deduplicates by `messageId` before republishing
to the source topic; the inbox makes the replay safe.

The runner exposes `state()` (`running`, `pausedPartitions`, `lastError`) and `check()`; the
worker role wires `check()` into `/health/ready` as the `kafka` check, so readiness reports
consumer state. The runner does not retry a Kafka outage at boot: connection errors surface
as a failed start and the process supervisor restarts the worker. On shutdown the
runner stops intake, waits up to 25 s for the in-flight record to finish its
transaction and commit its offset, then disconnects (NFR-07).

## Consequences

- Delivery is at least once; every consumer of this lane must be idempotent by inbox or
  natural key.
- One message in flight per partition preserves per-program order without a global consumer
  lock.
- DLQ records are original bytes plus error headers, so they can be replayed unchanged.

## Alternatives rejected

Auto-commit (an uncommitted DB transaction would be lost), `kafkajs` (superseded by the
Confluent client), a global single-message-in-flight consumer (unneeded serialisation).
