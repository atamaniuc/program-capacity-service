# 017. Out of scope and why

- Status: accepted
- Date: 2026-10-28

## Context

The assignment is a bounded module. Each technology below is reasonable
somewhere; none earns its place against the critical paths (CP-1 to CP-5). Writing the reasons
down avoids relitigating them.

## Decision

| Not built | Why not now | What would change the answer |
| --- | --- | --- |
| GraphQL | No graph-shaped reads; adds auth and N+1 surface | A UI that needs many aggregates in one call |
| API gateway in this repo | The platform owns routing; the service validates the JWT itself | A second public service needing shared policies |
| Event sourcing | The append-only ledger plus a projection gives the audit trail without replay cost (ADR 010) | A requirement to rebuild state from history |
| Saga, Temporal | One transaction holds the invariant; release is the compensating action | A multi-step flow across services |
| CDC (Debezium) | Infrastructure for one table; a polling relay is enough (ADR 009) | Relay throughput becomes the limit |
| Separate CQRS read store, Redis cache | Reads are primary-key lookups; a cache needs invalidation in the same transaction | Measured read load on the primary |
| Kubernetes, Helm | No cluster in scope; probes, SIGTERM handling and env config keep the image ready | A target environment |
| AWS emulation (LocalStack, Floci) | The service calls no AWS API; RDS and MSK speak plain PostgreSQL and Kafka | A direct AWS SDK dependency |
| Pact, schema registry | One provider and no real consumer yet (ADR 015) | The first real split |
| gRPC adapter | P2; one more driving adapter once P0 and P1 are done | Service-to-service callers |

## Consequences

The README lists these as "not built" with the production mapping, so a reviewer sees a choice,
not a gap.

## Alternatives rejected

Building a thin version of each for show: it would cost the time that the invariants, the
concurrency tests and the fault tests need.
