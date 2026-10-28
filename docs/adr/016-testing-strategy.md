# 016. Testing strategy: Testcontainers, property tests, AC-named tests

- Status: accepted
- Date: 2026-10-28

## Context

The risky behaviour is concurrency, transactions and Kafka delivery. Mocks of PostgreSQL or
Kafka would prove nothing about it.

## Decision

- Vitest with two projects: `unit` (`src/**/*.test.ts`, `test/architecture`, `test/property`)
  and `int` (`test/integration`, `test/e2e`, `test/kafka`, `test/fault`). `make verify` runs
  unit; `make test` runs both.
- Integration and e2e tests start real PostgreSQL 18 (and Kafka) through Testcontainers.
- fast-check properties cover the money maths; coverage gate of 90% lines on domain and
  application.
- Every acceptance criterion maps to a test whose name starts with its id (`AC-08 ...`,
  `SK-03 ...`); a ticked task carries a proof marker that resolves to that test.

## Consequences

Integration tests need Docker and are slower; they run in CI on `ubuntu-latest`.

## Alternatives rejected

A Cucumber runtime: Given/When/Then lives in specs and test names instead.
