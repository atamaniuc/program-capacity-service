# Assumptions and trade-offs

The assignment says: *"If you make assumptions or trade-offs, document them briefly."* This
is that page. Each line links to the decision record (ADR) with the full reasoning.

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
| **JWT checked by the service itself** (JWKS), no gateway in this repo | Works anywhere, testable locally | The platform's gateway would duplicate the check | [ADR 011](adr/011-auth.md) |
| **Kysely + plain SQL migrations**, not an ORM | The locking and set-based SQL are visible and reviewable | More SQL to write by hand | [ADR 012](adr/012-kysely-sql-migrations.md) |
| **OpenAPI and AsyncAPI generated from zod** | One schema for validation, outbox payload types and docs; CI fails if they differ; tests check real responses and real events against them | No decorator-based Swagger; no schema registry until a second deployable consumes the events | [ADR 015](adr/015-contracts.md) |
| **Real PostgreSQL and Kafka in tests** (Testcontainers) | Tests prove the real locking and delivery behaviour | Integration suite takes about 4 minutes and needs Docker | [ADR 016](adr/016-testing-strategy.md) |
| **No gRPC** | One boundary to validate, secure and version | Callers that want gRPC use REST | [ADR 022](adr/022-no-grpc-adapter.md) |
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
  applied to a real cluster. No Helm chart, no ingress, no network policies.
- **The ZAP scan is a baseline scan.** It checks headers and the unauthenticated surface, not
  the authenticated API.
- **Reconciliation input is trusted for size up to `RECON_MAX_RESERVATIONS`** (50,000); larger
  snapshots go to the dead-letter topic.
