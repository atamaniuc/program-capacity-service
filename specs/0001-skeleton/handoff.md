# Handoff — 0001 Skeleton (M0)

## Context

First lane of the Program Capacity Service take-home. It produces the empty but production-shaped service every
other lane builds on. Planned slot: 0:00–0:45.

## What to load

1. `specs/0001-skeleton/spec.md` and `tasks.md` — the checks you must turn green.
2. `docs/PRD.md` §10 (stack table), §13 (repo tree, compose services, make targets, CI).
3. `AGENTS.md` and `.harness/1-instructions/CONSTRAINTS.md`.

**What NOT to load:** PRD §4–§9 (domain, reconciliation, API detail — lanes 0002/0003),
the other lanes' specs.

## Owns

- package.json
- package-lock.json
- tsconfig.json
- tsconfig.build.json
- eslint.config.js
- vitest.config.ts
- .dependency-cruiser.cjs
- .prettierrc
- .env.example
- Dockerfile
- .dockerignore
- deploy/compose.yaml
- deploy/postgres/**
- .github/workflows/ci.yml
- .github/workflows/codeql.yml
- .github/dependabot.yml
- src/main.ts
- src/platform/config/**
- src/platform/health/**
- src/platform/logging/**
- src/platform/bootstrap/**
- src/capacity/adapters/out/postgres/db.ts
- src/capacity/adapters/out/postgres/migrate.ts
- src/capacity/adapters/out/postgres/migrations/0001_baseline.sql
- test/support/**
- test/architecture/**
- test/e2e/ops.e2e.test.ts
- test/integration/migrations.int.test.ts
- tools/token/**
- docs/glossary.md
- docs/adr/012-kysely-sql-migrations.md
- docs/adr/016-testing-strategy.md
- docs/adr/018-hexagonal-architecture.md
- docs/adr/020-ubiquitous-language.md

## Depends on

## State

Nothing built. Harness, Makefile targets and `tools/status.sh` exist and pass
`npx harnessimo check`. Verified versions on 2026-10-28: Node 24.21 local, `@nestjs/core`
12.3.2, `@nestjs/cli` 12.0.11 (pins `typescript ~6.0.2`), `kysely` 0.29.7, `zod` 4.6.7,
`zod-openapi` 6.0.2, `@confluentinc/kafka-javascript` 1.11.0, `jose` 6.2.13, `pino` 10.4.0,
`vitest` 5.0.5, `@testcontainers/postgresql` 12.2.1, `dependency-cruiser` 18.7.0.

## Decisions taken

- TypeScript 6.0.x, not 7 (Nest CLI pin). ESM, `#src/*` imports via `package.json` `imports`.
- Validation is zod only; no class-validator, no `@nestjs/swagger`.
- Mock OAuth2: a lightweight container that serves JWKS and issues client-credentials tokens
  with custom `tenant_id`/`scope` claims (e.g. `ghcr.io/navikt/mock-oauth2-server`); pick a
  pinned tag and record it.
- Kafka client: `@confluentinc/kafka-javascript`; image must build on Debian slim.
- Planned proofs are plain text until the evidence exists; a ticked box gets a real marker.

## First step

Write `package.json` dependencies and scripts, `tsconfig.json`, `eslint.config.js`,
`vitest.config.ts`, then run `npm ci && make verify` on an empty `src/` and quote the output.
