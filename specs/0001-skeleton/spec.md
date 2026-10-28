# 0001 — Skeleton (M0)

**Status:** in progress · **Owner:** implementer (sonnet), gated by architect

## Why

Every later lane needs a repository that builds, lints, type-checks, runs tests against
real PostgreSQL and Kafka, and starts with one command. PRD §11 M0: "Repo, tooling, compose
(PostgreSQL, Kafka, mock OAuth2), config validation, ops endpoints, CI with lint, types and
tests." Gate: "`docker compose up` is healthy and CI is green on an empty feature set."

## User stories

**US-01** — As a reviewer, I want `make up` to start the whole stack healthy, so that I can
run the demo without reading setup docs.
**US-02** — As an implementer, I want `make verify` and `make test` to fail on layer leaks,
type errors and broken tests, so that later lanes cannot regress silently.

## Acceptance criteria

No PRD AC belongs to M0; these lane checks (SK-xx) gate it. Each names its proving command.

**SK-01** — GIVEN a fresh clone WHEN `npm ci && make verify` runs THEN lint, typecheck,
dependency-cruiser and unit tests pass with zero warnings promoted to errors.
proof (planned): `make verify`

**SK-02** — GIVEN a file in `src/capacity/domain` that imports `@nestjs/common` WHEN
`npm run depcruise` runs THEN it fails naming the rule.
proof (planned): `test/architecture/layers.test.ts#SK-02`

**SK-03** — GIVEN an environment missing `DATABASE_URL` or with `APP_ROLE=web` WHEN the
process boots THEN it exits non-zero with a zod error naming the field and no secret value.
proof (planned): `src/platform/config/config.test.ts#SK-03`

**SK-04** — GIVEN the app booted with `APP_ROLE=api` WHEN `GET /health/live`,
`GET /health/ready` and `GET /metrics` hit the ops port THEN 200, 200 with `db: up`, and a
Prometheus text body; the business port does not serve them.
proof (planned): `test/e2e/ops.e2e.test.ts#SK-04`

**SK-05** — GIVEN PostgreSQL 18 in Testcontainers WHEN migrations run twice THEN the second
run is a no-op and `SELECT 1` succeeds through the Kysely pool.
proof (planned): `test/integration/migrations.int.test.ts#SK-05`

**SK-06** — GIVEN Docker WHEN `make up` runs THEN postgres, kafka, kafka-init, oauth,
migrate, api and worker reach healthy/completed, and `make token` prints a JWT whose
`tenant_id` and `scope` claims match the arguments.
proof (planned): `make up`

**SK-07** — GIVEN a push WHEN the CI workflow runs THEN `npx harnessimo check`, lint,
typecheck, depcruise, unit and integration tests, image build, Trivy and gitleaks run.
proof (planned): `.github/workflows/ci.yml`

## Invariants

- `src/capacity/domain` has no framework imports (NFR-13); ESM with `#src/*` imports, no TS
  path aliases; strict TypeScript.
- Ops endpoints live only on the internal port (`OPS_PORT`, default 9464) — A8.
- No secret in git; `.env.example` holds placeholders only.

## Out of scope

Any table beyond what proves migrations work (the eight domain tables are lane 0002), any
business endpoint, Kafka consumers (0003), OpenTelemetry (0004).

## Tasks

See `tasks.md`.
