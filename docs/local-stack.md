# Local stack

Everything `make up` and `make up-all` start, from one file:
[`deploy/compose.yaml`](../deploy/compose.yaml). Local development and demos only: passwords are
in the file, the tools have no login.

> **Branch `microservices`.** The Compose project is `program-capacity-ms` (on `main` it is
> `program-capacity`), every host port is `main`'s plus 10000, and four services are added to the
> default profile: `payments`, `funding-migrate`, `funding-api` and `funding-worker`. The two
> stacks can run side by side ([ADR 027](adr/027-repository-layout-and-side-by-side-isolation.md),
> `make isolation-live`). The Kubernetes version of this stack is at the end of this page.

## Quick start

### Requirements

| What | Version | Why |
| --- | --- | --- |
| Docker Desktop (macOS, Windows) or Docker Engine (Linux) | any recent; **≥ 4 GB memory** for Docker | PostgreSQL, Kafka, the OAuth2 server and the services run in containers; the tests start their own through Testcontainers |
| Docker Compose v2 plugin (`docker compose`, not `docker-compose`) | ≥ 2.20 | `make up` uses `up --wait` |
| Node.js and npm | Node 24 (`nvm install 24`) | The CLI tools (seed, token, simulator, demo) and the tests run on your machine |
| `make`, `curl` | any (macOS ships GNU Make 3.81, that is enough) | Every command is a make target; the API tour uses curl |
| `jq` | any; optional | Only `make qa` needs it |
| `kind`, `helm`, `kubectl` | optional | Only the cluster targets (`make kind-up` and the rest) need them |

Free ports: 13000 (API), 60051 (gRPC), 15432 (PostgreSQL), 18081 (OAuth2), 19464 (api ops + Swagger UI + AsyncAPI),
19465 (worker ops), 39092 (Kafka), and for the funding services 13100, 13200, 19466 and 19467. `make up-all` also needs
13001, 14318, 18080, 19090 and 26686. `make doctor` checks the capacity ports and says how to fix what is missing; it does not
check the four funding ports.

### Install and run

```bash
make install           # one command: check the machine, npm ci, start the stack, seed it (~2–3 min)
```

It runs `make doctor`, `npm ci`, `make up` (build the image, start everything, wait until
healthy) and `make seed` (3 banks, 6 programs in USD/EUR/AED/KWD, FX rates, ~200 invoices).
`make` on its own lists every command with a one-line description; `make completion` shows how
to turn on tab completion for targets and `TENANT=`/`TOPIC=` values in bash or zsh.

> **FX rates from `make seed` are valid for 24 hours.** On the day of a demo run `make seed`
> again (it is safe to repeat), or a reservation in a foreign currency (EUR invoice on a USD
> program) is refused with `422 fx-rate-unavailable`. Same-currency reservations are unaffected.

Try capacity:

```bash
TOKEN=$(make -s token TENANT=bank-a)

curl -s localhost:13000/v1/programs/prg_grand_usd/capacity -H "authorization: Bearer $TOKEN"

curl -s -X POST localhost:13000/v1/programs/prg_grand_usd/reservations \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -H "idempotency-key: $(uuidgen)" \
  -d '{"invoiceId":"INV-HELLO-1","amount":{"value":"125000.00","currency":"EUR"}}'
```

More in the [API tour](api.md). The funding saga by hand and `make demo-funding`:
[branch-technical-overview.md](branch-technical-overview.md#run-it-and-the-funding-demo). Then:

```bash
make demo              # plays every scenario (limit cut, repayments, late snapshot, duplicate
                       # and out-of-order messages, poison message, stale FX) and checks the results
make qa                # 103 QA checks: every endpoint and treasury message, plus DB, Kafka and
                       # metric side effects (test cases in qa.md)
make up-all            # the same stack plus Kafka UI, Prometheus, Grafana and Jaeger, tracing on
make down              # stop and delete everything (the tools too)
```

| URL | What |
| --- | --- |
| <http://localhost:13000/v1/…> | Business API (needs a token) |
| <http://localhost:13100/v1/funding-requests> | Branch only: the funding API (needs a token with a `funding:` scope; no Swagger UI, the contract is `services/funding/contracts/openapi.yaml`) |
| <http://localhost:19466/health/ready>, <http://localhost:19467/health/ready> | Branch only: readiness and `/metrics` of the funding `api` and `worker` |
| <http://localhost:19464/docs> | Swagger UI: **Authorize** (local OAuth2 login, client id = tenant), then **Try it out** on any endpoint (ops port, local only) |
| <http://localhost:19464/docs/asyncapi> | AsyncAPI: every Kafka topic the service reads and writes, with headers, keys and an example per message (`make events` tails `capacity.events.v1` live) |
| <http://localhost:18080> | Kafka UI, after `make up-all` (`make kafka-ui` opens it): topics, every record with key and headers, consumer lag, DLQs; can produce a treasury message ([how to check with it](qa.md#kafka-in-the-browser-kafka-ui)) |
| <http://localhost:19464/health/ready>, `/metrics` | Readiness and Prometheus metrics of `api` (`worker`: port 19465) |
| <http://localhost:13001>, <http://localhost:26686>, <http://localhost:19090> | Grafana (capacity dashboard), Jaeger (traces of api and worker), Prometheus, after `make up-all` |

## Running next to `main`

The branch lives in its own worktree and is built to run while `main`'s stack is up:

```bash
git worktree add ../finverity-microservices microservices
cd ../finverity-microservices
```

| | `main` | this branch |
| --- | --- | --- |
| Compose project | `program-capacity` | `program-capacity-ms` |
| PostgreSQL, Kafka, OAuth2 | 5432, 29092, 8081 | 15432, 39092, 18081 |
| Capacity API, api ops, worker ops | 3000, 9464, 9465 | 13000, 19464, 19465 |
| Capacity gRPC (internal, JWT on every call, `127.0.0.1` only) | none | 60051 |
| Funding API, funding api ops, funding worker ops | none | 13100, 19466, 19467 |
| Payments mock (the payment rail) | none | 13200 |
| Prometheus, Grafana, Jaeger, OTLP | 9090, 3001, 16686, 4318 | 19090, 13001, 26686, 14318 |
| Kubernetes | none | kind cluster `finverity-ms`, kubeconfig in `.kind/kubeconfig` (never `~/.kube/config`); port-forwards on 23000-23099 |

`make isolation-live` starts both and checks that both are healthy at the same time (MS-02).

## Profiles

| Command | Profile | Services | Use it for |
| --- | --- | --- | --- |
| `make up` | default | `postgres`, `kafka`, `kafka-init`, `oauth`, `migrate`, `api`, `worker`; on the branch also `payments`, `funding-migrate`, `funding-api`, `funding-worker` | The services: capacity API, treasury input, outbound events, and the funding saga. Enough for `make seed`, `make demo`, `make demo-funding`, `make qa`, `make load` |
| `make up-all` | `observability` | The default eleven, plus `prometheus`, `grafana`, `jaeger`, `kafka-ui` | Looking inside: metrics and alerts, dashboards, traces, Kafka topics and consumer lag |
| `make down` | both | Everything above | Stop and delete all data (containers, the database volume, the network) |

Both `up` commands build the image, start in dependency order and return only when every
service is healthy (`--wait`); a service that fails its health check fails the command.
`make up-all` also sets `OTEL_ENABLED=true`, so `api` and `worker` are recreated with tracing
on. Going back is `make down`, then `make up`.

`make ps` shows the containers and their health, `make logs` follows capacity's `api` and
`worker`. The funding services are not in `make logs`; follow them with
`docker compose -f deploy/compose.yaml logs -f funding-api funding-worker payments`.

Start order (`make up-all`; the four tools only there):

```mermaid
flowchart LR
  postgres --> migrate
  postgres --> funding-migrate
  kafka --> kafka-init
  migrate --> api & worker
  kafka-init --> api & worker
  oauth --> api & worker
  funding-migrate --> funding-api & funding-worker
  oauth --> funding-api
  api --> funding-worker
  payments --> funding-worker
  kafka-init --> kafka-ui
  prometheus --> grafana
```

`api` and `worker` wait for `migrate` and `kafka-init` to **finish** and for `oauth` to be
healthy. `funding-api` waits for `funding-migrate` and `oauth`; `funding-worker` waits for
`funding-migrate`, for capacity's `api` to be healthy (it calls its gRPC port) and for `payments`
to have started. `prometheus`, `grafana` and `jaeger` wait for nothing; Prometheus retries its
scrapes until the services answer.

## Ports

| Port | Service | Profile |
| --- | --- | --- |
| 13000 | `api`: business API (JWT required) | default |
| 60051 | `api`: internal gRPC `CapacityService`, JWT on every call; published on `127.0.0.1` only (branch) | default |
| 19464 | `api` ops port: `/health/*`, `/metrics`, `/docs` (Swagger UI), `/docs/asyncapi` | default |
| 19465 | `worker` ops port: `/health/*`, `/metrics` | default |
| 13100 | `funding-api`: funding REST API (JWT with audience `funding-service`) (branch) | default |
| 19466 | `funding-api` ops port: `/health/*`, `/metrics` (branch) | default |
| 19467 | `funding-worker` ops port: `/health/*`, `/metrics` (branch) | default |
| 13200 | `payments`: the mock payment rail (branch) | default |
| 15432 | `postgres` | default |
| 39092 | `kafka`, external listener for tools on your machine | default |
| 18081 | `oauth`: token endpoint and JWKS | default |
| 18080 | `kafka-ui` | observability |
| 13001 | `grafana` | observability |
| 19090 | `prometheus` | observability |
| 26686, 14318 | `jaeger`: UI, OTLP over HTTP | observability |

`make doctor` checks the capacity ports (13000, 60051, 15432, 18081, 19464, 19465, 39092); it
does not check 13100, 13200, 19466 and 19467. If a port is taken, `make up` fails on that
service; stop whatever listens there (`lsof -nP -iTCP:<port> -sTCP:LISTEN`). Every host port can
be moved with its `HOST_PORT_*` variable (see `.env.example`).

## Default profile

### postgres

PostgreSQL 18, the single source of truth of each service (ADR 002): for capacity the programs,
reservations, ledger, inbox, outbox and idempotency rows; for funding (branch) the funding
requests, the attempt log, the outbox and the idempotency rows. One server, two databases, one
login role each ([ADR 023](adr/023-t3-funding-context-database-per-service.md)): the entrypoint
runs [`deploy/postgres/init-databases.sh`](../deploy/postgres/init-databases.sh) once, on an
empty data directory, as the bootstrap role `postgres`, and creates `capacity` and `funding`
(user, password and database all the same name). Neither role may connect to the other's
database. Data lives in an anonymous volume that `make down` deletes.

- Healthy when `pg_isready` answers for the `funding` role, which also proves the init script ran.
- Look inside:
  `docker compose -f deploy/compose.yaml exec postgres psql -U capacity -d capacity`, or any
  client at `postgres://capacity:capacity@localhost:15432/capacity`; the funding database is
  `psql -U funding -d funding` and `postgres://funding:funding@localhost:15432/funding`.
- **Old volume.** A volume created before the funding database existed has no `funding` role and
  the init script never runs on it, so `make up` fails, usually at `funding-migrate` with an
  authentication or "does not exist" error in its log. Run `make down` once (it already deletes
  the volume; `make down -v` is not the command, because `make` reads `-v` as its own option,
  prints its version and does nothing), then `make up`. The same note is in the
  [runbook](runbook.md#funding-first-boot-after-the-database-split-branch-microservices).

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

The service with `APP_ROLE=api` (ADR 001): the HTTP API on 13000, the internal gRPC API on
50051 (published as 60051 on `127.0.0.1`, [ADR 024](adr/024-grpc-driving-adapter.md)) and the ops
port on 19464. It never talks to Kafka: a change writes an outbox row in the same transaction,
and `worker` publishes it.

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

## Funding services (branch `microservices`)

Four more containers in the default profile. They are the funding service, its database
migration and the payment rail it pays through
([architecture](architecture.md#branch-microservices-funding-the-payment-rail-and-the-grpc-hop)).
`funding-api` and `funding-worker` run the same image, `funding-service:ms-local`.

### payments

The mock payment rail (`payments-mock:ms-local`). `POST /v1/payments` with an `Idempotency-Key`
stores the result under the key; `GET /v1/payments/{key}` returns it, or 404 when nothing was
committed. State is in memory: restarting the container forgets every payment. The rail has no
authentication. It is told how to misbehave by the invoice id:

| Invoice id starts with | What the rail does |
| --- | --- |
| `FAULT-DECLINE` | Refuses the payment (`422`, status `DECLINED`); nothing moves |
| `FAULT-TIMEOUT` | Commits the payment and never answers; a lookup by key finds it |
| `FAULT-5XX-<n>` | Answers `503` to the first `<n>` attempts under one key, with nothing committed |

- Port 13200 on the host (container 3200); its ops port (9466) is not published.
- Look inside: `curl -s localhost:13200/v1/payments/<key>` with a key such as
  `funding:<request id>:disburse`.

### funding-migrate

The funding image with `node src/funding/adapters/out/postgres/migrate.js`: applies the SQL
migrations of the `funding` database and exits. `Exited (0)` is success; the reason for a failure
is in `docker compose -f deploy/compose.yaml logs funding-migrate`.

### funding-api

The funding REST API on host port 13100 (container 3100) and its ops port on 19466. It verifies
the JWT against the same mock OAuth2 server as capacity, with audience `funding-service` and the
scopes `funding:write` and `funding:read`. It stores a request in state `RECEIVED` and answers
`202`; it never calls capacity or the rail. The contract is
[`services/funding/contracts/openapi.yaml`](../services/funding/contracts/openapi.yaml); a tour
with curl is in [api.md](api.md#funding-api-branch-microservices). There is no Swagger UI.

- Healthy when `GET :19466/health/ready` is 200: the database answers and the newest migration is
  recorded.
- Get a token: `make -s token TENANT=bank-a SCOPES="funding:write funding:read"`.
- Look inside: `curl -s localhost:19466/metrics`, the logs (one JSON line per event), and
  `psql -U funding -d funding` (`funding_request`, `saga_step_attempt`).

### funding-worker

The saga driver (`node src/worker.js`, ops port 19467). It polls for due requests (every 0.5 s
when idle), claims a batch and advances each request by one step: a risk check, `Reserve` on capacity over gRPC (`api:50051`),
`Disburse` on `payments`, and, after a definite payment failure, `Release`. It fetches a token
per tenant from the OAuth2 server (client `funding-service.<tenant>`) and sends the `Host` of the
configured issuer, so the token's `iss` matches what the services trust
([ADR 027](adr/027-repository-layout-and-side-by-side-isolation.md)).

Settings that matter (compose passes these; the defaults and their limits are in
[ADR 025](adr/025-funding-saga-orchestration.md) and checked at start-up):

| Variable | Default | What it does |
| --- | --- | --- |
| `FUNDING_RESERVE_DEADLINE` | 2 min | How long an unknown `Reserve` outcome is retried on the normal path |
| `FUNDING_DISBURSE_DEADLINE` | 15 min | How long an unknown payment outcome is retried before `NEEDS_ATTENTION` |
| `FUNDING_PAYMENT_TIMEOUT_MS` | 5000 | Timeout of one call to the rail |

Healthy when `GET :19467/health/ready` is 200: the database answers and the driver loop has
ticked recently; `down` names `db` or `loop`. Its metrics (`funding_requests{state}`,
`funding_oldest_request_age_seconds{state}`, `funding_step_attempts_total{step,class}`,
`funding_requests_final_total{state}`) are on `localhost:19467/metrics`.

### Try the saga: `make demo-funding`

```bash
make up && make seed
make demo-funding
```

The demo recreates `funding-worker` with `FUNDING_DISBURSE_DEADLINE=15s` and a 2 s payment
timeout (so the needs-attention path does not wait 15 minutes), creates a fresh program through a
Kafka limit message, submits six funding requests and prints one line each:

```text
PASS  completed              COMPLETED  capacity reserved 0.00 -> 1000.00  [+1000.00 held]
PASS  risk-declined          REJECTED (risk-declined)  capacity reserved 1000.00 -> 1000.00  [unchanged, no call]
...  (four more lines, shortened here)
demo-funding: all scenarios passed
```

then restores the worker. Exit code 0 means every scenario ended as expected. The six scenarios
(completed, risk-declined, insufficient-capacity, payment-declined, rail-unavailable,
lost-payment-answer) are in [branch-technical-overview.md](branch-technical-overview.md#run-it-and-the-funding-demo).
It needs capacity's `api`, the Kafka `worker`, the funding services and `payments` all healthy.

## Observability profile

Started by `make up-all`; nothing in the default profile depends on these four.

### prometheus

Prometheus 3.5, <http://localhost:19090>. Config:
[`deploy/observability/prometheus.yml`](../deploy/observability/prometheus.yml).

- Scrapes `api:9464` (job `capacity-api`), `worker:9464` (job `capacity-worker`) and, on the
  branch, `funding-api:9464` and `funding-worker:9464` (jobs `funding-api`, `funding-worker`)
  every 5 s and keeps one day of data.
- Evaluates the alert rules in
  [`alerts.yaml`](../deploy/observability/alerts.yaml): `DlqGrowing`, `OutboxLagHigh`,
  `InvariantMismatch`, `ProgramOverLimit`, `ApiErrorRateHigh` and, on the branch,
  `FundingNeedsAttention`, `FundingCompensationStuck`, `FundingReserveUnresolved`. There is no Alertmanager:
  alerts are visible on **Alerts** and are not sent anywhere. What to do for each is in the
  [runbook](runbook.md).
- Check: **Status → Targets** shows every job `UP` (four on the branch).

### grafana

Grafana 12.1, <http://localhost:13001>, anonymous admin (no login). Prometheus is provisioned
as the data source and the **Program Capacity Service** dashboard
([`capacity.json`](../deploy/observability/grafana/dashboards/capacity.json)) is the home
page: requests per second by route, 4xx/5xx, latency p50/p95/p99, outbox lag and oldest age,
invariant mismatches, programs over limit, dead letters, retention cleanup, event loop lag
and heap.

- Check: run `make demo` or `make load` and watch the request and outbox panels move. The
  dashboard covers capacity only; the funding metrics are in Prometheus, not on a panel.
- Dashboard edits in the UI are lost on `make down`; change the JSON file instead.

### jaeger

Jaeger 1.71 all-in-one, <http://localhost:26686>; it receives OTLP over HTTP on 14318 (ADR 013).
Spans come only when `OTEL_ENABLED=true`, which `make up-all` sets.

- Service `program-capacity`, from both `api` and `worker` (the funding services are not
  instrumented, so a trace does not continue into them). An API request is one trace: the
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
| `make up` fails at `funding-migrate` | Usually an old data volume with no `funding` role (see "Old volume" under postgres): `make down`, then `make up`. Otherwise read `docker compose -f deploy/compose.yaml logs funding-migrate` |
| `make demo-funding` ends with `token endpoint answered ...` or `program ... did not appear` | The stack is not up or not healthy: `make ps`; the second one means capacity's `worker` is not consuming Kafka |
| A funding request stays in `RECEIVED` or `RESERVING` | `curl -s localhost:19467/health/ready`, then `docker compose -f deploy/compose.yaml logs funding-worker` ("step failed"). Usual cause: capacity's `api` is down or the tenant's token is refused (`401`) |
| A funding request is `NEEDS_ATTENTION` | Expected for `FAULT-5XX-999` invoices. Otherwise follow the [runbook](runbook.md#funding-a-request-needs-attention-fundingneedsattention) |
| Jaeger has no `program-capacity` service | The stack was started with `make up`, not `make up-all` (tracing off) |
| Not enough memory | Measured on `main`, before the funding services were added: the default profile used about 1.4 GB (Kafka alone about 0.9 GB), `make up-all` about 2.2 GB (Kafka UI 0.45 GB, Grafana 0.3 GB). The branch adds four small Node containers (not re-measured). Give Docker at least 4 GB |

## Kubernetes (branch `microservices`)

The same system runs in a local kind cluster, `finverity-ms`, with Helm charts in
[`deploy/helm/`](../deploy/helm/) ([ADR 026](adr/026-helm-and-kind.md),
[ADR 029](adr/029-api-gateway.md)). It is separate from Compose: Compose is the fast loop, kind is
the check that the system deploys. Needs `kind`, `helm` and `kubectl` (`make doctor` warns when
they are missing and does not fail).

| Command | What it does |
| --- | --- |
| `make helm-check` | `helm lint`, `helm template` and kubeconform for every chart; needs no cluster |
| `make kind-up` | Creates the cluster, builds and loads the three `:ms-local` images, installs `local-infra` (PostgreSQL with both databases, Kafka, mock OAuth2, payments mock), `capacity`, `funding`, Envoy Gateway and the `gateway` chart, seeds capacity |
| `make kind-smoke` | `helm test` for capacity, funding and the gateway, run as Pods inside the cluster |
| `make kind-forward` | Port-forwards to the host: gateway 23050, capacity HTTP 23000, gRPC 23001, ops 23002, funding 23010, OAuth2 23020, payments 23030, PostgreSQL 23040 |
| `make kind-token` | A token valid in the cluster (its issuer is the in-cluster address; a Compose token is refused there by design) |
| `make kind-down` | Deletes cluster `finverity-ms` and its kubeconfig `.kind/kubeconfig`, nothing else |

The cluster has no host port mappings and every `kubectl` and `helm` call names its own
kubeconfig, so `~/.kube/config` is never read or written. Not built: a real cluster, NetworkPolicy
(kind's default network plugin does not enforce it), autoscaling, a service mesh.
