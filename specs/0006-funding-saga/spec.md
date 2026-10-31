# 0006 — Funding saga (branch `microservices`, M5 evolution demo)

**Status:** proposed · **Owner:** implementer (sonnet), one task at a time; architect reviews
every diff that touches the saga, idempotency, the gRPC boundary or money (fresh context)

**Branch scope.** This lane exists only on branch `microservices`. `main` is the submitted
take-home and does not change. The ADRs below supersede `main`'s "no Saga, no Pact, no gRPC
adapter, no Helm, no API gateway" decisions **on this branch only**.

## Why

The job description asks for microservices, internal gRPC, Saga/workflow orchestration and
Kubernetes (`docs/senior-node-js-engineer.md`). `main` declines each of them with a written
revisit trigger (ADR 017, ADR 021, ADR 022). This lane makes those triggers fire honestly and
builds the result the way the ADRs say it should be built:

- **T3, a new bounded context** (ADR 023): funding decisions become `funding-service` with its
  own database. The capacity service is not cut; its reservation transaction stays whole.
- **gRPC** (ADR 024, supersedes ADR 022 here): capacity gains an internal gRPC driving adapter
  over the same use cases, with one boundary for validation, auth and error mapping.
- **Saga** (ADR 025): risk check → reserve (gRPC) → disburse (mock payment rail) → on failure,
  compensate by release. Hand-rolled orchestrator, state in PostgreSQL.
- **Helm and kind** (ADR 026): the whole system deploys to a local kind cluster with a smoke test.
- **API gateway** (ADR 029): in kind, Envoy Gateway routes both public REST APIs, checks the
  JWT at the edge and applies CORS and a local per-tenant rate limit; each service still
  verifies the token itself.
- **Layout and isolation** (ADR 027): npm workspaces, capacity stays at the root; the branch
  runs side by side with `main`'s stack without collisions.
- **Contracts package and Pact** (ADR 028): after the MVP cut.

## User stories

**US-01** — As the platform, I want to submit a funding request for an approved invoice and see
it reach a final state, so that the supplier is paid only when capacity is held.
**US-02** — As a funder, I want capacity never to be released while a payment may have gone
out, so that my exposure never exceeds the credit limit.
**US-03** — As an on-call engineer, I want every stuck funding request to be visible and
alerting, with a runbook, so that nothing waits silently.
**US-04** — As the owner, I want this branch to run next to `main`'s stack on the same machine,
so that I can work on both at once.

## Acceptance criteria

Test names start with the id. Proofs are planned until the task is ticked.

### Side-by-side isolation (T1)

**MS-01** — GIVEN the branch's compose file, Makefile and tools WHEN the isolation test runs
THEN no published host port, script default or doctor port is one of `main`'s (5432, 29092,
8081, 3000, 9464, 9465, 9090, 3001, 16686, 4318), the compose project is
`program-capacity-ms`, every built image is tagged `:ms-local`, Kafka advertises the shifted
host port, and every kind target names only cluster `finverity-ms` with `.kind/kubeconfig`.
proof (planned): `test/architecture/isolation.test.ts#MS-01`

**MS-02** — GIVEN `main`'s stack is up (project `program-capacity`) WHEN `make up` and
`make seed` run on the branch THEN both projects report every service healthy at the same
time, a reservation and a token work on both, and `main`'s containers, volumes and image tag
are unchanged. proof (planned): `make isolation-live`

**MS-03** — GIVEN the branch WHEN `make doctor` runs THEN it checks the shifted ports and
warns (not fails) on missing `kind`, `helm` or `kubectl`.
proof (planned): `test/architecture/isolation.test.ts#MS-03`

### Workspaces (T2)

**WS-01** — GIVEN workspaces `services/funding` and `services/payments-mock` WHEN
`make verify` runs THEN lint, types, layer rules and unit tests run for the root and every
workspace, and a file in one service importing another service's code (or root `src/`
importing `services/`) fails the build.
proof (planned): `test/architecture/workspaces.test.ts#WS-01`

### gRPC adapter (T3–T6)

**GR-01** — GIVEN `contracts/proto` WHEN `make verify` runs THEN `buf lint` passes, committed
stubs match a fresh `buf generate`, no `float`/`double` field exists, and a fixture that
removes a field is reported by `buf breaking`.
proof (planned): `test/architecture/proto.test.ts#GR-01`

**GR-02** — GIVEN the boundary module WHEN a problem type lacks an HTTP or gRPC mapping THEN
typecheck fails; every outcome stored under an `Idempotency-Key` maps to a non-retryable gRPC
code; HTTP behaviour and `contracts/openapi.yaml` are unchanged.
proof (planned): `src/capacity/adapters/in/boundary/problem-map.test.ts#GR-02`

**GR-03** — GIVEN the acceptance cases AC-01, AC-02, AC-03, AC-04, AC-05, AC-06, AC-13, AC-16,
AC-17 and FR-01 WHEN they run through one transport-neutral client THEN each passes over HTTP
and over gRPC with the same outcome (problem type ↔ `ErrorInfo.reason`).
proof (planned): `test/e2e/transports.e2e.test.ts#AC-01` (one marker per AC id at tick time)

**GR-04** — GIVEN the gRPC port WHEN a call has no token, a bad token, a read-only token for
`Reserve`, or targets a method missing from the scope table, or the JWKS cannot be fetched
THEN it answers `UNAUTHENTICATED` before the message is parsed, `PERMISSION_DENIED`,
`PERMISSION_DENIED`, or `UNAVAILABLE` respectively.
proof (planned): `test/e2e/grpc.e2e.test.ts#GR-04`

**GR-05** — GIVEN a `Reserve` whose program row is held by another transaction WHEN the
client deadline expires, the lock is released and the server commits, and the client retries
with the same key THEN the retry gets `CREATED` with the same `reservationId`; one reservation
and one ledger entry exist. A call whose deadline has already passed does no work.
proof (planned): `test/e2e/grpc.e2e.test.ts#GR-05`

**GR-06** — GIVEN a reservation created over REST with key K WHEN the same request is sent
over gRPC with K THEN the stored answer is replayed (`CREATED`, same id); a different body with
K answers `FAILED_PRECONDITION` / `idempotency-key-mismatch`.
proof (planned): `test/e2e/grpc.e2e.test.ts#GR-06`

**GR-07** — GIVEN in-flight gRPC calls WHEN the api role gets SIGTERM THEN new calls are
refused, in-flight calls finish and the process exits within the NFR-07 budget.
proof (planned): `test/fault/grpc-shutdown.fault.test.ts#GR-07`

### Funding service and saga (T7–T13)

Saga ACs that prove an effect in capacity (FS-03, FS-06, FS-07, FS-11) run against the real
capacity image and real PostgreSQL through Testcontainers, with Toxiproxy for network faults.
The others may use an in-memory capacity fake generated from the same proto.

**FS-01** — GIVEN the saga transition table WHEN fast-check drives random outcome sequences
THEN properties S1–S6 of ADR 025 hold.
proof (planned): `services/funding/test/property/saga.property.test.ts#FS-01`

**FS-02** — GIVEN `POST /v1/funding-requests` WHEN it is called with a valid token THEN 202
with `Location` and state `RECEIVED`; the same body with the same `Idempotency-Key` replays;
a different body with the key answers 422 `idempotency-key-mismatch`; a second request for the
same invoice without a key answers 200 with the existing one, with different terms 409;
another tenant's request answers 404; no token 401; read scope 403.
proof: `services/funding/test/e2e/api.e2e.test.ts#FS-02`

**FS-03** — GIVEN a program with available capacity and a rail that pays WHEN a funding request
is submitted THEN it reaches `COMPLETED`; capacity holds exactly one reservation for the
invoice with actor `funding-service.<tenant>` (the per-tenant client, ADR 024); the rail holds
exactly one payment; one outbox row per event-carrying transition (`FundingRequestReceived`,
`FundingRequestCompleted`). proof: `services/funding/test/system/saga.system.test.ts#FS-03`

**FS-04** — GIVEN an invoice above the risk limit WHEN it is submitted THEN `REJECTED`
(`risk-declined`) and capacity receives no call.
proof: `services/funding/test/integration/saga.int.test.ts#FS-04`

**FS-05** — GIVEN capacity answers `insufficient-capacity`, or `EXISTING` for an invoice
reserved by someone else WHEN the reserve step runs THEN `REJECTED` with the reason; no
disbursement, no release.
proof: `services/funding/test/integration/saga.int.test.ts#FS-05`

**FS-06** — GIVEN a reserved request and a rail that declines WHEN the disburse step runs THEN
the saga releases its reservation (`releaseRef = funding:<id>:compensation`, `CANCELLED`, the
exact remainder), capacity's `reserved` is back to its value before the request, and the state
is `FAILED` with compensation done.
proof: `services/funding/test/system/saga.system.test.ts#FS-06`

**FS-07** — GIVEN capacity commits a reserve but the answer is lost (Toxiproxy timeout after
the request) WHEN the saga retries THEN it sends the same key and gets the same
`reservationId`; capacity has one reservation and one `RESERVE` ledger entry.
proof: `services/funding/test/system/saga.system.test.ts#FS-07`

**FS-08** — GIVEN a step's call succeeded but recording its result fails (injected) WHEN the
driver runs again THEN it repeats the call with the same key and records one result, for the
reserve and for the disburse step.
proof: `services/funding/test/integration/saga.int.test.ts#FS-08`

**FS-09** — GIVEN the reserve outcome stays unknown past `FUNDING_RESERVE_DEADLINE` WHEN the
deadline passes THEN the saga repeats `Reserve` under the same key, releases what it gets, and
ends `FAILED`; capacity's `reserved` ends where it started.
proof: `services/funding/test/integration/saga.int.test.ts#FS-09`, `services/funding/test/system/saga.system.test.ts#FS-09`

**FS-10** — GIVEN the rail times out on every attempt WHEN `FUNDING_DISBURSE_DEADLINE` passes
THEN `NEEDS_ATTENTION`, the reservation is still held, no release was sent, and the
`FundingNeedsAttention` condition is visible in metrics (until the metrics land with T14 the proof is the alert hook, the `NEEDS_ATTENTION` row and its outbox event).
proof: `services/funding/test/integration/saga.int.test.ts#FS-10`

**FS-11** — GIVEN a compensation while capacity is unreachable WHEN capacity comes back THEN
the release happens exactly once and the state is `FAILED`; a compensation of a reservation
already fully released by someone else also ends `FAILED` (compensated) without a second
release.
proof: `services/funding/test/system/saga.system.test.ts#FS-11`

**FS-12** — GIVEN two drivers and a lease that expires mid-call WHEN both run the same step
THEN both calls carry one key and one result is recorded (version check); the receiver's
deduplication of concurrent same-key calls is capacity's AC-02, and the lost-answer replay on the real
image is FS-07.
proof: `services/funding/test/integration/driver.int.test.ts#FS-12`

**FS-13** — GIVEN a transition WHEN the outbox insert or the attempt-log insert fails THEN the
whole transition rolls back: state, version, attempt log, outbox and idempotency row unchanged.
proof: `services/funding/test/integration/driver.int.test.ts#FS-13`

**FS-14** — GIVEN the `funding` and `capacity` databases on one server WHEN each service's
role connects to the other's database or reads its tables THEN it is refused.
proof: `services/funding/test/integration/database.int.test.ts#FS-14`

**FS-18** — GIVEN the funding `api` and `worker` WHEN their ops port (9464) is called THEN
`/health/live` is up; `/health/ready` is 200 only when the database answers with the newest
migration recorded (and, for the worker, its driver loop ticked within twice the step lease) and
503 otherwise, and 503 while draining; `/metrics` reports requests per state, the age of the
oldest request per open state, the age of the oldest unresolved reserve, step attempts by step and
class, and requests by final state (the `FundingNeedsAttention`, `FundingCompensationStuck` and
`FundingReserveUnresolved` alert rules read them).
proof: `services/funding/test/integration/ops.int.test.ts#FS-18`, `services/funding/test/unit/ops-server.test.ts#FS-18`

**PM-01** — GIVEN the payments mock WHEN a payment is posted twice with one key THEN one
payment; `GET /v1/payments/{key}` returns it; the documented fault markers (decline, timeout
after commit, 5xx) behave as described. The markers are read from the invoice id (prefix match):
`FAULT-DECLINE…` the rail refuses, nothing moves (422 `DECLINED`, stored under the key);
`FAULT-TIMEOUT…` the payment is committed and the response is never sent (the caller times out,
and a `GET` by key then finds it); `FAULT-5XX-<n>…` the first `<n>` attempts under one key
answer 503 with nothing committed. An unknown key on `GET` answers 404 (nothing was committed:
the saga posts again with the same key).
proof (planned): `services/payments-mock/test/payments.test.ts#PM-01`

### Delivery (T14–T16)

**DM-01** — GIVEN the branch compose stack WHEN `make demo-funding` runs THEN it shows the
completed, risk-declined, insufficient-capacity, payment-declined (compensated) and
rail-unavailable (`FAULT-5XX-999`: needs attention, reservation held) paths, plus a lost payment
answer (`FAULT-TIMEOUT`: found by key, completed), with capacity numbers before and after. A
payment timeout alone does not park a request: the retry's lookup by key finds the committed
payment (ADR 025), so needs-attention is shown with a rail that stays unavailable.
proof: `make demo-funding`

**K8-01** — GIVEN `deploy/helm/{capacity,funding,local-infra}` WHEN `make helm-check` runs THEN
lint and template pass and the rendered manifests validate with kubeconform.
proof (planned): `make helm-check`

**K8-02** — GIVEN Docker WHEN `make kind-up` runs THEN cluster `finverity-ms` exists with its
kubeconfig in `.kind/kubeconfig`, `:ms-local` images are loaded, all three releases are
installed and every Pod is Ready; `main`'s compose stack keeps running.
proof (planned): `make kind-up`

**K8-03** — GIVEN the kind cluster WHEN `make kind-smoke` runs THEN the in-cluster test
completes one funding request and compensates one declined request, checking capacity's
numbers. proof (planned): `make kind-smoke`

**K8-04** — GIVEN the kind cluster WHEN `make kind-down` runs THEN only `finverity-ms` is
deleted. proof (planned): `test/architecture/isolation.test.ts#K8-04`

### API gateway in kind (T16a)

These run in the cluster as `helm test gateway`, through the gateway's `ClusterIP` Service,
with tokens minted at the cluster issuer (ADR 029). A gateway answer is told apart from a
service answer by its body: services answer errors as `application/problem+json` (ADR 014),
Envoy does not.

**GW-01** — GIVEN the gateway WHEN a capacity token calls `GET /v1/programs/{id}` and a funding
token calls `POST /v1/funding-requests` through it THEN capacity answers 200 with the program
and funding answers 202 with `Location: /v1/funding-requests/…`; the same calls work through
`make kind-forward` with `Host: localhost:…`; a path under neither prefix answers 404 from the
gateway. proof (planned): `make kind-smoke`

**GW-02** — GIVEN the gateway WHEN a request on either route has no token, a token with a bad
signature, an expired token, a token whose `iss` is not the cluster issuer THEN the gateway
answers 401 with `WWW-Authenticate: Bearer`; a capacity token on the funding route (wrong `aud`)
is answered 403 by Envoy's JWT filter ("Audiences in Jwt are not allowed", observed live with
Envoy Gateway v1.9.3). Either way the body is not `application/problem+json`, so the service
never saw the request.
proof (planned): `make kind-smoke`

**GW-03** — GIVEN capacity's and funding's `api` Services WHEN a Pod calls their ClusterIP HTTP
port directly, bypassing the gateway, without a token or with a foreign-issuer token THEN each
service answers 401 `application/problem+json` (ADR 011); the gateway is not the only check.
proof (planned): `make kind-smoke`

**GW-04** — GIVEN the local rate limit of L requests per minute per tenant per route (chart
value; one gateway replica) WHEN one test-only tenant sends L + 1 valid requests within the
minute THEN the first L are not 429 and the last is 429; a second tenant's request in the same
minute is not 429; requests refused with 401 do not use up the bucket; a client-sent
`x-tenant-id` naming the second tenant does not move the first tenant's request into the
second's bucket. proof (planned): `make kind-smoke`

**GW-05** — GIVEN `deploy/helm/gateway` WHEN the chart is rendered THEN it holds no `GRPCRoute`,
`TCPRoute` or `TLSRoute`, the `Gateway` has one HTTP listener, and every `backendRef` names an
HTTP port, never capacity's gRPC port or an ops port; live, a gRPC call to
`/finverity.capacity.v1.CapacityService/GetAvailability` through the gateway is not routed (HTTP
404 or gRPC `UNIMPLEMENTED`) and capacity records no gRPC call.
proof (planned): `test/architecture/gateway.test.ts#GW-05` (static), `make kind-smoke` (live)

### After the MVP cut (T18–T23)

**CT-01** — `packages/contracts` holds the proto, the stubs and the event schemas; both services
import it; drift and breaking checks run from it.
proof (planned): `test/architecture/workspaces.test.ts#CT-01`

**CT-02** — The funding consumer pact covers the six interactions of ADR 028.
proof (planned): `services/funding/test/pact/capacity.consumer.pact.test.ts#CT-02`

**CT-03** — Capacity verifies the committed pact against its real gRPC server and PostgreSQL.
proof (planned): `test/pact/capacity.provider.pact.test.ts#CT-03`

**CT-04** — An event schema change that would break an existing consumer fails `make verify`:
compared with the merge base, removing or renaming a field, adding a required field, or
narrowing a type is refused; adding an optional field passes. This is the build-time substitute
for a schema registry (ADR 028).
proof (planned): `packages/contracts/test/schema-compat.test.ts#CT-04`

**FS-15** — The funding outbox relay publishes `funding.events.v1` in per-request order under a
lease with epoch fencing (ADR 009 pattern).
proof (planned): `services/funding/test/kafka/outbox-relay.kafka.test.ts#FS-15`

**FS-16** — An operator resolves a `NEEDS_ATTENTION` request to `COMPLETED` (payment confirmed)
or `COMPENSATING` (confirmed not made), recorded with actor and reason.
proof (planned): `services/funding/test/integration/resolve.int.test.ts#FS-16`

**FS-17** (P2) — Funding consumes `capacity.events.v1` through an inbox and marks a `COMPLETED`
request repaid on the final `ReservationReleased` with reason `REPAID`; a redelivery has no
second effect. proof (planned): `services/funding/test/kafka/capacity-events.kafka.test.ts#FS-17`

## Invariants

- **Capacity:** I1–I8 unchanged; lock order dedup row → `program` → reservations; no
  `SELECT … FOR UPDATE` on the idempotency path (D3 closed); every existing test stays green
  and every closed-lane proof marker keeps resolving.
- **Funding:** money is `bigint` minor units plus ISO 4217 code, decimal strings at every
  boundary, no `number` arithmetic on money (the ESLint rule of constraint 1 applies to
  `services/funding/src/funding/domain`); a transition, its attempt log, its outbox row and its
  idempotency row commit in one transaction; no transaction spans a network call; lock order
  idempotency row → `funding_request`; no session state (NFR-15); tenant from the token, every
  query filters by tenant, another tenant's request is 404.
- **Saga:** S1–S6 of ADR 025; an unknown disbursement is never compensated; a compensation
  never ends without a definite release outcome; reserve retries end inside capacity's key
  retention.
- **Boundaries:** database per service; no service imports another's code; REST and
  `capacity.events.v1` unchanged; the gRPC port is internal only (ClusterIP, no ingress or
  gateway route); compose publishes it on the host for local development on `127.0.0.1` only
  (ADR 024, ADR 027).
- **Isolation:** `main`'s stack, images, volumes and kube contexts are never touched;
  Testcontainers keep random ports.
- **Words:** `docs/glossary.md` only; no *allocation*, *booking* or *balance*.

## Out of scope

Temporal or any workflow engine; Redis (as a cache or as a rate-limit store, ADR 029); event
sourcing; GraphQL; a CQRS read store; a gateway in compose, a global rate limit, TLS at the edge
(ADR 029); a service mesh, mTLS and a real cluster; a real payment rail; pricing or discount
maths (the disbursed amount is the invoice amount); FX in funding (capacity converts);
splitting the capacity service (T1, T2, T4 did not fire); moving capacity to
`services/capacity` (ADR 027); a Pact Broker; a schema registry.
`CONSTRAINTS.md` constraint 9 is amended on this branch by the owner (DECISIONS, 2026-10-29):
the "no Saga, no Pact, no gRPC adapter" items are lifted here and the agent amends a rule that
blocks the evolution, citing the ADR; `main` keeps the original rule.

## Tasks

See `tasks.md`.
