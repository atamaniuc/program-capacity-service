# Program Capacity Service

Real-time credit capacity for supply chain finance programs: reserve on invoice approval,
release on repayment, reconcile against the bank's treasury, never over-reserve.
Take-home for a senior Node.js role; requirements in [docs/PRD.md](docs/PRD.md). <!-- proof: docs/PRD.md -->

> **Status: M0 and M1 done; M2 and M3 in progress.** This README states only what exists. Sections marked
> _planned_ describe the target from the PRD and become claims, with proof markers, as the
> lanes in [specs/TRACKS.md](specs/TRACKS.md) close. <!-- proof: specs/TRACKS.md -->

## Quick start (`make up` and `make token` work; seed and demo arrive with lane 0003)

```bash
make up      # PostgreSQL 18, Kafka 4 (KRaft), mock OAuth2, migrate, api, worker
make seed    # 3 tenants, 6 programs, FX rates, ~200 invoices
make token TENANT=bank-a SCOPES="capacity:read capacity:write"
make demo    # every critical-path scenario against the running stack
```
<!-- proof: Makefile -->

## How work is checked

- `make status` — harness gates, last logged gate, last commits, next action. <!-- proof: tools/status.sh -->
- `npx harnessimo check` — documentation claims, lane index, ticked tasks, work queue. It runs
  in the pre-commit hook. <!-- proof: .githooks/pre-commit -->
- Every acceptance criterion in the PRD maps 1:1 to a test whose name starts with its AC id.

## Built / not built

| Area | State |
| --- | --- |
| PRD, review edits, lanes 0001–0005 | written |
| Skeleton: tooling, layer rules, config validation, ops port, migrations, compose, CI | built <!-- proof: test/architecture/layers.test.ts#SK-02 --> <!-- proof: test/e2e/ops.e2e.test.ts#SK-04 --> |
| Reserve, release, capacity read, Idempotency-Key, JWT auth and tenant isolation, ledger, OpenAPI from zod | built <!-- proof: test/integration/reserve-concurrency.int.test.ts#AC-01 --> <!-- proof: test/e2e/auth.e2e.test.ts#AC-13 --> <!-- proof: make verify --> |
| Everything else | not built yet; see `specs/TRACKS.md` |

Each milestone gate is logged with a timestamp in `.harness/4-state/BUDGET.md`. Cut order when
behind: M4 (gRPC, k6, ZAP, k8s) → OpenTelemetry profile → invariant job → list endpoints →
outbox relay. <!-- proof: .harness/4-state/BUDGET.md -->
