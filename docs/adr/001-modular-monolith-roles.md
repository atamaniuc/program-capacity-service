# 001. Modular monolith with `api` and `worker` roles

- Status: accepted
- Date: 2026-10-28

## Context

The assignment asks for a module of a microservices platform. Inside it there is one bounded
context, one aggregate (`Program`) and one invariant, `reserved <= limit` at commit time, which a
single transaction protects. HTTP traffic and background work (Kafka consumers, outbox relay,
scheduled jobs) fail and scale differently.

## Decision

One NestJS codebase and one image with two runtime roles chosen by `APP_ROLE=api|worker|all`.
`api` serves REST and never calls Kafka; it writes outbox rows in the transaction of the change.
`worker` runs the treasury consumers, the outbox relay and the scheduled jobs. Compose runs them
as separate containers; `all` runs both in one process for tests and small setups. Both roles
share the domain core, the ports and the PostgreSQL adapters, and expose the ops port.

## Consequences

- A Kafka outage cannot stop the REST API (NFR-06); a slow consumer cannot starve request
  threads; each role scales on its own signal.
- The split into deployables already exists, which is the seam of trigger T1 in ADR 021.
- Both roles share one database schema. That is a documented transitional state if the `worker`
  is ever deployed by another team.

## Alternatives rejected

Separate services per operation (would break the one-transaction invariant and force sagas);
Nest microservice transport for Kafka (hides offset control); a single role with everything
in-process (a Kafka stall would share a process with request handling).
