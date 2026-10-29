# Testing

## Run

```bash
make verify   # lint, types, layer rules, contract drift, unit + property tests (~20 s, no Docker)
make test     # everything, including real PostgreSQL and Kafka via Testcontainers (~4 min, needs Docker)
```

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
| Architecture tests | `test/architecture/` | dependency-cruiser layer rules really reject a leak (fixtures under `fixtures/layer-leaks`) | Nothing |
| Integration | `test/integration/` | Real SQL: locking under 50 concurrent reserves, idempotency races, migrations, reconciliation, invariant job | Docker |
| End to end | `test/e2e/` | The HTTP app with a real JWT issuer: auth, tenant isolation, queries, OpenAPI contract, metrics | Docker |
| Kafka | `test/kafka/` | Consumer with inbox, DLQ and redelivery; outbox relay order and fencing; message contracts | Docker |
| Fault | `test/fault/` | Kafka or PostgreSQL outage, SIGTERM drain, offsets committed only after the database | Docker |

`make verify` also runs `npm run contracts:check`: it regenerates `contracts/openapi.yaml` from
the zod schemas and fails if the committed file differs. Coverage of `domain` and
`application` must stay at or above 90% of lines.

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

## Why real containers

The interesting bugs in this service live in PostgreSQL locking and Kafka delivery: a
deadlock between two releases, a duplicate message, an offset committed too early. Mocks
cannot show them. Testcontainers starts PostgreSQL 18 and Kafka 4 once per test file, which
is why the integration suite takes a few minutes. [ADR 016](adr/016-testing-strategy.md).

## Load test

`make load` runs k6 (in Docker) against the running compose stack; see the README for the
numbers and what they mean.
