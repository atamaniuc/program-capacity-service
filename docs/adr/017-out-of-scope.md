# 017. Out of scope and why

- Status: accepted
- Date: 2026-10-28

## Context

The assignment is a bounded module. Each technology below is reasonable
somewhere; none earns its place against the critical paths (CP-1 to CP-5). Writing the reasons
down avoids relitigating them.

## Decision

On branch `microservices` (an evolution demo; `main` is the submission) four rows below have
fired and point to the ADR that records it. On `main` every row stands as written.

| Not built | Why not now | What would change the answer |
| --- | --- | --- |
| GraphQL | No graph-shaped reads; adds auth and N+1 surface | A UI that needs many aggregates in one call |
| API gateway in this repo | The platform owns routing; the service validates the JWT itself | A second public service needing shared policies |
| Event sourcing | The append-only ledger plus a projection gives the audit trail without replay cost (ADR 010) | A requirement to rebuild state from history |
| Saga, Temporal | One transaction holds the invariant; release is the compensating action | A multi-step flow across services. **Fired on branch `microservices`:** hand-rolled saga, Temporal still not built ([ADR 025](025-funding-saga-orchestration.md)) |
| CDC (Debezium) | Infrastructure for one table; a polling relay is enough (ADR 009, [infrastructure-choices](../infrastructure-choices.md#debezium--cdc-change-data-capture)) | Relay throughput becomes the limit |
| Separate CQRS read store, Redis cache | Reads are primary-key lookups; a cache needs invalidation in the same transaction | Measured read load on the primary |
| Helm, a real cluster, service mesh | No cluster in scope. Plain manifests in `deploy/k8s/` (validated with kubeconform, never applied), probes, SIGTERM handling and env config keep the image ready | A target environment. **Fired on branch `microservices` for Helm and a local kind cluster** ([ADR 026](026-helm-and-kind.md)); a real cluster and a service mesh stay out |
| AWS emulation (LocalStack, Floci) | The service calls no AWS API; RDS and MSK speak plain PostgreSQL and Kafka ([infrastructure-choices](../infrastructure-choices.md#floci--localstack-local-aws-emulators)) | A direct AWS SDK dependency |
| Connection pooler (PgBouncer, RDS Proxy) in this repo | 20 connections locally; the code is already transaction-pooling safe ([infrastructure-choices](../infrastructure-choices.md#pgbouncer-connection-pooling)) | `replicas × pool size` near `max_connections`; RDS Proxy in production |
| Pact, schema registry | One provider and no real consumer yet (ADR 015) | The first real split. **Fired on branch `microservices` for Pact** ([ADR 023](023-t3-funding-context-database-per-service.md), [ADR 028](028-contracts-package-and-consumer-contracts.md)); a schema registry stays out |
| gRPC adapter | No client needs it; a second transport duplicates validation, auth and error mapping (ADR 022) | A real caller that REST and Kafka events do not serve. **Fired on branch `microservices`** ([ADR 024](024-grpc-driving-adapter.md)) |

## Consequences

The README lists these as "not built" with the production mapping, so a reviewer sees a choice,
not a gap.

## Alternatives rejected

Building a thin version of each for show: it would cost the time that the invariants, the
concurrency tests and the fault tests need.
