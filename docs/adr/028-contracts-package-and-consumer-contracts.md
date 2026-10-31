# 028. Contracts package and consumer-driven contracts (Pact)

- Status: accepted, lands after the minimum viable cut of the funding-saga work plan (branch `microservices` only)
- Date: 2026-10-29
- Amends: ADR 015 ("no Pact until the first split": this is the first split) and ADR 017 row
  "Pact, schema registry" (Pact fires; a schema registry does not)

## Context

ADR 021 makes two things arrive with the first split: contracts in their own package, and
consumer-driven contracts. ADR 023 records the split and defers both past the MVP cut, so the
saga, the gRPC adapter and the cluster land first. This ADR fixes what they will be, so the
deferral has a defined end.

`buf breaking` (ADR 024) catches wire-incompatible changes to the proto. It cannot catch a
semantic change the consumer relies on: for example `insufficient-capacity` moving from
`FAILED_PRECONDITION` to `ABORTED`, which would turn a rejection into an endless retry in the
saga (ADR 025). That is what a consumer contract is for.

## Decision

### `packages/contracts`

- A private workspace `@finverity/contracts` holding the proto files (moved from
  `contracts/proto`, with `buf.yaml`), the generated TypeScript stubs, and the JSON Schemas of
  `capacity.events.v1` and `funding.events.v1`. Exposed through `package.json` `exports`.
- Capacity and funding import their stubs from it; `proto:check` and `buf breaking` move with it.
- Capacity's OpenAPI stays generated from zod in the capacity service (ADR 015): it is capacity's
  public contract, not code shared between services.

### Pact

- Consumer: `funding-service`. Provider: capacity's `CapacityService` over gRPC.
- Interactions, each tied to a saga rule: `Reserve` created; `Reserve` refused for insufficient
  capacity (`FAILED_PRECONDITION`, `ErrorInfo.reason = insufficient-capacity`); `Reserve`
  replayed under the same key (`CREATED`, same `reservationId`); `Release` of the remainder;
  `Release` of an already released reservation; `GetAvailability`.
- Pact specification V4 with the Pact protobuf plugin for gRPC. Provider states seed capacity's
  database through test helpers (for example "program P of bank-a has 1,000,000.00 USD
  available").
- Pact files are committed under `contracts/pacts/`. No Pact Broker and no `can-i-deploy`:
  both sides live in one repository and are verified in the same CI run. A broker arrives when
  the services move to separate repositories or release independently.
- The provider verification runs in capacity's `make test` against the real gRPC server and a
  real PostgreSQL; a broken pact fails the build.

### No schema registry: what replaces it, and when it arrives

ADR 021 says Pact and a schema registry "arrive with the first split, when a second deployable
consumes `capacity.events.v1`". This branch is the first split, but its second deployable talks
to capacity over gRPC; it consumes `capacity.events.v1` only in a later phase (task T24). So the registry's own
trigger has not fired, and even when it does, the registry would solve a problem this repository
does not have.

A schema registry (Confluent, Apicurio) checks schema compatibility **at run time**, when a
producer registers a new version. It earns its place when many producers and consumers live in
different repositories and release independently, so nobody can see every schema at build
time, and when the payload is a binary format (Avro, Protobuf) whose reader needs the writer's
schema id from the message.

Here both services live in one repository and ship from one CI run, and events are JSON with
versioned topic names. Compatibility is checked **at build time** instead:

| What a registry would do | What does it here |
| --- | --- |
| Single source of event schemas | zod → committed JSON Schemas and `asyncapi.yaml` in `@finverity/contracts`; `test/kafka/contracts.test.ts` fails on drift |
| Refuse an incompatible new version | JSON Schema backward-compatibility check against the merge base in `make verify` (task T18): removing or renaming a field, adding a required one, or narrowing a type fails |
| Refuse an incompatible gRPC change | `buf breaking` (ADR 024) |
| Prove what the consumer relies on | Pact: gRPC now, message pact on `capacity.events.v1` with task T24 |
| Breaking change, when it is wanted | a new topic `capacity.events.v2` with both published during migration, never an in-place edit |

**When to add a registry:** a topic is read by a team or service from another repository; or
the event payload moves to Avro or Protobuf; or producers deploy independently of the
contracts package. Then the JSON Schemas move into the registry with `BACKWARD` compatibility,
and the build-time check stays as the early warning.

### Fallback

If the protobuf plugin cannot run reliably in CI (it is a downloaded native binary; arm64 and
Linux runners both matter), drop the gRPC pact, keep `buf breaking` plus the dual-transport
acceptance suite (acceptance criterion GR-03 in the [funding-saga spec](../../specs/0006-funding-saga/spec.md)), and record the decision here. The message pact on
`capacity.events.v1` (when funding consumes it, task T24) needs no plugin.

## Consequences

- ADR 021's preconditions are fully met once this lands.
- One more test level for a contributor to understand; the pact files are small and
  reviewable.

## Alternatives rejected

- **A schema registry** (Avro or JSON Schema with compatibility rules): run-time infrastructure
  for a cross-repository problem; see "No schema registry" above for what replaces it and the
  triggers that would bring it in.
- **Pact only, without `buf breaking`.** Pact checks only what the consumer exercises; `buf`
  checks the whole wire contract.
