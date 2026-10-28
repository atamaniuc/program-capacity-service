# 021. Evolution path: split triggers T1 to T4 and the order of the split

- Status: accepted
- Date: 2026-10-28

## Context

In a microservices platform this module is one service with versioned contracts and an
asynchronous boundary through Kafka. Inside it there is one aggregate and one invariant held by
one transaction. Splitting reserve, release and reconcile into services would break that
transaction and force sagas to protect a risk that today costs one row lock.

## Decision

Stay one service until a trigger fires, and write each firing down as its own ADR.

| Trigger | What happens | Split |
| --- | --- | --- |
| T1. Team boundary | A separate team owns the treasury integration and needs its own release cycle | Deploy `worker` (ingest, outbox relay, jobs) alone; it is already a separate process. The shared database is a documented transitional state |
| T2. Tenant isolation | A bank requires its own database or instance, for example for data residency | Cells: the same image, a database per bank, routing by tenant. This partitions the deployment; it is not a new service |
| T3. New bounded context | Funding decisions, reporting or FX become domains of their own | A new service that consumes `capacity.events.v1`; the reservation transaction stays whole |
| T4. Load | Contention on a hot program row | No split: capacity buckets, a read replica, table partitioning |

Order when a trigger fires:

1. Already in place: the `api` and `worker` roles (ADR 001), ports, versioned contracts, inbox and
   outbox (ADR 009). These are the seams.
2. Move `contracts/` into its own package; every split depends on it.
3. First real split: `worker`, with an ADR on the shared database as a transitional state.
4. Per-tenant cells as the main scaling answer for a white-label platform.
5. New capabilities arrive as new event consumers, never by cutting the reservation transaction.

Preconditions for any split: the trigger is written down as an ADR; contracts live in their own
package; the inbox and outbox already guard the boundary being cut; the acceptance suite runs
against both sides of the split. Consumer-driven contracts (Pact) and a schema registry arrive
with the first split, when a second deployable consumes `capacity.events.v1`.

## Consequences

Today's structure is the cheapest one that keeps every later split possible. Never split by write
operation while one invariant spans those operations, and never add Redis or a read store without
metrics that ask for it.

## Alternatives rejected

Starting as microservices (distributed transactions for a one-row lock); a Nest or Nx monorepo
(one deployable and one package do not need it).
