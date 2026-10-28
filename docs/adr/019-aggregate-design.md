# 019. Aggregate design: Program as the consistency boundary

- Status: accepted
- Date: 2026-10-28

## Context

The invariants span a program's limit, its reserved total and its reservations.

## Decision

`Program` is the consistency boundary: capacity is checked and changed only under its row lock.
`Reservation` is a separate row guarded by the same lock (never loaded without the program in
a write path), because loading all reservations into one aggregate would grow without bound.
Pure functions in the domain decide: `checkReserve`, `computeRelease`, `convertRoundingUp`,
`hasSameTerms`. Use cases orchestrate ports inside one `UnitOfWork`; adapters implement ports
with raw SQL. The domain imports nothing outside itself (dependency-cruiser), and slices share
only the domain and `application/shared`.

## Consequences

- Domain rules are unit and property testable without a database (90% line gate).
- Concurrency correctness is proven by integration tests, not by the in-memory fake.

## Alternatives rejected

Reservation as child collection of Program (unbounded load), anemic services over SQL (rules
untestable), CQRS read store (settled).
