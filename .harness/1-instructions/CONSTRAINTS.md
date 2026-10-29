# CONSTRAINTS

Hard rules. A violation is a defect, not a style disagreement. Each rule names what catches
it: `enforced by: <command>` means a command fails; `review-only` means a reviewer must look.
An unlabelled constraint does not exist. Rules marked _(lands in 0001)_ name a command the
skeleton lane creates; until then they are review-only in practice.

## Correctness

1. **Money is `bigint` minor units plus an ISO 4217 code; no binary floating point on the
   money path (I8).** enforced by: `make verify` (domain property tests; ESLint
   `no-restricted-syntax` on `parseFloat`/`Number(` in `src/capacity/domain`) _(lands in 0001)_
2. **A capacity change, its ledger entry, its inbox mark, its outbox row and its idempotency
   row commit in one PostgreSQL transaction (NFR-02).** enforced by: `make test`
   (crash and rollback integration tests in lane 0002/0003) + review-only for new use cases
3. **Lock order is dedup row → `program` row → reservation rows. No `SELECT … FOR UPDATE` on
   the idempotency path (review D3 closed).** enforced by: `make test` (AC-01, AC-02
   concurrency tests) + review-only by `architect`
4. **Ledger rows are never updated or deleted (NFR-09).** enforced by: `make test`
   (trigger test in lane 0002)
5. **No session state in PostgreSQL: no session advisory locks, no `SET` outside a
   transaction (NFR-15).** review-only

## Architecture

6. **`domain` imports nothing outside itself; `application` imports no adapter; adapters
   do not import each other; slices do not import each other.** enforced by: `npm run
   depcruise` inside `make verify` _(lands in 0001)_
7. **Strict TypeScript, ESM, no TS path aliases (use `#src/*`).** enforced by: `npm run
   typecheck` inside `make verify` _(lands in 0001)_
8. **One schema source: zod. OpenAPI (`contracts/openapi.yaml`), AsyncAPI
   (`contracts/asyncapi.yaml`) and the message JSON Schemas (`contracts/json-schema/`) are
   generated from it; no `@nestjs/swagger` decorators, no class-validator, no hand-edited
   contract file.** enforced by: `npm run contracts:check` (fails when any committed file differs
   from the generated one), `npm run contracts:compat` in CI (no breaking change against the base
   commit: oasdiff and the message-schema rule) and `test/kafka/capacity-events.kafka.test.ts`
   (real events against the committed schemas) _(lands in 0002; AsyncAPI for outbound events 2026-10-29)_
9. **Settled decisions are not relitigated: modular monolith, no Redis, no event sourcing,
   no Saga, no GraphQL, no CQRS read store, no Pact, no gRPC adapter (ADR 022).**
   review-only (rationale in PRD §7 and §10)

## Work discipline

10. **Every acceptance criterion maps 1:1 to a test whose name starts with its AC id, and
    every ticked task carries a proof marker.** enforced by: `npx harnessimo tasks`
11. **Documentation claims in README.md and AGENTS.md carry proof markers that resolve.**
    enforced by: `npx harnessimo proof --strict`
12. **AGENTS.md and CLAUDE.md stay routers of at most 80 lines.** enforced by:
    `npx harnessimo instructions`
13. **No `TODO`, `FIXME`, `.only(`, `.skip(` or `debugger` left in `src/`, `test/`, `tools/`
    at a gate.** enforced by: `npx harnessimo clean-exit`
14. **No secrets in git; config is validated at boot.** enforced by: gitleaks in CI
    _(lands in 0001)_ + `make test` (config validation test)
15. **This file is a locked surface; an agent commit may not change it.** enforced by:
    `npx harnessimo locked`
