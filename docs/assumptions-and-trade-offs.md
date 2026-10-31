# Assumptions and trade-offs

The assignment says: *"If you make assumptions or trade-offs, document them briefly."* This
is that page. Each line links to the decision record (ADR) with the full reasoning.

Sections 1 to 3 below describe the capacity service as submitted on `main`. Branch
`microservices` adds [a section of its own](#branch-microservices-funding-and-the-saga) at the
end: the funding service and its saga, with the assumptions behind them, the trade-offs, what
was deliberately left out, and the known limits.

## Assumptions about the business

The assignment leaves these open. Where a bank might answer differently, the behaviour is a
configuration switch, not a code change.

| # | Assumption | Why | If wrong |
| --- | --- | --- | --- |
| A1 | **Treasury owns credit limits**; this service owns its reservations until treasury has acknowledged them | Banks keep limits in their own core systems | Limits could also be set over REST; the use case already exists for Kafka |
| A2 | We define the treasury message contract (envelope, per-program increasing `seq`, snapshots with a watermark) | The assignment gives no format | Only the Kafka adapter (`treasury-handler.ts`) and the zod schemas change; the contract is `contracts/asyncapi.yaml` with JSON Schemas in `contracts/json-schema/` |
| A3 | Treasury learns about our reservations from `capacity.events.v1` | It needs them to report a watermark | — |
| A4 | FX rates come from treasury, are valid 24 h (`FX_MAX_AGE`), and are fixed at reservation time | Exposure must not move with the market after approval | `FX_MAX_AGE` is configurable |
| A5 | A reservation lives from approval until repayment or cancellation; no separate "utilised" state | Simplest model that answers "how much is available" | A disbursed state would be a new status, not a new table |
| A6 | Partial repayment releases a proportional share in program currency, rounded down; the last one releases the exact rest | Nothing is lost or created over many partial repayments | — |
| A7 | One reservation per invoice per program | An invoice is financed once | — |
| A8 | "All endpoints must be authenticated" means the **business API**. Health and metrics sit on a separate internal port | Kubernetes probes and Prometheus cannot send a JWT | A flag can put `/metrics` behind a token |
| A9 | A tenant is a bank; one token carries one tenant | White-label platform, one bank per client | — |
| A10 | Cutting a limit below the reserved amount never cancels reservations; the program is "over limit" and refuses new ones | Cancelling approved financing is a business decision, not a system one | — |
| A11 | Reconciliation tolerates 1 minor unit of rounding difference per reservation (`RECON_TOLERANCE_MINOR`) | Two systems rounding the same FX conversion can differ by one cent | Configurable |
| A12 | A program id is unique only within a tenant | Ids come from each bank's treasury | — |
| A13 | When treasury does not know a reservation it should know, **hold and alert**, do not release (`RECON_MODE=HOLD`) | Releasing capacity on a guess can over-lend; holding cannot | `RECON_MODE=RELEASE` |

Questions we would ask the product owner are listed in [PRD §14](PRD.md#14-assumptions-open-questions-adr-backlog).

## Trade-offs

| Decision | What we gain | What we give up | Record |
| --- | --- | --- | --- |
| **One service (modular monolith)** with `api` and `worker` roles from one image | One transaction protects the limit; no distributed transactions | Independent deploys of ingest vs API (the roles already scale separately) | [ADR 001](adr/001-modular-monolith-roles.md), [ADR 021](adr/021-evolution-path.md) |
| **PostgreSQL row lock** per program (`SELECT … FOR UPDATE`) | Correct under any concurrency, simple to reason about | Writes to one hot program are serialised; measured in the load test | [ADR 003](adr/003-concurrency-lock-order.md) |
| **PostgreSQL as the only store**, no Redis | One source of truth, no cache invalidation | Every read hits the primary (a replica is the next step) | [ADR 002](adr/002-postgres-source-of-truth.md) |
| **Money as `bigint` minor units** | Exact arithmetic, no float errors | A few helper functions instead of plain numbers | [ADR 004](adr/004-money-minor-units.md) |
| **Round up on reserve, down on partial release** | The program never holds less than the real exposure | Up to one minor unit held "too much" per reservation, until the final release | [ADR 005](adr/005-fx-rates.md) |
| **`Idempotency-Key` stored in the same transaction**, business rejections stored too | A retry always gets the first answer, even a 422 | A table that needs cleaning (24 h retention job) | [ADR 006](adr/006-idempotency.md) |
| **Kafka at-least-once + inbox table** | Exactly-once effects without Kafka transactions | One extra insert per message | [ADR 007](adr/007-kafka-consumer-semantics.md) |
| **Transactional outbox with a polling relay**, not Debezium | No extra infrastructure | Sub-second latency instead of near real time; one relay is a throughput ceiling | [ADR 009](adr/009-outbox-relay-lease.md), [infrastructure-choices.md](infrastructure-choices.md#debezium--cdc-change-data-capture) |
| **Append-only ledger + projection**, not event sourcing | Full audit trail, simple reads | Cannot rebuild state by replaying events (the invariant job checks the projection instead) | [ADR 010](adr/010-ledger-projection.md) |
| **JWT checked by the service itself** (JWKS), no gateway in this repo (on the branch: an Envoy gateway in kind only, and the services still check the token) | Works anywhere, testable locally | The platform's gateway would duplicate the check | [ADR 011](adr/011-auth.md), [ADR 029](adr/029-api-gateway.md) |
| **Kysely + plain SQL migrations**, not an ORM | The locking and set-based SQL are visible and reviewable | More SQL to write by hand | [ADR 012](adr/012-kysely-sql-migrations.md) |
| **OpenAPI and AsyncAPI generated from zod** | One schema for validation, outbox payload types and docs; CI fails if they differ; tests check real responses and real events against them | No decorator-based Swagger; no schema registry until a second deployable consumes the events | [ADR 015](adr/015-contracts.md) |
| **Real PostgreSQL and Kafka in tests** (Testcontainers) | Tests prove the real locking and delivery behaviour | Integration suite takes about 4 minutes and needs Docker | [ADR 016](adr/016-testing-strategy.md) |
| **Saga reserve retries bounded by capacity's 24 h key retention** (branch `microservices`): normal path 2 min, resolution up to 12 h | Exactly-once reserve across the gRPC hop without a distributed transaction | A reserve not resolved within 12 h stops retrying and goes to `NEEDS_ATTENTION` for an operator | [ADR 025](adr/025-funding-saga-orchestration.md#exactly-once-effect-across-the-grpc-hop), [runbook](runbook.md#funding-the-reserve-retry-window-branch-microservices) |
| **No gRPC** (`main`; the branch adds an internal one, see below) | One boundary to validate, secure and version | Callers that want gRPC use REST | [ADR 022](adr/022-no-grpc-adapter.md), [ADR 024](adr/024-grpc-driving-adapter.md) |
| **No PgBouncer, Debezium or AWS emulator** | Less to run and explain | Added when their triggers fire | [infrastructure-choices.md](infrastructure-choices.md) |

## Known limits

Honest list of what this version does not do, or does only partly.

- **Hot program throughput.** All writes to one program queue on its row lock. At 20 writes/s
  on one program the load test shows reserve p95 of 28–58 ms, about twice the spread case; the
  ceiling of one program was not measured. The fix (capacity buckets: split one limit into N
  rows) is designed in PRD §8 but not built.
- **One outbox relay.** Publishing is single-threaded across all programs. Fine at this
  volume; the scale path is a lease per partition of programs.
- **Kubernetes manifests are a starting point**, validated with `kubeconform` but never
  applied to a real cluster. On `main`: no Helm chart, no ingress, no network policies. The
  branch adds Helm charts and a local kind cluster, still not a real cluster.
- **The ZAP scan is a baseline scan.** It checks headers and the unauthenticated surface, not
  the authenticated API.
- **Reconciliation input is trusted for size up to `RECON_MAX_RESERVATIONS`** (50,000); larger
  snapshots go to the dead-letter topic.

## Branch `microservices`: funding and the saga

Everything above still holds for the capacity service. The branch adds `funding-service`, which
pays a supplier early after reserving capacity, and the pieces between the two services. The
reasoning is in ADRs [023](adr/023-t3-funding-context-database-per-service.md) to
[029](adr/029-api-gateway.md); this section is the short version.

### Assumptions

| # | Assumption | Why | If wrong |
| --- | --- | --- | --- |
| F1 | Funding decisions are a bounded context of their own, and capacity is not split | The question, the lifecycle and the consistency needs differ; one invariant still spans reserve, release and reconcile | Triggers T1, T2 and T4 of [ADR 021](adr/021-evolution-path.md) did not fire and nothing else is cut |
| F2 | The payment rail accepts an idempotency key and can be asked for a payment by that key | The saga's safety on an unknown payment outcome depends on both | A rail with neither cannot be driven safely by this saga; it would need a reconciliation step against the rail's own records first. The mock has both |
| F3 | The amount paid equals the invoice amount | No pricing or discount in scope | A pricing step is a new saga step with its own state |
| F4 | One funding request per tenant, program and invoice | Same rule as one reservation per invoice (A7) | See "Known limits": a refused request cannot be restarted for the same invoice |
| F5 | The tenant is the token's tenant, and funding calls capacity as `funding-service.<tenant>` | No token that can act for every tenant, so a bug in funding cannot reach another bank's program | One shared client would be simpler and would break tenant isolation on a bug |
| F6 | The risk check is a per-currency maximum on one invoice (default 1,000,000.00 for USD, EUR and GBP; other currencies are declined) | A real risk model is out of scope; the step exists to show a rejection that needs no compensation | `FUNDING_RISK_LIMITS` changes the limits; a real policy replaces `assessRisk` behind the same step |

### Trade-offs

| Decision | What we gain | What we give up | Record |
| --- | --- | --- | --- |
| **Orchestrated saga**, one component owns the flow, its timeouts and the compensation | One place to read and test the flow; a reservation is confirmed before money moves | Funding knows the order of the steps and depends on capacity being reachable | [ADR 025](adr/025-funding-saga-orchestration.md) |
| **Hand-rolled** (a transition table, a driver loop, state in PostgreSQL), not Temporal | Shows the mechanism (keys, outcome classes, lease, version check); no second stateful cluster for three steps | We maintain the loop, the lease and the retry logic ourselves. With many workflows, long human waits or workflow versioning, an engine pays off | [ADR 025](adr/025-funding-saga-orchestration.md) |
| **At-least-once calls with idempotent receivers**, not two-phase commit | No lock held across the network; works with a rail that joins no transaction | The effect is exactly once only while the receiver still remembers the key (see the 24 h window below) | [ADR 025](adr/025-funding-saga-orchestration.md#exactly-once-effect-across-the-grpc-hop) |
| **An unknown payment is never compensated**; the request retries, asks the rail by key, then parks as `NEEDS_ATTENTION` with the reservation kept and an alert | Capacity is never released while money may have left: over-reserving delays a supplier, under-reserving can lose a funder's money (PRD §8) | Capacity stays held, and a person has to resolve the request. Until the operator command exists (task T22) that is manual SQL from the runbook | [ADR 025](adr/025-funding-saga-orchestration.md#compensation-semantics), [runbook](runbook.md#funding-a-request-needs-attention-fundingneedsattention) |
| **An unknown reserve is resolved, then compensated** (repeat `Reserve` under the same key, release what it created) | The saga learns whether anything was held before it decides | One extra `RESERVE` and `RELEASE` pair in the ledger in the unlucky case | [ADR 025](adr/025-funding-saga-orchestration.md) |
| **Compensation is a forward action** (a new `RELEASE` entry), retried without a deadline | Both entries stay in the audit trail; `release_ref` never expires, so a late retry cannot release twice | Capacity stays over-reserved while capacity itself is unreachable (the safe direction; alert after 15 minutes) | [ADR 025](adr/025-funding-saga-orchestration.md#when-the-compensation-itself-fails) |
| **Reserve retries end inside capacity's 24 h key memory**: 2 minutes on the normal path, 12 hours to resolve, validated at start-up | The exactly-once argument stays true; the service refuses to start with settings that break it | A reserve not resolved within the limit goes to `NEEDS_ATTENTION` | [runbook](runbook.md#funding-the-reserve-retry-window-branch-microservices) |
| **A stale FX rate rejects the funding request**, it is not retried | The deterministic reserve key would only replay capacity's stored `422` for 24 h | The platform has to ask again with a new request (see the limit below) | [ADR 025](adr/025-funding-saga-orchestration.md) |
| **A request finishes eventually**; the client polls `GET` | The `POST` is fast and never waits for another system | No push of the final state until the funding events reach Kafka (planned) | [ADR 025](adr/025-funding-saga-orchestration.md) |
| **Database per service**, both on one PostgreSQL server locally | No cross-service joins or shared tables; a test proves each role is refused by the other's database | Two sets of migrations to run and monitor; in production they would be separate instances | [ADR 023](adr/023-t3-funding-context-database-per-service.md) |
| **Internal gRPC between the services**, plaintext HTTP/2 with a JWT on every call; REST stays the public API | A typed contract checked by `buf breaking`, deadlines and status codes to branch on | A second contract and a second port to protect. TLS or mesh mTLS is not built | [ADR 024](adr/024-grpc-driving-adapter.md) |
| **Gateway only in kind**, a per-tenant limit local to each Envoy replica, no Redis | Common policy for two public APIs; the services still verify the token | With N replicas the effective limit is N times higher. It protects against one tenant crowding out others; it is not a quota | [ADR 029](adr/029-api-gateway.md) |
| **Contract compatibility checked at build time**, no schema registry | One repository and one CI run make a runtime registry unnecessary; breaking changes fail `make verify` | A topic read from another repository, or an Avro payload, would need a registry | [ADR 028](adr/028-contracts-package-and-consumer-contracts.md) |
| **Helm and a local kind cluster**, no real cluster | The system is shown to deploy: probes, migration hooks, config, secrets, a gateway | No NetworkPolicy, autoscaling or service mesh is exercised; nothing runs on a real cluster | [ADR 026](adr/026-helm-and-kind.md) |

### Deliberately left out

Not built, each by a written decision: Temporal or any workflow engine, Redis (cache or rate
limit), event sourcing, GraphQL, a CQRS read store, a gateway in Compose, TLS at the edge, a
service mesh and mTLS, a real cluster, a real payment rail, pricing and discount maths, FX in
funding (capacity converts), a Pact Broker. The records are [ADR 017](adr/017-out-of-scope.md)
and ADRs 023 to 029.

Planned and not built yet ([tasks](../specs/0006-funding-saga/tasks.md)): Pact consumer and
provider tests (T19, T20), the relay that publishes the funding outbox to `funding.events.v1`
(T21), the operator command that resolves a `NEEDS_ATTENTION` request (T22), a kind job in CI
(T23), funding consuming `capacity.events.v1` (T24).

### Known limits

- **A refused or failed request cannot be started again for the same invoice.** There is one
  funding request per tenant, program and invoice. After `REJECTED` (for example
  `insufficient-capacity` or `fx-rate-unavailable`) or `FAILED`, a `POST` for that invoice
  returns the existing request. [ADR 025](adr/025-funding-saga-orchestration.md) says the
  platform "submits a new funding request" after a stale-rate rejection; with the natural key
  that needs a new invoice id or a resubmission rule, and neither exists yet.
- **`NEEDS_ATTENTION` is closed by hand** until task T22: the runbook gives the SQL and the
  manual release. Alerts fire, and the request waits.
- **Funding keeps its idempotency and outbox rows.** There is no retention job in funding
  (capacity has one), and no relay to drain the outbox.
- **No distributed tracing in funding.** It has JSON logs, Prometheus metrics and three alerts;
  a trace does not cross the gRPC hop, although ADR 025 describes it. No Grafana panel either.
- **Funding and the payments mock use plain `node:http` and zod, not NestJS.** No decision record
  explains the choice; capacity stays on NestJS.
- **The payments mock is in memory and has no authentication**; restarting it forgets every
  payment.
- **Several funding workers are tested through the claim and the version check** (FS-12), not run
  together under load.
