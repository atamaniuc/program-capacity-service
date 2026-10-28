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
- **Every money or concurrency guard has a test that fails when the guard is removed.** A
  green suite proves nothing about a line that no test can reach. The architect checks this
  with a mutation probe: delete the line, run the tests, expect red, `git checkout`. Lane 0002
  review:

  | Line removed | Result | Action |
  | --- | --- | --- |
  | `program … FOR UPDATE` | AC-01 red (the guard catches it: "matched no row") | none |
  | `credit_limit_minor - reserved_minor >= :amount` | **all 26 tests green** | added `program-guard.int.test.ts` |
  | `DEFERRABLE INITIALLY DEFERRED` on the `release_ref` FK | AC-05 concurrency test red, `deadlock detected` | none |

  A guard that sits behind a primary check (a lock, an earlier `if`) cannot be reached end to
  end. It is tested at the layer where it lives, such as the repository against real
  PostgreSQL.
- A concurrency test must prove the overlap, not just start requests together. AC-02 waits
  until `pg_stat_activity` shows the duplicate blocked on `transactionid` before it releases
  the first transaction.

## Consequences

Integration tests need Docker and are slower; they run in CI on `ubuntu-latest`.

## Alternatives rejected

A Cucumber runtime: Given/When/Then lives in specs and test names instead.
