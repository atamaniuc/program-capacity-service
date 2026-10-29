# Repository map

Every folder and file, what it is for, and which **layer** it belongs to. Use it as a lookup
table: find a path, read one line. For the big picture read [architecture.md](architecture.md)
first.

**Layers** (the arrows of the hexagon, enforced by `npm run depcruise`):

| Layer | Folder | May import | Holds |
| --- | --- | --- | --- |
| **Domain** | `src/capacity/domain/` | nothing outside itself | Business rules as pure TypeScript: money, FX, limit check, release split |
| **Application** | `src/capacity/application/` | domain | Use cases (one folder each), ports (interfaces the use cases need), shared helpers |
| **Adapter, driving** (in) | `src/capacity/adapters/in/` | application, domain | Entry points that call use cases: HTTP, Kafka consumer, scheduled jobs |
| **Adapter, driven** (out) | `src/capacity/adapters/out/` | application (ports), domain | Implementations of ports: PostgreSQL, Kafka producer, clock and ids |
| **Platform** | `src/platform/` | anything | Not business code: config, logging, health, telemetry, start-up per role |

Two more rules: one adapter never imports another, and one use-case slice never imports
another. Shared application code lives in `application/shared/`.

## Root

| File | Purpose |
| --- | --- |
| `README.md` | Start page: the problem, what was built, quick start |
| `Makefile` | The commands you type; `make` alone prints them all (`help`, coloured on a terminal, `NO_COLOR` respected). `install` (everything from a fresh clone), `doctor`, `up`, `seed`, `token`, `demo`, `qa`, `docs`, `verify`, `test`, `load`, `dlq-replay`, `status` |
| `.nvmrc` | Node.js major version (24) for `nvm use` |
| `package.json`, `package-lock.json` | Dependencies (exact versions) and npm scripts behind the Makefile |
| `tsconfig.json`, `tsconfig.build.json` | TypeScript settings for checking (includes tests) and for the build (only `src/`) |
| `eslint.config.js`, `.prettierrc`, `.prettierignore` | Lint and formatting rules; `make verify` fails on any warning |
| `.dependency-cruiser.cjs` | The layer rules above, as code |
| `vitest.config.ts` | Two test projects: `unit` (no Docker) and `int` (Testcontainers); 90% line coverage on domain and application |
| `Dockerfile`, `.dockerignore` | One multi-stage image for every role (`api`, `worker`, `migrate`); runs as a non-root user |
| `.env.example` | Every environment variable with a safe local value; copy to `.env` to run outside Docker |
| `.gitignore` | Build output, coverage, local env files, IDE folders |
| `AGENTS.md`, `CLAUDE.md` | Instructions for AI coding agents (see [development-process.md](development-process.md)) |
| `harnessimo.config.json` | Configuration of the process checker `npx harnessimo check` |

## `src/` — the service

### `src/main.ts`

Process entry point: loads config, starts the app for `APP_ROLE`, handles SIGTERM/SIGINT with a
bounded shutdown.

### `src/capacity/domain/` — Domain layer

| File | Purpose |
| --- | --- |
| `money.ts` | Money as `bigint` minor units plus ISO 4217 code; parsing and formatting decimal strings; scales (USD 2, KWD 3) |
| `fx-rate.ts` | FX rate with 10 decimals; conversion into program currency **rounding up**; rate age check |
| `program.ts` | The `Program` aggregate root: limit, reserved, status, version; the capacity check and over-limit rules |
| `reservation.ts` | A reservation: invoice and reserved amounts, released so far, status |
| `release.ts` | Release split: partial repayment frees a share rounded **down**, the last one the exact remainder |
| `ledger.ts` | Shape of one immutable ledger entry |
| `result.ts` | `ok` / `refused` result type for business refusals (no exceptions for expected outcomes) |
| `index.ts` | Public surface of the domain |
| `*.test.ts` | Unit tests next to each rule |

### `src/capacity/application/` — Application layer

**Use cases** (`use-cases/`, one folder each, never importing each other):

| Folder | Purpose | Called by |
| --- | --- | --- |
| `reserve-capacity/` | Reserve for one invoice: idempotency row → program lock → FX → check → write reservation, ledger, outbox | HTTP |
| `release-reservation/` | Release all or part of a reservation, by `releaseRef` | HTTP |
| `apply-treasury-event/` | Treasury `ProgramLimitSet` (set limit, create program) and `RepaymentReceived` (release) | Kafka |
| `ingest-fx-rate/` | Store a treasury `FxRatePublished` rate | Kafka |
| `reconcile-program/` | Apply a `ProgramReconciled` snapshot: stage, diff outside the lock, apply under the lock. `policy.ts` is the case table as pure functions | Kafka |
| `queries/get-capacity/` | Limit, reserved, available of one program | HTTP |
| `queries/get-reservation/` | One reservation with its releases | HTTP |
| `queries/list-reservations/` | Reservations of a program, keyset-paged | HTTP |
| `queries/get-ledger/` | Ledger of a program, oldest first, keyset-paged | HTTP |

**Ports** (`ports/`): interfaces the use cases need, implemented by driven adapters.

| File | Port |
| --- | --- |
| `transaction.ts` | Unit of work and the repositories used inside one transaction (program, reservation, release, ledger, outbox, idempotency) |
| `treasury.ts` | The treasury unit of work: inbox, treasury program and reservation repositories, snapshot staging |
| `read-model.ts`, `query-reader.ts` | Reads for the query use cases |
| `outbox-relay.ts` | Lease and unpublished rows for the outbox relay |
| `maintenance.ts` | Invariant check and retention cleanup queries |
| `system.ts` | Clock and id generator |
| `index.ts` | Re-exports |

**Shared** (`shared/`): code several slices use.

| File | Purpose |
| --- | --- |
| `release-capacity.ts` | The one release routine, used by both REST release and Kafka repayment |
| `idempotent.ts` | Runs a use case under an `Idempotency-Key`: claim, replay or store the outcome |
| `fingerprint.ts` | Canonical-JSON hash of a request, to detect a key reused with a different body |
| `problem.ts` | Business problem catalogue (`insufficient-capacity`, `not-found`, …) |
| `treasury-messages.ts` | zod schemas of the treasury Kafka messages and the topic names |
| `treasury-errors.ts` | Permanent errors that send a message to the DLQ |
| `views.ts` | Response shapes (capacity, reservation) built from domain objects |
| `cursor.ts` | Opaque page cursors |
| `request-context.ts` | Tenant, actor and request id recorded with every change |

### `src/capacity/adapters/in/` — Driving adapters

| Path | Purpose |
| --- | --- |
| `http/capacity.controller.ts` | REST: capacity, reserve, get reservation, release |
| `http/queries.controller.ts` | REST: list reservations, ledger |
| `http/schemas.ts`, `http/query-schemas.ts` | zod schemas: request validation **and** the source of `contracts/openapi.yaml` |
| `http/openapi.ts` | Builds the OpenAPI document from the schemas |
| `http/auth.ts` | JWT middleware (runs before body parsing), JWKS verification, scope guard, tenant from the token |
| `http/problem.ts`, `http/problem.filter.ts` | Maps every error to RFC 9457 `application/problem+json`; database outages to 503 |
| `kafka/consumer-runner.ts` | Kafka consumer loop: commit offset after the database, DLQ for permanent errors, pause and backoff for transient ones, drain on stop |
| `kafka/treasury-handler.ts` | Anti-corruption layer: decodes treasury messages, checks key against body, routes to the use case |
| `kafka/errors.ts` | Classifies errors as permanent (DLQ) or transient (retry) |
| `jobs/jobs.ts` | Scheduled jobs: invariant check every 5 minutes, retention cleanup |

### `src/capacity/adapters/out/` — Driven adapters

| Path | Purpose |
| --- | --- |
| `postgres/db.ts` | Connection pool and Kysely instance |
| `postgres/unit-of-work.ts` | One READ COMMITTED transaction per use case with local timeouts |
| `postgres/treasury-unit-of-work.ts` | The same for the Kafka consumer, plus the inbox |
| `postgres/migrate.ts` | Applies SQL migrations under a transaction-scoped advisory lock; knows the latest migration for readiness |
| `postgres/migrations/0001…0004_*.sql` | Schema, in order: baseline, core tables, treasury tables, staging keyed by message and run |
| `postgres/repositories/program.repository.ts` | `SELECT … FOR UPDATE` on the program row; the SQL guard behind the capacity check |
| `postgres/repositories/reservation.repository.ts`, `release.repository.ts` | Reservations and releases |
| `postgres/repositories/idempotency.repository.ts` | `INSERT … ON CONFLICT DO NOTHING` claim of an idempotency key (no `FOR UPDATE`) |
| `postgres/repositories/ledger-outbox.repository.ts` | Ledger and outbox inserts with a gap-free per-program sequence |
| `postgres/repositories/fx-rate.repository.ts` | Latest FX rates |
| `postgres/repositories/treasury.repository.ts` | Treasury writes and reconciliation staging and diff (set-based SQL) |
| `postgres/repositories/capacity-reader.ts`, `query.repository.ts` | Read side for the queries |
| `postgres/repositories/outbox-relay.repository.ts` | Relay lease (owner, epoch, TTL) and fenced "mark published" |
| `postgres/repositories/maintenance.repository.ts` | Invariant query, over-limit count, retention deletes |
| `postgres/repositories/rows.ts` | Row types and row-to-domain mapping |
| `kafka/outbox-relay.ts` | The relay loop in the `worker`: take or renew the lease, publish in order, mark published |
| `kafka/event-publisher.ts` | Idempotent Kafka producer for `capacity.events.v1` |
| `system/system.ts` | System clock and UUIDv7 ids |

### `src/capacity/capacity.module.ts`

NestJS module that wires ports to adapters for the `api` role.

### `src/platform/` — Platform

| Path | Purpose |
| --- | --- |
| `config/config.ts` | Reads and validates every environment variable with zod at start-up; names bad fields, never values |
| `bootstrap/start.ts` | Starts one role: HTTP app (CORS, auth, Nest), Kafka consumer, worker components, ops server; ordered shutdown |
| `bootstrap/worker.ts` | Builds the `worker` parts: treasury consumer, outbox relay, jobs |
| `bootstrap/app.module.ts` | Root Nest module; closes the pool last on shutdown |
| `bootstrap/shutdown.ts` | The 25 s shutdown deadline |
| `health/ops-server.ts` | The internal ops port: `/health/live`, `/health/ready`, `/metrics`, documents |
| `health/api-docs.ts` | Swagger UI at `/docs` and the OpenAPI JSON it loads |
| `logging/logger.ts` | pino JSON logger, also used by Nest |
| `telemetry/register.ts`, `otel.ts`, `trace-context.ts` | OpenTelemetry start-up (when `OTEL_ENABLED=true`) and trace ids in log lines |
| `telemetry/metrics.ts`, `http-metrics.ts` | Prometheus metrics: HTTP RED, outbox lag, invariant mismatches, over-limit programs, DLQ count, retention |
| `telemetry/settings.ts` | Worker settings (relay, jobs, retention) with NFR-11 floors |

## `test/` — tests that need more than one module

Unit tests sit next to the code (`src/**/*.test.ts`). Everything here is named after the
requirement it proves (`AC-…`, `FR-…`, `NFR-…`, `SK-…`).

| Path | Level | What it proves |
| --- | --- | --- |
| `architecture/layers.test.ts` + `fixtures/layer-leaks/` | unit | The layer rules reject deliberately leaking code, and pass on the real tree |
| `property/*.property.test.ts` | unit | Random reserve/release sequences never break the invariants (fast-check) |
| `integration/*.int.test.ts` | int | Real PostgreSQL: concurrency (`reserve-concurrency`), idempotency races, releases, FX, reconciliation, invariant job and retention, migrations, schema guards |
| `e2e/*.e2e.test.ts` | int | The HTTP app with a real JWT issuer: auth and tenants, capacity, queries, OpenAPI contract and Swagger, ops port, metrics and traces |
| `kafka/*.kafka.test.ts` | int | Real Kafka: treasury consumer (redelivery, DLQ, order), outbox relay (order, fencing), message contracts, the `all` role |
| `fault/*.fault.test.ts` | int | Outages and shutdown: Kafka or PostgreSQL down, SIGTERM drain |
| `support/` | — | Helpers: start PostgreSQL (`postgres.ts`), a test app (`app.ts`, `fault-app.ts`), a JWT issuer (`auth.ts`), in-memory ports for unit tests (`in-memory-ports.ts`, `capacity-world.ts`), outage containers |
| `kafka/support/` | — | Kafka container and topics, in-memory treasury world |

## `contracts/` — what other systems rely on

| File | Purpose |
| --- | --- |
| `openapi.yaml` | REST contract, **generated** from the zod schemas (`make contracts`); `make verify` fails if it is stale |
| `asyncapi.yaml` | Kafka topics and messages, in and out |
| `json-schema/*.schema.json` | JSON Schemas of the four treasury messages; the simulator and tests validate against them |

## `deploy/` — running it

| Path | Purpose |
| --- | --- |
| `compose.yaml` | Local stack: PostgreSQL 18, Kafka 4 (KRaft) and topic init, mock OAuth2, `migrate`, `api`, `worker`; profile `observability` adds Prometheus, Grafana, Jaeger |
| `oauth/config.json` | mock-oauth2-server: client id becomes the tenant, audience fixed to `capacity-service` |
| `observability/prometheus.yml`, `alerts.yaml` | Scrape targets and alert rules (DLQ growing, outbox lag, invariant mismatch, over limit) |
| `observability/grafana/` | Dashboard and its provisioning |
| `k8s/*.yaml` | Kubernetes starting point: namespace, config, migrate Job, `api` and `worker` Deployments with probes on the ops port |
| `k8s/examples/secret.example.yaml` | Shape of the database Secret; not applied, create the real one with `kubectl create secret` |

## `tools/` — commands for people

| Path | Behind | Purpose |
| --- | --- | --- |
| `token/token.ts` | `make token` | Prints a JWT from the local OAuth2 server |
| `simulator/` | `npm run simulate` | Treasury simulator: builds and publishes Kafka messages for named scenarios; also writes the message contracts |
| `demo/demo.ts` | `make demo` | Plays every scenario against the running stack and checks the results through the API |
| `dlq-replay/replay.ts` | `make dlq-replay` | Republishes fixed DLQ records to their source topic |
| `load/scenario.js` | `make load` | k6 load test (warm-up, spread phase with NFR-03 thresholds, hot phase) |
| `contracts/generate.ts`, `render.ts` | `make contracts` | Regenerates or checks `contracts/openapi.yaml` |
| `doctor.sh` | `make doctor`, `make install` | Checks the machine: Docker and its memory, Compose ≥ 2.20, Node.js 24, npm, curl, jq, free ports; says how to fix what is missing |
| `qa/run.sh`, `qa/publish.ts` | `make qa` | The [QA test cases](qa.md) as a script: every endpoint and treasury message, with database, Kafka and metric checks; `publish.ts` sends FX, snapshot and malformed records the simulator has no scenario for |
| `status.sh` | `make status` | Process checker result, last logged gate, last commits, next action |
| `completion.bash` | `make completion` | Tab completion for `make` in bash and zsh: targets, `TENANT=` and `TOPIC=` values |

## `db/seeds/seed.ts` — `make seed`

Deterministic demo data: 3 banks, 6 programs in USD, EUR, AED and KWD, FX rates and about 200
reservations. Limits and rates go through Kafka like real treasury input.

## `docs/` — reading

Index and reading order: [docs/README.md](README.md). Decision records: `docs/adr/`.

## CI and process

| Path | Purpose |
| --- | --- |
| `.github/workflows/ci.yml` | Process gates, lint, types, layer rules, contract drift, unit and integration tests, image build, Trivy and gitleaks scans |
| `.github/workflows/codeql.yml` | Static security analysis |
| `.github/workflows/zap.yml` | OWASP ZAP baseline scan of the running stack |
| `.github/dependabot.yml` | Weekly dependency updates |
| `.githooks/pre-commit` | Runs `npx harnessimo check` before each commit |
| `.claude/agents/`, `.claude/settings.json` | AI agent roles and hooks |
| `.harness/` | Rules, state and review records of the AI-assisted process |
| `specs/` | The five work lanes: spec, tasks with proofs |

The last four are explained in [development-process.md](development-process.md); none of them
is needed to run or understand the service.
