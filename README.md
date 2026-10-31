# Program Capacity Service

A backend service for a supply chain finance platform. A bank opens a program for a buyer with a
credit limit; every supplier invoice the bank pays early reserves part of that limit. The service
holds the available capacity of every program in real time and refuses any reservation that
would exceed it, under any concurrency. The bank's treasury sends limits, repayments and FX rates
over Kafka. It was built as the take-home for a senior Node.js role
([the assignment](docs/Backend-Developer-Test-Assignment.md)) on Node.js 24, NestJS 12,
PostgreSQL 18 and Kafka 4.

This is branch `microservices`. The submission is
[`main`](https://github.com/atamaniuc/program-capacity-service/tree/main); this branch does not
change it. It shows what happens to the same codebase when the product grows.

## Why this branch exists

On `main` the product answers one question: is there room under the limit for this invoice?
The next step for a supply chain finance platform is to act on the answer: decide whether to pay
the supplier early, and pay. That capability is funding, and it is not more of the same:

- **It has its own lifecycle.** A funding request goes through a risk check, a reservation, a
  payment and sometimes a compensation. It ends minutes later, not inside one HTTP request.
- **Money leaves our database.** The payment goes out through a payment rail that takes part in
  none of our transactions and does not always answer.
- **Failures must be undone, and some cannot be decided by code.** A refused payment must give
  the reserved capacity back. A payment with an unknown outcome must keep it held, because
  releasing capacity when the money may have gone out leaves the funder uncovered.
- **It deploys, scales and fails on its own.** A payment-rail outage should stop new payouts,
  not reservations or treasury input.

`main` expected this. [ADR 021](docs/adr/021-evolution-path.md) lists the triggers that justify
a second service, and ADRs 015, 017 and 022 decline each piece of distributed machinery with the
condition that would change the answer. Funding makes those conditions true:

| Condition written on `main` | What makes it true here | Decision on the branch |
| --- | --- | --- |
| T3 in ADR 021: a new bounded context | Funding has its own aggregate, language and lifecycle | [ADR 023](docs/adr/023-t3-funding-context-database-per-service.md): `funding-service` with its own database |
| ADR 017: a multi-step flow across services | Risk check, reserve, pay and compensate span two services and a payment rail | [ADR 025](docs/adr/025-funding-saga-orchestration.md): an orchestrated saga, state in PostgreSQL |
| ADR 022: gRPC as the standard between services | Funding needs a typed, synchronous `Reserve` before it pays | [ADR 024](docs/adr/024-grpc-driving-adapter.md): internal gRPC next to REST |
| ADR 015 and 021: a contracts package and Pact with the first split | Funding is a real consumer of capacity's contract | [ADR 028](docs/adr/028-contracts-package-and-consumer-contracts.md): the package is built, Pact is not yet |
| ADR 017: a second public service needing shared policies | Two public REST APIs | [ADR 029](docs/adr/029-api-gateway.md): Envoy Gateway, in kind only |
| ADR 017: a target environment | Three deployables have to deploy somewhere | [ADR 026](docs/adr/026-helm-and-kind.md): Helm charts and a local kind cluster |

[ADR 027](docs/adr/027-repository-layout-and-side-by-side-isolation.md) sets the repository
layout and the rules that let the branch run beside `main`.

What did not change. The capacity service is not cut: its reservation transaction, invariants
I1–I8, lock order and REST API are as on `main`, and it stores nothing about funding
([ADR 023](docs/adr/023-t3-funding-context-database-per-service.md)). The other triggers of
ADR 021 (a team boundary, tenant isolation, load) did not fire, so nothing else is split. Redis,
event sourcing, GraphQL and Temporal are still out. ADR 023 also says plainly that for one team a
funding module inside the monolith would still be the right answer; the branch shows the split
done correctly once the context is real.

## What the branch delivers

- **One funding request, end to end, with exactly one effect.** It is submitted over REST,
  reserved in capacity over gRPC and paid on the rail. Each step carries a key derived from the
  request id, so a retry is the same request to the receiver and is applied once.
  <!-- proof: services/funding/test/system/saga.system.test.ts#FS-03 a funding request reaches COMPLETED -->
- **Compensation.** A payment the rail refuses releases the reservation.
  <!-- proof: services/funding/test/system/saga.system.test.ts#FS-06 a declined payment releases -->
- **Unknown outcomes go to a person.** A payment still unknown after its deadline is never
  compensated: the request is parked as `NEEDS_ATTENTION` with the capacity held, an alert fires,
  and the [runbook](docs/runbook.md) says what to do.
  <!-- proof: services/funding/test/integration/saga.int.test.ts#FS-10 a rail that times out on every attempt -->
  <!-- proof: deploy/observability/alerts.yaml:FundingNeedsAttention -->
- **The same contract over REST and gRPC.** Capacity's acceptance cases pass over both.
  <!-- proof: test/e2e/transports.e2e.test.ts#GR-03 -->
- **Side by side with `main`** on one machine: its own Compose project, ports shifted by 10000,
  its own image tags and cluster name. <!-- proof: test/architecture/isolation.test.ts#MS-01 -->
- **Kubernetes.** `make kind-up` installs the whole system into a local kind cluster behind
  Envoy Gateway; `make kind-smoke` runs one completed and one compensated request inside it.
  <!-- proof: make kind-smoke -->
- **All of it in CI**, the kind cluster included, on every push to the branch; green since the
  first push on 2026-10-31. <!-- proof: test/architecture/ci.test.ts#T23 kind job runs exactly make ki -->

## Limits

- Not built yet ([tasks](specs/0006-funding-saga/tasks.md)): Pact tests (T19, T20), the funding
  event relay to Kafka (T21), an operator command for `NEEDS_ATTENTION` (T22; until then the
  runbook gives the SQL), and funding reading capacity events (T24).
- gRPC between the services is plaintext HTTP/2 with a JWT on every call; no TLS or mTLS.
- The payment rail is a mock with fault markers in the invoice id; no real payment system.
- The kind smoke does not drive the timeout and 5xx faults, a capacity-side compensation or the
  saga through the gateway ([handoff](specs/0006-funding-saga/handoff.md)).
- Funding and the payments mock use plain `node:http` and zod, not NestJS.

## Try it

Needs Docker with 4 GB of memory, Node 24 and `make`; the cluster also needs `kind`, `helm` and
`kubectl`. Ports and requirements: [docs/local-stack.md](docs/local-stack.md#quick-start).

```bash
make install                    # check the machine, npm ci, start the stack, seed it
make demo-funding               # six funding scenarios on the live stack, capacity before and after
make kind-up && make kind-smoke # the same system in a local kind cluster
make verify && make test        # every check; make test needs Docker
```

<!-- proof: make install --> <!-- proof: make demo-funding --> <!-- proof: make verify --> <!-- proof: make test -->
Every acceptance criterion in [docs/PRD.md](docs/PRD.md) has a test whose name starts with its
id. <!-- proof: docs/PRD.md -->

## Where to read next

- [docs/README.md](docs/README.md): a one-hour reading path, from the business to the SQL.
- [docs/branch-technical-overview.md](docs/branch-technical-overview.md): each new part, the
  demo scenarios, the cluster and CI, and a summary of the capacity service.
- [docs/architecture.md](docs/architecture.md#branch-microservices-funding-the-payment-rail-and-the-grpc-hop):
  C4 diagrams and the saga step by step.
- [docs/api.md](docs/api.md#funding-api-branch-microservices): the funding API and the gRPC contract.
- [docs/position-fit.md](docs/position-fit.md): the assignment and the job description point by
  point, with proofs and gaps.
- [specs/0006-funding-saga/](specs/0006-funding-saga/spec.md): acceptance criteria, tasks and
  the handoff with what each run did not exercise.
- [docs/development-process.md](docs/development-process.md): how this was built with AI agents.

## License

[MIT](LICENSE)
