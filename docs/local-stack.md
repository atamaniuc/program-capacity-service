# Local stack

Everything `make up` and `make up-all` start, from one file:
[`deploy/compose.yaml`](../deploy/compose.yaml) (Compose project `program-capacity`). Local
development and demos only: passwords are in the file, the tools have no login.

## Profiles

| Command | Profile | Services | Use it for |
| --- | --- | --- | --- |
| `make up` | default | `postgres`, `kafka`, `kafka-init`, `oauth`, `migrate`, `api`, `worker` | The service itself: API, treasury input, outbound events. Enough for `make seed`, `make demo`, `make qa`, `make load` |
| `make up-all` | `observability` | The default seven, plus `prometheus`, `grafana`, `jaeger`, `kafka-ui` | Looking inside: metrics and alerts, dashboards, traces, Kafka topics and consumer lag |
| `make down` | both | Everything above | Stop and delete all data (containers, the database volume, the network) |

Both `up` commands build the image, start in dependency order and return only when every
service is healthy (`--wait`); a service that fails its health check fails the command.
`make up-all` also sets `OTEL_ENABLED=true`, so `api` and `worker` are recreated with tracing
on. Going back is `make down`, then `make up`.

`make ps` shows the containers and their health, `make logs` follows `api` and `worker`.

Start order (`make up-all`; the four tools only there):

```mermaid
flowchart LR
  postgres --> migrate
  kafka --> kafka-init
  migrate --> api & worker
  kafka-init --> api & worker
  oauth --> api & worker
  kafka-init --> kafka-ui
  prometheus --> grafana
```

`api` and `worker` wait for `migrate` and `kafka-init` to **finish** and for `oauth` to be
healthy. `prometheus`, `grafana` and `jaeger` wait for nothing; Prometheus retries its scrapes
until `api` and `worker` answer.

## Ports

| Port | Service | Profile |
| --- | --- | --- |
| 13000 | `api`: business API (JWT required) | default |
| 19464 | `api` ops port: `/health/*`, `/metrics`, `/docs` (Swagger UI), `/docs/asyncapi` | default |
| 19465 | `worker` ops port: `/health/*`, `/metrics` | default |
| 15432 | `postgres` | default |
| 39092 | `kafka`, external listener for tools on your machine | default |
| 18081 | `oauth`: token endpoint and JWKS | default |
| 18080 | `kafka-ui` | observability |
| 13001 | `grafana` | observability |
| 19090 | `prometheus` | observability |
| 26686, 14318 | `jaeger`: UI, OTLP over HTTP | observability |

`make doctor` checks the default ports. If one is taken, `make up` fails on that service;
stop whatever listens there (`lsof -nP -iTCP:<port> -sTCP:LISTEN`).

## Default profile

### postgres

PostgreSQL 18, the single source of truth (ADR 002): programs, reservations, ledger, inbox,
outbox, idempotency rows. User, password and database are all `capacity`. Data lives in an
anonymous volume that `make down` deletes.

- Healthy when `pg_isready` answers.
- Look inside:
  `docker compose -f deploy/compose.yaml exec postgres psql -U capacity -d capacity`, or any
  client at `postgres://capacity:capacity@localhost:15432/capacity`.

### kafka

Apache Kafka 4.2, one node that is broker and KRaft controller at once (no ZooKeeper).
Replication factor 1, topic auto-creation **off**: a typo in a topic name fails instead of
creating a topic. Two listeners:

| Listener | Address | Who uses it |
| --- | --- | --- |
| `PLAINTEXT` | `kafka:9092` | Containers: `api`, `worker`, `kafka-init`, `kafka-ui` |
| `EXTERNAL` | `localhost:39092` | Tools on your machine: `make seed`, `make demo`, `make qa`, the simulator, `make dlq-replay`, `npm run contracts:events` |

- Healthy when `kafka-broker-api-versions.sh` gets an answer.
- Look inside: `make events` (tails `capacity.events.v1`), or Kafka UI in `make up-all`.

### kafka-init

A one-shot container from the same Kafka image. It creates six topics with 6 partitions each
and exits:

| Topic | Direction |
| --- | --- |
| `treasury.capacity.v1` | In: `ProgramLimitSet`, `RepaymentReceived`, `ProgramReconciled` |
| `treasury.fx-rates.v1` | In: FX rates |
| `capacity.events.v1` | Out: every committed change |
| `<each>.dlq` | Records the service could not process, with `x-error-*` headers. `capacity.events.v1.dlq` exists for symmetry; nothing writes it |

It shows as `Exited (0)` in `make ps`; that is its success state. It is idempotent
(`--if-not-exists`), so `make up` on a running stack is safe. The message formats are on the
AsyncAPI page (`make docs-events`).

### oauth

[mock-oauth2-server](https://github.com/navikt/mock-oauth2-server) 3.0.1, standing in for the
bank's identity provider. Config: [`deploy/oauth/config.json`](../deploy/oauth/config.json).

- Issuer `http://localhost:18081/default`, JWKS at `/default/jwks`; the service checks tokens
  against it (ADR 011).
- Any `client_id` gets a token for the `client_credentials` grant, with any secret. The client
  id becomes `sub` and `tenant_id`, so the client id **is** the bank: `bank-a`, `bank-b`,
  `bank-c`. The requested `scope` is copied into the token (`capacity:read`,
  `capacity:write`). Tokens live one hour.
- Get one: `make token TENANT=bank-a SCOPES="capacity:read"`, or **Authorize** in Swagger UI.

### migrate

The service image with `node …/migrate.js`: applies the SQL migrations from
`src/capacity/adapters/out/postgres/migrations/` and exits (ADR 012). It runs before `api` and `worker`, so schema changes never race with
traffic. `Exited (0)` is success; a failed migration stops `make up` and the reason is in
`docker compose -f deploy/compose.yaml logs migrate`.

### api

The service with `APP_ROLE=api` (ADR 001): the HTTP API on 13000 and the ops port on 19464. It
never talks to Kafka: a change writes an outbox row in the same transaction, and `worker`
publishes it.

- Healthy when `GET :19464/health/ready` is 200: every dependency check is `up`, and the body
  names the one that is `down`.
- Local-only settings in compose: `CORS_ORIGINS` (Swagger UI on 19464 calls the API on 13000)
  and `OAUTH_TOKEN_URL` (the login form of Swagger UI). Both are off by default.
- Look inside: <http://localhost:19464/docs>, `curl -s localhost:19464/metrics`, `make logs`.

### worker

The same image with `APP_ROLE=worker`. Its ops port 19464 is published as 19465. It runs:

- the treasury consumer, group `program-capacity-treasury`: reads both treasury topics, one
  transaction per message, inbox deduplication, broken records to the DLQ (ADR 007);
- the outbox relay: publishes `capacity.events.v1` in commit order under a lease (ADR 009);
- scheduled jobs: the invariant check and retention cleanup.

Healthy when `GET :19465/health/ready` is 200. Its metrics (`outbox_lag`,
`dlq_messages_total`, `invariant_mismatch_programs`, `programs_over_limit`) are on
`localhost:19465/metrics`.

## Observability profile

Started by `make up-all`; nothing in the default profile depends on these four.

### prometheus

Prometheus 3.5, <http://localhost:19090>. Config:
[`deploy/observability/prometheus.yml`](../deploy/observability/prometheus.yml).

- Scrapes `api:9464` (job `capacity-api`) and `worker:9464` (job `capacity-worker`) every 5 s
  and keeps one day of data.
- Evaluates the alert rules in
  [`alerts.yaml`](../deploy/observability/alerts.yaml): `DlqGrowing`, `OutboxLagHigh`,
  `InvariantMismatch`, `ProgramOverLimit`, `ApiErrorRateHigh`. There is no Alertmanager:
  alerts are visible on **Alerts** and are not sent anywhere. What to do for each is in the
  [runbook](runbook.md).
- Check: **Status → Targets** shows both jobs `UP`.

### grafana

Grafana 12.1, <http://localhost:13001>, anonymous admin (no login). Prometheus is provisioned
as the data source and the **Program Capacity Service** dashboard
([`capacity.json`](../deploy/observability/grafana/dashboards/capacity.json)) is the home
page: requests per second by route, 4xx/5xx, latency p50/p95/p99, outbox lag and oldest age,
invariant mismatches, programs over limit, dead letters, retention cleanup, event loop lag
and heap.

- Check: run `make demo` or `make load` and watch the request and outbox panels move.
- Dashboard edits in the UI are lost on `make down`; change the JSON file instead.

### jaeger

Jaeger 1.71 all-in-one, <http://localhost:26686>; it receives OTLP over HTTP on 14318 (ADR 013).
Spans come only when `OTEL_ENABLED=true`, which `make up-all` sets.

- Service `program-capacity`, from both `api` and `worker`. An API request is one trace: the
  `POST`/`GET` span with every SQL statement under it (`START`, `SELECT … FOR UPDATE`,
  `INSERT`, `UPDATE`, `COMMIT`). Ops-port calls (`/health`, `/metrics`) are not traced.
- Kafka is not instrumented: the trace ends at the outbox insert, and the worker's relay,
  consumer and jobs show up as separate traces of SQL spans.
- Check: reserve something in Swagger UI, then **Search** → service `program-capacity`,
  operation `POST` → **Find Traces**.
- Traces are in memory and disappear with the container.

### kafka-ui

[Kafka UI](https://github.com/kafbat/kafka-ui) (`kafbat/kafka-ui` 1.5.0),
<http://localhost:18080> (`make kafka-ui`), connected to `kafka:9092`. Topics, every record
with key and headers, consumer groups and lag, DLQ contents; it can also produce a record.
No login, and it can delete topics: deleting one breaks `worker` until `make down` and
`make up-all`. About 450 MB of memory.

How to check the service with it, step by step:
[qa.md → Kafka in the browser](qa.md#kafka-in-the-browser-kafka-ui).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `make up` fails with `port is already allocated` | Something else listens on that port. `make doctor` names it |
| `make up` fails on `migrate` | A migration failed: `docker compose -f deploy/compose.yaml logs migrate` |
| `api` or `worker` unhealthy | `curl -s localhost:19464/health/ready` (`19465` for the worker) names the dependency that is `down`; `make logs` |
| Reservations in a foreign currency fail with `fx-rate-unavailable` | FX rates from `make seed` are valid 24 hours: run `make seed` again |
| Jaeger has no `program-capacity` service | The stack was started with `make up`, not `make up-all` (tracing off) |
| Not enough memory | Measured: the default profile uses about 1.4 GB (Kafka alone about 0.9 GB), `make up-all` about 2.2 GB (Kafka UI 0.45 GB, Grafana 0.3 GB). Give Docker at least 4 GB |
