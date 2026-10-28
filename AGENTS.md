# AGENTS.md — router

**What this is.** Program Capacity Service: holds the real-time credit capacity of every
supply chain finance program and refuses any reservation that would exceed it. NestJS 12
modular monolith (`api` and `worker` roles, one image), PostgreSQL as the single source of
truth, Kafka for treasury input and outbound events. The requirements live in
[docs/PRD.md](docs/PRD.md) <!-- proof: docs/PRD.md -->; do not restate them here.

## Start every session

1. `make status` — harness check, last logged gate, last commits, next action. <!-- proof: make status -->
2. `npx harnessimo brief` — live lanes and the head of each handoff.
3. Open the active lane's `handoff.md` from [specs/TRACKS.md](specs/TRACKS.md) and load only
   what its "What to load" section names. <!-- proof: specs/TRACKS.md -->

## Run

- `make` — every command with a one-line description.
- `make up` — compose stack (PostgreSQL, Kafka, mock OAuth2, migrate, api, worker).
- `make seed`, `make token`, `make demo` — seed data, a JWT, every demo scenario.
<!-- proof: Makefile -->

## Check

- `make verify` — lint, types, dependency-cruiser layer rules, unit and property tests. <!-- proof: make verify -->
- `make test` — every level, real containers through Testcontainers. <!-- proof: make test -->
- `npx harnessimo check` — the harness gates; `Stop` hooks and pre-commit run it. <!-- proof: .githooks/pre-commit -->

"Done" means those commands are green and their output is quoted. Nothing else counts.

## Where things are

| Need | Go to |
| --- | --- |
| Human docs: reading path, architecture (C4), API, trade-offs | `docs/README.md` |
| Requirements, FR/AC/NFR, invariants I1–I8 | `docs/PRD.md` |
| Hard rules and what enforces each | `.harness/1-instructions/CONSTRAINTS.md` |
| Work lanes (spec, tasks, handoff) | `specs/NNNN-slug/` indexed by `specs/TRACKS.md` |
| Progress, decisions (ADR index), time log | `.harness/4-state/` |
| ADR files, glossary, runbook | `docs/adr/`, `docs/glossary.md`, `docs/runbook.md` |
| Code layout | `src/capacity/{domain,application,adapters}`, `src/platform/` (PRD §13) |

## Rules that bite

- Domain code imports nothing outside `src/capacity/domain`. Slices never import each other.
- Money is `bigint` minor units plus an ISO 4217 code. No `number` arithmetic on money.
- One transaction per use case: state, ledger, inbox, outbox and idempotency row commit together.
- Lock order: dedup row → `program` row → reservation rows. Never `SELECT … FOR UPDATE` on the idempotency row.
- Test names start with the AC id (`AC-08 keeps …`); every ticked task carries a proof marker.
- Words come from `docs/glossary.md`. No *allocation*, *booking* or *balance*.
- Do not relitigate: monolith, no Redis, no event sourcing, no Saga, no GraphQL, no Pact, no `@nestjs/swagger`.

## Roles

`architect` (opus) specs, gates, money/concurrency review · `implementer` (sonnet) one lane's
code · `scout` (haiku) read-only recon. Definitions in `.claude/agents/`.
Blocked more than 3 attempts → write it in the handoff and stop. Never bypass a check.
