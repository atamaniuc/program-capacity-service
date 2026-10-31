# Testing

## Run

```bash
make verify    # lint, types, layer rules, OpenAPI/AsyncAPI drift, unit and property tests (~20 s);
               # on the branch also proto lint/breaking and the same checks in every workspace
make test      # all tests with real PostgreSQL and Kafka via Testcontainers (~4 min, needs Docker)
make qa        # 103 QA checks on the running stack: endpoints, Kafka input, DB and events (qa.md)
make compat    # no breaking contract change (oasdiff + message schemas; Docker);
               # what counts as breaking and why: api.md §8
make load      # k6 load test against the running stack
```

<!-- proof: make verify --> <!-- proof: make test --> <!-- proof: make compat -->
On the branch the cluster has its own checks: `make helm-check` (no cluster) and
`make kind-up && make kind-smoke` ([local-stack.md](local-stack.md#kubernetes-branch-microservices));
CI runs both ([branch-technical-overview.md](branch-technical-overview.md#kubernetes-in-ci)).

One file or one test:

```bash
npx vitest run --project unit src/capacity/domain/money.test.ts
npx vitest run --project int test/integration/reserve-concurrency.int.test.ts -t "AC-01"
```

On the running stack (`make install`), `make demo` plays the scenarios end to end and
`make qa` runs the [QA test cases](qa.md): every endpoint and treasury message, with the rows,
events and metrics each one must leave behind.

## Levels

| Level | Where | What it proves | Needs |
| --- | --- | --- | --- |
| Domain and use-case unit tests | next to the code, `src/**/*.test.ts` | Money maths, rounding, release split, reconciliation policy, use cases against in-memory ports | Nothing |
| Property tests | `test/property/` | Random sequences of reserve/release never break the invariants (fast-check) | Nothing |
| Contract tests | `test/contracts/` | The AsyncAPI document, the compatibility rule, the docs page | Nothing |
| Architecture tests | `test/architecture/` | dependency-cruiser layer rules really reject a leak (fixtures under `fixtures/layer-leaks`) | Nothing |
| Integration | `test/integration/` | Real SQL: locking under 50 concurrent reserves, idempotency races, migrations, reconciliation, invariant job | Docker |
| End to end | `test/e2e/` | The HTTP app with a real JWT issuer: auth, tenant isolation, queries, OpenAPI contract, Swagger and AsyncAPI pages, metrics | Docker |
| Kafka | `test/kafka/` | Consumer with inbox, DLQ and redelivery; outbox relay order and fencing; every real event on `capacity.events.v1` against the published contract | Docker |
| Fault | `test/fault/` | Kafka or PostgreSQL outage, SIGTERM drain, offsets committed only after the database | Docker |

`make verify` also runs `npm run contracts:check`: it regenerates everything under
`contracts/` (OpenAPI, AsyncAPI, one JSON Schema per Kafka message) from the zod schemas and
fails if a committed file differs. Coverage of `domain` and `application` must stay at or above
90% of lines.

## Contract tests

The contracts are generated from the code, and tests check that the code really sends and
accepts what they say ([ADR 015](adr/015-contracts.md)):

| What | Test |
| --- | --- |
| Committed files equal what the zod schemas generate | `npm run contracts:check` (`make verify`, CI) and `test/kafka/contracts.test.ts` |
| Real REST responses match the OpenAPI component schemas | `test/e2e/contract.e2e.test.ts` |
| The AsyncAPI document is valid AsyncAPI 3.1 (official `@asyncapi/parser`), lists every topic in and out, and every example in it validates | `test/contracts/asyncapi.test.ts` |
| No breaking change against the base commit: oasdiff for OpenAPI, `compare-schemas.ts` for the message and header schemas ([rules](api.md#8-changing-a-contract)) | `npm run contracts:compat` (`make compat`, CI); the rule itself in `test/contracts/compare-schemas.test.ts` |
| Dead letters carry the published `DlqHeaders` | `test/kafka/treasury-consumer.kafka.test.ts` (AC-11) |
| Every simulator message validates against the treasury schemas; malformed ones do not | `test/kafka/contracts.test.ts` |
| Every event the running service publishes matches its schema, has no field the schema leaves out, carries valid headers and the right key, and `seq` is gap-free | `test/kafka/capacity-events.kafka.test.ts` (all four event types from HTTP and treasury input) |
| `/docs` and `/docs/asyncapi` are served offline on the ops port only; the page degrades to the raw document without the viewer | `test/e2e/contract.e2e.test.ts`, `test/contracts/api-docs.test.ts` |

The "no extra field" check uses a strict variant of each schema (`additionalProperties: false`)
built from the same zod source. The committed schemas stay open, so consumers can ignore fields
added later in `v1`. On the live stack, `npm run contracts:events` runs the same checks against
whatever is on `capacity.events.v1` (QA-72).

## How requirements map to tests

Every acceptance criterion in [PRD.md](PRD.md) §4 has a test whose name starts with its id:

```bash
grep -rn "AC-08" test src     # find the proof of AC-08 (reconciliation)
```

Some examples:

| Id | Requirement | Test |
| --- | --- | --- |
| AC-01 | Never over-reserve under concurrency | `test/integration/reserve-concurrency.int.test.ts` |
| AC-07 | Repayment from Kafka releases capacity | `test/kafka/treasury-consumer.kafka.test.ts` |
| AC-08 | Reconciliation follows the case table | `test/integration/reconcile.int.test.ts` |
| AC-13 | Every business endpoint requires a valid JWT | `test/e2e/auth.e2e.test.ts` |
| AC-16 | Tenants never see or change each other's programs | `test/e2e/auth.e2e.test.ts` |
| NFR-06 | The API keeps working while Kafka is down | `test/fault/outage.fault.test.ts` |
| NFR-07 | SIGTERM drains in-flight work | `test/fault/shutdown*.fault.test.ts` |
| FR-13 | Outbound events match the published AsyncAPI contract | `test/kafka/capacity-events.kafka.test.ts` |

## Why real containers

The interesting bugs in this service live in PostgreSQL locking and Kafka delivery: a
deadlock between two releases, a duplicate message, an offset committed too early. Mocks
cannot show them. Testcontainers starts PostgreSQL 18 and Kafka 4 once per test file, which
is why the integration suite takes a few minutes. [ADR 016](adr/016-testing-strategy.md).

## Load test

`make load` runs [k6](https://k6.io) in Docker against the compose stack on a laptop (macOS,
Apple silicon): a 20 s warm-up that is not measured, then two 30 s phases at 100 requests/s
(80% capacity reads, 20% reserve-then-release pairs, each write with an `Idempotency-Key`). The
run **fails** when the spread phase misses NFR-03 (read p95 < 20 ms, reserve and release p95 <
50 ms). Two consecutive runs (measured on `main`, before the funding services existed):

| Phase | Read p95 | Reserve p95 | Release p95 |
| --- | --- | --- | --- |
| Spread over 6 programs (the normal case) | 3.5–4.3 ms | 18.6–25.2 ms | 21.6–25.4 ms |
| Every request on one program (worst case, 20 writes/s on one row) | 4.4–9.8 ms | 27.5–57.8 ms | 29.4–61.8 ms |

At this rate one program absorbs the writes; its p95 is about twice the spread case, because
the writes queue on the program's row lock. The ceiling of one program was not measured. When
it matters, the scale path is to split one limit into several "capacity buckets"
([PRD §8](PRD.md#8-system-design), not built). Without the warm-up, whichever phase runs
first pays the cold start (JIT, connection pools) and misses the target by a wide margin.
These are laptop runs, useful for comparison, not a benchmark.
<!-- proof: make load -->
