# Runbook

For the on-call engineer. Each critical path (CP-1 to CP-5, PRD §3) has a line below, followed by
the four operational entries from PRD §13. Commands assume the local compose stack
(`make up`); in production the same SQL runs through a read-only role and the same metrics come
from the ops port of each container.

## Where to look

| What | Where |
| --- | --- |
| Liveness, readiness | `curl -s localhost:9464/health/ready` (api), `localhost:9465` (worker). `down` names the failing dependency. |
| Metrics | `curl -s localhost:9464/metrics` (api), `localhost:9465/metrics` (worker). The relay and jobs report from the worker. |
| Logs | `make logs` (JSON, one line per event; `trace_id` is present when OpenTelemetry is on). |
| SQL | `docker compose -f deploy/compose.yaml exec postgres psql -U capacity capacity` |
| Kafka | `docker compose -f deploy/compose.yaml exec kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server kafka:9092 --topic capacity.events.v1 --from-beginning --max-messages 5` |
| Dashboards, traces | `docker compose -f deploy/compose.yaml --profile observability up -d`, then Grafana `localhost:3001`, Jaeger `localhost:16686`, Prometheus `localhost:9090`. |
| API docs | `localhost:9464/docs` (ops port only). |

Alert rules live in `deploy/observability/alerts.yaml`: `DlqGrowing`, `OutboxLagHigh`,
`InvariantMismatch`, `ProgramOverLimit`. Every alert below names its rule.

## Critical paths

### CP-1 Reserve under contention

Symptoms: 503 `service-unavailable` with `Retry-After: 1` on reserve, rising p95.
The 503 means a `lock_timeout` (5 s) or `statement_timeout` (15 s) fired on the hot `program` row.

```sql
-- who holds and who waits on a program row
SELECT pid, wait_event_type, state, now() - xact_start AS xact_age, left(query, 80)
  FROM pg_stat_activity WHERE datname = 'capacity' AND state <> 'idle' ORDER BY xact_start;
```

A long-idle `idle in transaction` holder is a bug in a caller of the database, not in a client:
terminate it with `SELECT pg_terminate_backend(<pid>)`. Clients retry safely with the same
`Idempotency-Key`; a timed-out transaction rolled back, key included.

### CP-2 Release

A release stuck in 422 `release-ref-mismatch` means the same `releaseRef` arrived with another
amount or reason: the first release is authoritative. Look at what was stored:

```sql
SELECT release_ref, reason, invoice_amount_minor, amount_minor, created_at
  FROM reservation_release WHERE reservation_id = '<reservation id>' ORDER BY created_at;
```

Repayments from treasury take the same path; a repayment for an unknown reservation lands in the
DLQ (see "DLQ grows").

### CP-3 Limit change

After a limit cut, `overLimitBy > 0` is expected (see "Program over limit"). Check the sequence
treasury has applied and the audit trail of the change:

```bash
curl -s -H "Authorization: Bearer $(make token SCOPES=capacity:read)" \
  localhost:3000/v1/programs/<programId>/capacity
curl -s -H "Authorization: Bearer $(make token SCOPES=capacity:read)" \
  "localhost:3000/v1/programs/<programId>/ledger?limit=20"
```

`treasurySeq` in the capacity response is the last applied treasury sequence; a message with a
lower or equal `seq` is skipped by design.

### CP-4 Bulk reconciliation

A snapshot that exceeds `RECON_MAX_RESERVATIONS` goes to the DLQ with an alert. Drift lines are
`RECON_ADJUST` ledger entries and `ReconciliationDriftDetected` events (see "Drift alert").

### CP-5 Multi-currency

422 `fx-rate-unavailable` means the newest rate for the pair is older than `FX_MAX_AGE`. Check:

```sql
SELECT base, quote, rate, source, as_of, now() - as_of AS age
  FROM fx_rate WHERE base = 'EUR' AND quote = 'USD' ORDER BY as_of DESC LIMIT 3;
```

Fix the cause upstream (treasury stopped publishing `FxRatePublished`); do not insert rates by
hand in production. Reservations already made keep the rate stored with them.

## Entries from PRD §13

### DLQ grows (`DlqGrowing`)

1. Inspect the error headers (`x-error-*`) of the newest messages:
   `docker compose -f deploy/compose.yaml exec kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server kafka:9092 --topic treasury.capacity.v1.dlq --from-beginning --max-messages 5 --property print.headers=true`
2. Fix the cause: a schema change on the treasury side, an unknown reservation in a repayment, a
   snapshot above `RECON_MAX_RESERVATIONS`.
3. Replay: `make dlq-replay TOPIC=treasury.capacity.v1.dlq FROM=<offset>`. The inbox makes
   reprocessing safe; DLQ tooling dedups by `messageId`, so a message copied twice is applied once.

### Relay stuck (`OutboxLagHigh`)

Symptom: `outbox_lag` (unpublished events) or `outbox_oldest_unpublished_age_seconds` keeps
growing while the API works. The API never depends on Kafka; events wait in `outbox_event`.

```sql
SELECT owner, epoch, expires_at, expires_at < now() AS expired FROM outbox_relay_lease;
SELECT count(*), min(created_at) FROM outbox_event WHERE published_at IS NULL;
```

- No worker running: start one (`APP_ROLE=worker` or `all`). Nothing is lost.
- Lease held by a stuck or dead worker: it expires after 30 s and another worker takes over with
  `epoch + 1`; a late "mark published" from the old holder is rejected. No manual step needed. To
  take over at once: `UPDATE outbox_relay_lease SET expires_at = 'epoch'`.
- Worker logs `outbox publish failed`: Kafka is unreachable or refusing. Check the broker and
  topic `capacity.events.v1`; the relay retries every poll interval and drains on recovery.
  Duplicates after recovery are normal (at-least-once); consumers drop them by event id.

### Drift alert

A `ReconciliationDriftDetected` event or a `RECON_ADJUST` ledger entry means treasury and the
platform disagreed. Compare the snapshot with the ledger of that program:

```sql
SELECT id, kind, delta_reserved_minor, reserved_after, cause_type, cause_id, created_at
  FROM ledger_entry WHERE tenant_id = '<tenant>' AND program_id = '<program>'
 ORDER BY id DESC LIMIT 50;
```

Items held under the default `RECON_MODE=HOLD` stay reserved until someone decides: release them
through the API after treasury confirms, or switch the policy with `RECON_MODE=RELEASE`.

The scheduled invariant check (every 5 minutes, `INVARIANT_CHECK_INTERVAL_SECONDS`) is a different
alarm (`InvariantMismatch`, gauge `invariant_mismatch_programs`): the program's `reserved_minor`
disagrees with its open reservations or its ledger. The worker log line has `event":"invariant-mismatch"`
with the three numbers. That is a bug or a manual change, never normal. Stop writers for the
program, find the first ledger entry whose `reserved_after` breaks the running sum, and correct
with a new compensating change rather than editing history (the ledger is append-only).

### Program over limit (`ProgramOverLimit`)

Expected after a limit cut below `reserved` (A10). New reservations answer 422
`program-over-limit`; releases and repayments still succeed. The program recovers by itself once
releases bring `reserved` under the limit; nothing to repair. Escalate only if treasury did not
intend the cut.

## Deploys and shutdown

The service handles SIGTERM: readiness turns false at once so the load balancer drains, in-flight
requests finish, the relay hands back its lease, and the pool closes, all within 25 s (NFR-07).
Set the orchestrator's termination grace period to at least 30 s.

## Worker and telemetry settings

Read from the environment by `src/platform/telemetry/settings.ts`; defaults match PRD §8.

| Variable | Default | Effect |
| --- | --- | --- |
| `OUTBOX_RELAY_ENABLED` | `true` | `false` turns the relay off in `worker` and `all` roles (events still accumulate). |
| `OUTBOX_LEASE_TTL_SECONDS` | `30` | Relay lease TTL, renewed on every batch. |
| `OUTBOX_BATCH_SIZE` / `OUTBOX_POLL_INTERVAL_MS` | `200` / `500` | Rows per publish, pause when idle. |
| `INVARIANT_CHECK_INTERVAL_SECONDS` | `300` | Invariant check period (FR-15). |
| `RETENTION_CLEANUP_INTERVAL_SECONDS` | `3600` | Retention cleanup period. |
| `RETENTION_IDEMPOTENCY_SECONDS` / `RETENTION_INBOX_SECONDS` / `RETENTION_OUTBOX_SECONDS` | 24 h / 7 d / 7 d | Age after which idempotency keys, inbox rows and published outbox rows are deleted. |
| `OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT` | `false`, from the SDK | Starts the OpenTelemetry SDK before the app; the compose `observability` profile points it at Jaeger. |
