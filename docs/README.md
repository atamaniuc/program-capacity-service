# Documentation

## Understand the repository in one hour

Read in this order. Each step says what you should know after it.

| # | Time | Read | You will know |
| --- | --- | --- | --- |
| 1 | 5 min | [Backend-Developer-Test-Assignment.md](Backend-Developer-Test-Assignment.md) and the [project README](../README.md) | What was asked, what was built, how to start it |
| 2 | 10 min | [how-it-works.md](how-it-works.md) | The business: programs, reservations, releases, FX, reconciliation, the rules that must hold |
| 3 | 15 min | [architecture.md](architecture.md) | C4 diagrams, the four main flows, the data model, where each piece of code lives |
| 4 | 10 min | `make up && make seed`, then [api.md](api.md) | The API by hand: reserve, retry, release, errors |
| 5 | 10 min | [assumptions-and-trade-offs.md](assumptions-and-trade-offs.md) and [infrastructure-choices.md](infrastructure-choices.md) | Why it is built this way, and what was left out on purpose |
| 6 | 10 min | Code: `src/capacity/domain/` → `application/use-cases/reserve-capacity/` → `adapters/in/http/capacity.controller.ts` → `adapters/out/postgres/unit-of-work.ts`; then [testing.md](testing.md) | One request from the controller down to the SQL, and how it is tested |

Optional, when you need them: [repository-map.md](repository-map.md) (what every file is for), [runbook.md](runbook.md) (operating the service, alerts),
[PRD.md](PRD.md) (the full requirements, about 600 lines), the decision records below.

## All documents

| Document | Contents |
| --- | --- |
| [how-it-works.md](how-it-works.md) | The domain in plain words, with a worked example |
| [architecture.md](architecture.md) | C4 context, containers and components; sequence diagrams; data model |
| [repository-map.md](repository-map.md) | Every folder and file: purpose and layer |
| [api.md](api.md) | REST API tour: Swagger UI and curl, error catalogue |
| [testing.md](testing.md) | Test levels, how to run them, requirement-to-test mapping |
| [assumptions-and-trade-offs.md](assumptions-and-trade-offs.md) | Every assumption and trade-off, with links to ADRs; known limits |
| [infrastructure-choices.md](infrastructure-choices.md) | PgBouncer, Debezium/CDC, Floci/LocalStack, gRPC, Redis: why not now, when |
| [runbook.md](runbook.md) | Alerts, dashboards, what to do when something breaks |
| [glossary.md](glossary.md) | The words used in code, API and docs |
| [PRD.md](PRD.md) | Requirements: FR, NFR, acceptance criteria, invariants, stack |
| [development-process.md](development-process.md) | How the repository was built with AI agents; what `.harness/` and `specs/` are |
| [Backend-Developer-Test-Assignment.md](Backend-Developer-Test-Assignment.md) | The original assignment |

## Decision records

Each ADR is one page: context, decision, consequences, rejected alternatives.

| ADR | Decision |
| --- | --- |
| [001](adr/001-modular-monolith-roles.md) | One service (modular monolith) with `api` and `worker` roles |
| [002](adr/002-postgres-source-of-truth.md) | PostgreSQL is the single source of truth; no Redis |
| [003](adr/003-concurrency-lock-order.md) | Concurrency: program row lock and a fixed lock order |
| [004](adr/004-money-minor-units.md) | Money as `bigint` minor units with ISO 4217 scales |
| [005](adr/005-fx-rates.md) | FX: treasury rates, fixed per reservation, round up, maximum age |
| [006](adr/006-idempotency.md) | Idempotency: key stored in the same transaction, business rejections stored too |
| [007](adr/007-kafka-consumer-semantics.md) | Kafka consumer: commit after the database, inbox, DLQ, replay |
| [008](adr/008-reconciliation.md) | Reconciliation: watermark, tolerance, staged diff, HOLD by default |
| [009](adr/009-outbox-relay-lease.md) | Transactional outbox, one relay under a lease with epoch fencing |
| [010](adr/010-ledger-projection.md) | Append-only ledger plus projection instead of event sourcing |
| [011](adr/011-auth.md) | Authentication and authorisation: JWKS, scopes, tenants, internal ops port |
| [012](adr/012-kysely-sql-migrations.md) | Kysely and plain SQL migrations instead of an ORM |
| [013](adr/013-opentelemetry.md) | OpenTelemetry and Prometheus metrics |
| [014](adr/014-api-conventions.md) | API conventions: `/v1`, problem types, cursors, `ETag` |
| [015](adr/015-contracts.md) | Contracts: OpenAPI from zod, AsyncAPI, JSON Schema, drift check |
| [016](adr/016-testing-strategy.md) | Testing: Testcontainers, property tests, tests named by requirement |
| [017](adr/017-out-of-scope.md) | Out of scope and why |
| [018](adr/018-hexagonal-architecture.md) | Hexagonal architecture with vertical slices |
| [019](adr/019-aggregate-design.md) | Aggregate design: `Program` root |
| [020](adr/020-ubiquitous-language.md) | Naming rules |
| [021](adr/021-evolution-path.md) | When and how to split into more services |
| [022](adr/022-no-grpc-adapter.md) | No gRPC adapter |
