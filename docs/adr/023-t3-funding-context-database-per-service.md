# 023. Trigger T3 fired: funding decisions as a new service, one database per service

- Status: accepted (branch `microservices` only; `main` keeps ADR 001 and ADR 021 as written)
- Date: 2026-10-29
- Amends: ADR 021 (records the T3 firing it asks for)

## Context

`main` is the submitted take-home: one modular monolith, one bounded context, one invariant
held by one transaction (ADR 001, ADR 021). The branch `microservices` is a deliberate,
documented evolution demo for the parts of the job description that `main` declined:
microservices, gRPC, Saga/workflow orchestration and Kubernetes.

ADR 021 says the service stays whole until a trigger fires, and that each firing is written
down as its own ADR. This is that ADR. The trigger is **T3, a new bounded context**: *funding
decisions*. The split is not driven by load (T4), a team boundary (T1) or tenant isolation (T2),
and it does not cut the capacity service.

Funding is a context of its own, not a feature of capacity:

| | Program Capacity (existing) | Funding (new) |
| --- | --- | --- |
| Question it answers | "Is there room under the limit for this invoice?" | "Do we pay this supplier early, and did the money go out?" |
| Aggregate | `Program` (one hot row, one invariant) | `FundingRequest` (one row per invoice, a multi-step lifecycle) |
| External dependency | Treasury (Kafka, inbound facts) | A payment rail (outbound command with an uncertain outcome) |
| Consistency | One PostgreSQL transaction | Cannot be one transaction: the payment rail takes part in no transaction of ours |
| Language | reservation, release, available | funding request, risk check, disbursement, compensation |

## Decision

1. **A new service, `funding-service`,** owns funding requests and the saga that turns one into
   a disbursement (ADR 025). It calls capacity's `Reserve`, `Release` and `GetAvailability`
   over gRPC (ADR 024) as single atomic commands.
2. **The capacity service is not cut.** The reservation transaction stays whole inside it;
   invariants I1–I8, the lock order (ADR 003) and the idempotency rules (ADR 006) are unchanged.
   Capacity learns nothing about funding: no funding columns, no funding tables. The only traces
   of a funding request in capacity are the actor (`sub` of the funding-service token), the
   `Idempotency-Key` and the `releaseRef` of a compensation.
3. **Database per service.** `funding-service` owns the `funding` database and its own login
   role; capacity owns `capacity`. No cross-database reads, joins, foreign keys, views or shared
   tables, and no distributed transaction. Data crosses the boundary only through the gRPC
   contract (and, after the cut, `capacity.events.v1`).
   - Locally (compose and kind) both databases live on one PostgreSQL server. That is a
     deployment economy, not a coupling: separate databases, separate roles, no grants across,
     and a test (FS-14) proves each role is refused by the other database.
   - In production they are separate instances (RDS or Aurora per service).
4. **Nothing else splits.** T1 (worker alone), T2 (cells) and T4 (load) did not fire. The
   capacity REST API and `capacity.events.v1` change only additively (none planned).

### ADR 021 preconditions on this branch

| Precondition (ADR 021) | State |
| --- | --- |
| The trigger is written down as an ADR | This ADR |
| Contracts live in their own package | **Deferred past the MVP cut** (lane 0006 T18, ADR 028). Until then the single source is `contracts/proto`, guarded by `buf lint` and `buf breaking`. Accepted gap, named here so it is not forgotten |
| The inbox and outbox already guard the boundary being cut | The boundary is synchronous. It is guarded by capacity's `Idempotency-Key` and `release_ref` (ADR 006) on one side and the saga's persisted state with deterministic step keys on the other (ADR 025) |
| The acceptance suite runs against both sides of the split | The capacity acceptance cases run over HTTP and gRPC (lane 0006 GR-03); the saga cases run against the real capacity image (FS-03, FS-06, FS-07, FS-11) |
| Pact arrives with the first split | After the MVP cut (ADR 028) |

## Consequences

- Funding deploys, scales and fails on its own. A payment-rail outage stops new disbursements
  but not reservations, releases or treasury ingest.
- A distributed workflow now exists. A funding request completes eventually, not inside one
  request. Capacity can stay reserved while a disbursement outcome is unknown; that is the safe
  direction (PRD §8: over-reserving delays a supplier, under-reserving loses a funder's money).
- Two databases to migrate, back up and monitor; the local stack is heavier.

## Alternatives rejected

- **Funding as a module inside the monolith.** For one team this is still the right answer,
  and it is what `main` would do. The branch exists to show the split done correctly once the
  context is real; a module would make the saga and the gRPC hop theatre.
- **One shared database, a schema per service.** It couples migrations and invites
  cross-schema joins that nobody reviews. It stays the fallback if a platform allows only one
  server per environment, with the same rule: no grants across schemas.
- **Funding as a plain consumer of `capacity.events.v1`** (the default shape T3 describes).
  A funding decision has to hold capacity *before* money moves; an event consumer only learns
  about a reservation after the fact, so it would need a reservation command anyway.
- **Splitting capacity by operation** (reserve, release, reconcile). ADR 021 forbids it while
  one invariant spans those operations.
