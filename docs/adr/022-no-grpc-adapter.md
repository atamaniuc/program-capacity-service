# 022. No gRPC adapter (FR-16 declined)

- Status: accepted on `main`; superseded on branch `microservices` by [ADR 024](024-grpc-driving-adapter.md) (the gRPC half of the third revisit trigger fired)
- Date: 2026-10-28
- Supersedes: requirement FR-16 "gRPC adapter (P2)" in the PRD, priority P2 meaning "could have"

## Context

The PRD listed a gRPC adapter as a P2 "Could": one more driving adapter over the same use
cases, meant to prepare a service-to-service contract before the first split. The job
description mentions gRPC. Lane 0005 had to decide whether to build it.

The assignment asks for a module that accepts reservations, processes releases and "exposes
current availability to clients". It does not name a transport.

## Decision

Do not build a gRPC adapter. Clients use the REST API under `/v1`, described by
`contracts/openapi.yaml`. Services that only need to react to changes consume
`capacity.events.v1` on Kafka.

## Why

1. **Nobody would call it.** No client of this service needs gRPC: browsers and partner banks
   use REST, and platform services can use REST with the same JWT or listen to the events. A
   contract without a consumer gets no feedback, so it is designed by guesswork and versioned
   for nobody.
2. **Every rule would live in two places.** A second transport needs its own copy of input
   validation (the zod schemas are tied to HTTP), JWT extraction from metadata, the mapping
   from problem types to status codes, the `Idempotency-Key` transport, deadlines, TLS, a
   published port and a second contract (`.proto`) to version next to OpenAPI. In a service
   that guards money, two copies of the boundary drift apart. Every later change to
   validation, auth or error codes would have to be made twice and tested twice.
3. **It would not make anything faster.** A reserve is one short PostgreSQL transaction. Under
   load the limit is the `program` row lock on a hot program (NFR-04), not JSON or HTTP/1.1
   overhead. A binary protocol does not change how long a transaction waits for a row lock.
4. **The architecture is already shown without it.** Ports and adapters are shown by two
   real driving adapters: the HTTP release endpoint and the Kafka `RepaymentReceived` handler
   both call the same `releaseCapacity` function
   (`src/capacity/application/shared/release-capacity.ts`). Scheduled jobs are a third. A
   gRPC adapter would add no new evidence.
5. **A monolith has no internal network hop.** Modules call each other in process. gRPC
   between modules of one deployable would add a network call and a failure mode for nothing
   (PRD §7).
6. **More attack surface.** Another listening port, another authentication path to audit, and
   a protocol that the OWASP ZAP baseline scan does not cover.

## When to revisit

Add the adapter when a real caller needs something REST does not give:

- a platform service that makes many calls per second and wants generated, typed clients in
  several languages;
- a server stream of capacity changes to a funding engine that cannot consume Kafka;
- a platform standard of gRPC with mesh mTLS between services.

The cost then is small and well bounded. The use cases do not depend on any transport, so the
adapter is a `.proto` file, request mapping, JWT extraction from metadata, an error-code
table, and the existing acceptance tests run a second time against the new transport.

## Alternatives rejected

- **Build it to match the job description.** The job description asks for experience with
  gRPC, not for a feature with no consumer. Explaining the decision says more than code that
  nothing calls.
- **grpc-gateway or Connect, to serve both from one definition.** This moves the source of
  truth from zod to protobuf for the whole API, a larger change for the same missing consumer.
