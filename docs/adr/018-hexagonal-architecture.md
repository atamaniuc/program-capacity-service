# 018. Architecture: hexagonal, vertical slices, tactical DDD

- Status: accepted; on branch `microservices` the repository gains npm workspaces for the new services ([ADR 027](027-repository-layout-and-side-by-side-isolation.md))
- Date: 2026-10-28

## Context

One bounded context, one aggregate and one invariant, delivered as a single Nest application
with `api` and `worker` roles. The domain must stay testable without containers.

## Decision

Hexagonal layout under `src/capacity`: `domain` (aggregate, value objects, policies),
`application` (ports and one folder per use-case slice) and `adapters` (`in/http`, `in/kafka`,
`in/jobs`, `out/postgres`, `out/kafka`). `src/platform` holds config, logging, health and
bootstrap. dependency-cruiser fails the build when `domain` imports anything outside itself,
`application` imports an adapter or platform code, one adapter imports another, or one slice
imports another. No monorepo tooling.

## Consequences

A new entry point is one more driving adapter. Slices duplicate a little wiring
instead of sharing internals.

## Alternatives rejected

Clean Architecture rings and per-layer DTO mappers (ceremony without safety), Nx or a Nest
monorepo (one deployable, one package).
