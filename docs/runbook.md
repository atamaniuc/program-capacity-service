# Runbook

For the on-call engineer. Each critical path (CP-1 to CP-5, PRD §3) has a line below, followed by
the four operational entries from PRD §13. Commands assume the local compose stack
(`make up`); in production the same SQL runs through a read-only role and the same metrics come
from the ops port of each container.

## Where to look

| What | Where |
| --- | --- |
| Liveness, readiness | `curl -s localhost:19464/health/ready` (api), `localhost:19465` (worker). `down` names the failing dependency. |
| Metrics | `curl -s localhost:19464/metrics` (api), `localhost:19465/metrics` (worker). The relay and jobs report from the worker. |
| Logs | `make logs` (JSON, one line per event; `trace_id` is present when OpenTelemetry is on). |
| SQL | `docker compose -f deploy/compose.yaml exec postgres psql -U capacity capacity` |
| Kafka | `docker compose -f deploy/compose.yaml exec kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server kafka:9092 --topic capacity.events.v1 --from-beginning --max-messages 5`, or `make events` (headers, key and value). `npm run contracts:events` checks every event on the topic against `contracts/`. In a browser (`make up-all`): Kafka UI at `localhost:18080` (records with headers, consumer lag of `program-capacity-treasury`, DLQ contents). |
| Dashboards, traces | `make up-all` (compose profile `observability`, `OTEL_ENABLED=true`), then Grafana `localhost:13001`, Jaeger `localhost:26686`, Prometheus `localhost:19090`, Kafka UI `localhost:18080`. |
| Funding (branch `microservices`) | api `curl -s localhost:19466/health/ready`, worker `localhost:19467/health/ready` (`down` names `db` or `loop`) and `/metrics` (`funding_requests{state}`, `funding_oldest_request_age_seconds{state}`, `funding_step_attempts_total{step,class}`). SQL: `docker compose -f deploy/compose.yaml exec postgres psql -U funding funding`. |
| API docs | `localhost:19464/docs` (REST, Swagger UI) and `localhost:19464/docs/asyncapi` (Kafka topics, messages, headers), ops port only. |

Alert rules live in `deploy/observability/alerts.yaml`: `DlqGrowing`, `OutboxLagHigh`,
`InvariantMismatch`, `ProgramOverLimit`; on branch `microservices` also `FundingNeedsAttention`,
`FundingCompensationStuck`, `FundingReserveUnresolved`. Every alert below names its rule.

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
  localhost:13000/v1/programs/<programId>/capacity
curl -s -H "Authorization: Bearer $(make token SCOPES=capacity:read)" \
  "localhost:13000/v1/programs/<programId>/ledger?limit=20"
```

`treasurySeq` in the capacity response is the last applied treasury sequence; a message with a
lower or equal `seq` is skipped by design.

### CP-4 Bulk reconciliation

A snapshot that exceeds `RECON_MAX_RESERVATIONS` goes to the DLQ; `dlq_messages_total` rises
and `DlqGrowing` fires. Drift lines are
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

### Funding: the reserve retry window (branch `microservices`)

The saga repeats the `Reserve` call under one `Idempotency-Key` (`funding:<id>:reserve`) until
capacity gives a definite answer. A repeat is safe only while capacity still remembers that key:
**24 hours** (NFR-11, `RETENTION_IDEMPOTENCY_SECONDS`; capacity refuses to start with less).
After that, a repeat would meet the natural key `(tenant, program, invoice)`, get `EXISTING`,
and the saga would take its own reservation for someone else's and reject the request. So
reserve retries are bounded well inside the window ([ADR 025](adr/025-funding-saga-orchestration.md#exactly-once-effect-across-the-grpc-hop)):

| Setting | Default | What happens when it runs out |
| --- | --- | --- |
| `FUNDING_RESERVE_DEADLINE` | 2 min | The normal path stops waiting and moves to resolution |
| `FUNDING_RESERVE_RESOLUTION_LIMIT` | 12 h (half the retention) | The request goes to `NEEDS_ATTENTION` and is no longer retried |

On call:

- A request in `NEEDS_ATTENTION` after the reserve step may or may not hold a reservation in
  capacity. Do not re-drive it by hand under the same key once 24 hours have passed since its
  first reserve attempt: the key is gone and the answer would be `EXISTING`. The operator
  resolution procedure arrives with task T22 of the funding-saga work plan
  ([specs/0006-funding-saga/tasks.md](../specs/0006-funding-saga/tasks.md)).
- Do not raise `FUNDING_RESERVE_RESOLUTION_LIMIT`: funding refuses to start with a value above
  12 h. Capacity's retention can only go up (24 h floor), which only widens the margin.
- `Release` (the compensation) has no such limit. `release_ref` is a permanent natural key in
  capacity (ADR 006), so a compensation retried days later still replays its stored result.

### Funding: a request needs attention (`FundingNeedsAttention`)

A request is parked in `NEEDS_ATTENTION`: no step is due and the saga does nothing more on its
own. The reason says why; the reservation (if any) is still held in capacity, the safe direction.

```sql
-- docker compose -f deploy/compose.yaml exec postgres psql -U funding funding
SELECT id, tenant_id, program_id, invoice_id, reason, reservation_id, payment_id, updated_at
  FROM funding_request WHERE state = 'NEEDS_ATTENTION' ORDER BY updated_at;
SELECT step, step_key, outcome_class, state_before, state_after, created_at
  FROM saga_step_attempt WHERE request_id = '<id>' ORDER BY created_at, id;
```

| `reason` | Meaning | What to do |
| --- | --- | --- |
| `disbursement-unknown` | The rail never answered within `FUNDING_DISBURSE_DEADLINE`. Money may have left. **Never release capacity on a guess.** | Ask the rail: `GET /v1/payments/funding:<id>:disburse` (the mock answers `PAID`/`DECLINED`, 404 means nothing was committed). Paid: the request is complete, mark it by hand below. Not paid: release by hand (next section). |
| `reserve-unresolved` | The reserve answer stayed unknown past `FUNDING_RESERVE_RESOLUTION_LIMIT`. | See "Funding: an unresolved reserve". |
| `release-failed:<problem>` | Capacity gave an unexpected definite answer to the compensation (for example `not-found`). | Look the reservation up in capacity (`GET /v1/programs/<program>/reservations/<reservationId>`); if it is still held, release by hand (next section). |

**Manual release with the saga's `releaseRef`.** The compensation is one natural key in capacity,
`release_ref = funding:<id>:compensation` (permanent, ADR 006), so releasing through REST by hand
cannot double-release even if the saga retries:

```sh
TOKEN=$(make token TENANT=<tenant> SCOPES="capacity:write")
curl -s -X POST localhost:13000/v1/programs/<programId>/reservations/<reservationId>/releases \
  -H "authorization: Bearer $TOKEN" -H "idempotency-key: manual-<id>-release" \
  -H 'content-type: application/json' \
  -d '{"releaseRef":"funding:<id>:compensation","reason":"CANCELLED"}'
```

A `200` or `201` means released; `release-exceeds-remaining` means someone already released it
all. Then close the request in the funding database (the operator command arrives after the MVP
cut; until then this is the only way, and it is an audited manual change):

```sql
UPDATE funding_request SET state = 'FAILED', reason = 'manual-release', version = version + 1,
       updated_at = now() WHERE id = '<id>' AND state = 'NEEDS_ATTENTION';
-- or, when the rail confirms the payment:
UPDATE funding_request SET state = 'COMPLETED', payment_id = '<paymentId>', version = version + 1,
       updated_at = now() WHERE id = '<id>' AND state = 'NEEDS_ATTENTION';
```

### Funding: a compensation is stuck (`FundingCompensationStuck`)

The oldest `COMPENSATING` request is older than 15 minutes: the `Release` keeps getting an unknown
answer (capacity down, deadline, `UNAVAILABLE`). It retries forever with capped backoff, so the
cause is almost always capacity: `curl -s localhost:19464/health/ready`, then the worker logs
(`make logs`, "step failed"). Capacity stays reserved meanwhile (over-reserved, the safe
direction). When capacity is back the next retry succeeds: same key `funding:<id>:release`, same
`release_ref`, so the release happens exactly once. Nothing to do by hand unless capacity is gone
for good; then use the manual release above.

### Funding: an unresolved reserve (`FundingReserveUnresolved`)

A `COMPENSATING` request has no reservation id after more than an hour: the reserve answer was
lost and the repeat under the same key keeps failing. Whether capacity holds the reservation is
unknown. The retry is safe only while capacity still has the key (24 h); the saga itself parks the
request at `FUNDING_RESERVE_RESOLUTION_LIMIT` (12 h). To resolve earlier, ask capacity:
`GET /v1/programs/<program>/reservations?invoiceId=<invoice>` (or the ledger: `SELECT * FROM
reservation WHERE invoice_id = '<invoice>'` in the capacity database). Found: release it with the
manual release above, using the reservation id found. Not found: nothing was held; set the funding
request `FAILED` with the SQL above. Do not re-drive the saga by hand after 24 h: the key is gone and
the answer would be `EXISTING`.

### Funding: first boot after the database split (branch `microservices`)

The compose PostgreSQL now starts as the bootstrap role `postgres`, and `init-databases.sh`
creates the `capacity` and `funding` roles and databases once, on an empty data directory. A
volume from before that change has a superuser `capacity` and no `funding` database, and the
init script never runs on it. Run `make down` once (it already deletes the stack's volumes; `make down -v` would be read by `make` as its own option), then `make up`.

## Kind cluster (branch `microservices`)

The local Kubernetes deployment ([ADR 026](adr/026-helm-and-kind.md),
[ADR 029](adr/029-api-gateway.md)). Cluster `finverity-ms`, kubeconfig in `.kind/kubeconfig` only;
every `kubectl` and `helm` call in the Makefile names that file and the context
`kind-finverity-ms`, so your own cluster and `~/.kube/config` are never touched. It binds no host
port; reach it with `make kind-forward` (host ports 23000–23099: capacity 23000–23002, funding
23010, OAuth2 23020, payments 23030, Postgres 23040, gateway 23050).

| Command | What it does |
| --- | --- |
| `make kind-up` | Creates or reuses the cluster, builds and loads the three `:ms-local` images, installs `local-infra`, `capacity`, `funding`, seeds capacity's database, installs Envoy Gateway (`eg`, pinned) and the `gateway` release, then waits for the `Gateway` to be `Programmed` and the proxy Deployment to be available |
| `make kind-smoke` | `helm test` for capacity, funding (one completed and one compensated request, capacity's `reserved` checked before and after) and the gateway |
| `make kind-token TENANT=bank-a` | Prints a JWT whose issuer is the cluster issuer (needs `make kind-forward`) |
| `make kind-down` | Deletes cluster `finverity-ms` and `.kind/`; nothing else |

Where to look when it fails:

- **Everything through the gateway answers `fetch failed` or a connection error.** The proxy Pod is
  not ready yet. The proxy Service is `gateway-edge` in namespace **`envoy-gateway-system`**, not in
  `finverity-ms`: `kubectl --kubeconfig .kind/kubeconfig -n envoy-gateway-system get pods,svc`.
  `make kind-up` waits for it; a smoke started from another shell right after an upgrade may not.
- **`make kind-forward` and the gateway.** The gateway port-forward uses
  `--namespace envoy-gateway-system`; the other forwards use `finverity-ms`.
- **Funding answers `401` to a valid-looking token, or a token has the wrong `aud`.** The mock
  OAuth2 server reads its mapping only at start. The `local-infra` chart restarts its Pod when the
  config changes, but JWKS caches (gateway 30 s) need a moment: wait about 35 s after
  `make kind-up` before running the smoke by hand. A token minted at `http://oauth:8080` (the short
  Service name) has the wrong issuer; use `make kind-token` or the issuer constant
  `KIND_OAUTH_ISSUER`.
- **A wrong-audience token gets `403` through the gateway but `401` straight from the service.**
  Both are right; see [docs/api.md](api.md#through-the-gateway-kind-only).
- **`helm upgrade --install funding --wait` times out.** The Pods are ready only behind their ops
  port (`/health/ready` on 9464): look at `kubectl -n finverity-ms logs deploy/funding-api` and
  `deploy/funding-worker`, then at the `funding-migrate` Job.
- **Logs and events for a bug report:** `kubectl --kubeconfig .kind/kubeconfig --context
  kind-finverity-ms get pods,svc,events -A -o wide`, and `logs --all-containers` per Pod in
  `finverity-ms` and `envoy-gateway-system` (the CI job uploads exactly that on failure).

Checked on 2026-10-31: the node image `kindest/node:v1.35.8` and its digest in
`deploy/kind/cluster.yaml` are the ones listed in the kind v0.33.0 release notes, and Envoy Gateway
`v1.9.3` is the latest stable release (v1.10.0 is a release candidate).

## Deploys and shutdown

The service handles SIGTERM: readiness turns false at once so the load balancer drains, in-flight
requests finish, the relay hands back its lease, and the pool closes, all within 25 s (NFR-07).
Set the orchestrator's termination grace period to at least 30 s.

Migrations run as a one-shot job before `api` and `worker` start (compose `migrate`, Kubernetes
`deploy/k8s/migrate.yaml`). Migration 0004 empties the reconciliation staging table; run it
with the `worker` scaled to zero, so an old worker cannot lose the rows of a snapshot it is
applying at that moment. A worker stopped mid-snapshot is safe: the Kafka message is redelivered
and the inbox makes the second run idempotent.

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
