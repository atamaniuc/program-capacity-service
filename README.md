# Program Capacity Service

Real-time credit capacity for supply chain finance programs: reserve on invoice approval,
release on repayment, reconcile against the bank's treasury, never over-reserve.
Take-home for a senior Node.js role; requirements in [docs/PRD.md](docs/PRD.md). <!-- proof: docs/PRD.md -->

> **Status: M0, M1, M2, M3 and M4 are done.**
> This README states only what exists. <!-- proof: specs/TRACKS.md -->

## Quick start

```bash
make up      # PostgreSQL 18, Kafka 4 (KRaft), mock OAuth2, migrate, api, worker
make seed    # 3 tenants, 6 programs, FX rates, ~200 invoices
make token TENANT=bank-a SCOPES="capacity:read capacity:write"
make demo    # every critical-path scenario against the running stack
```
<!-- proof: Makefile -->

## How work is checked

- `make status` — harness gates, last logged gate, last commits, next action. <!-- proof: tools/status.sh -->
- `npx harnessimo check` — documentation claims, lane index, ticked tasks, work queue; it runs
  in the pre-commit hook. <!-- proof: .githooks/pre-commit -->
- `make verify && make test` — lint, types, dependency rules, contracts, unit/property,
  integration, e2e and fault tests on real PostgreSQL and Kafka.
- Every acceptance criterion in the PRD maps 1:1 to a test whose name starts with its AC id.

## Load (k6)

`make load` runs `tools/load/scenario.js` in Docker `grafana/k6` — no local k6 binary is
needed. Two 100 requests/s phases run against the local compose stack (macOS arm64): a
**spread** phase round-robinning across all 6 seeded programs, and a **hot** phase driving
`prg_grand_usd` alone. Both use 80% capacity reads and 20% reserve-then-release pairs.

**NFR-03 spread phase** — the targets are met: read p95 ≤ 20 ms, reserve and release p95 ≤ 50 ms.

| Metric | p95 |
| --- | --- |
| Capacity read | 4.60 ms |
| Reserve | 13.39 ms |
| Release | 16.76 ms |

**NFR-04 hot-program phase** — one program row serialises every write, so p95 grows well past
the NFR-03 targets. This is the documented contention behaviour, not a defect: the PRD scale
path answers it with capacity buckets and a read replica (PRD §7 T4, §8 scale path).

| Metric | p95 |
| --- | --- |
| Capacity read | 656.84 ms |
| Reserve | 1260.74 ms |
| Release | 998.71 ms |
| Aggregate `http_req_duration` | 292.95 ms |

## Built / not built

| Area | State |
| --- | --- |
| PRD, review edits, lanes 0001–0005 | written |
| Skeleton: tooling, layer rules, config validation, ops port, migrations, compose, CI | built <!-- proof: test/architecture/layers.test.ts#SK-02 --> <!-- proof: test/e2e/ops.e2e.test.ts#SK-04 --> |
| Reserve, release, capacity read, Idempotency-Key, JWT auth and tenant isolation, ledger, OpenAPI from zod | built <!-- proof: test/integration/reserve-concurrency.int.test.ts#AC-01 --> <!-- proof: test/e2e/auth.e2e.test.ts#AC-13 --> <!-- proof: make verify --> |
| Treasury ingest: Kafka consumer with inbox/DLQ/backoff, FX rates, reconciliation with staged diff, simulator, seeds | built <!-- proof: test/kafka/treasury-consumer.kafka.test.ts#AC-07 --> <!-- proof: test/integration/reconcile.int.test.ts#AC-08 --> <!-- proof: make demo --> |
| Queries: list reservations and program ledger with cursor pagination (FR-12) | built <!-- proof: test/e2e/queries.e2e.test.ts#FR-12 --> |
| Outbox relay under a TTL lease with epoch fencing and `outbox_lag` (FR-13) | built <!-- proof: test/kafka/outbox-relay.kafka.test.ts#FR-13 --> |
| Scheduled jobs: invariant check every 5 minutes, retention cleanup (FR-15, NFR-11) | built <!-- proof: test/integration/invariant-job.int.test.ts#FR-15 --> |
| Outage and SIGTERM behaviour: readiness flips, in-flight requests and messages drain, offsets commit (NFR-06, NFR-07) | built <!-- proof: test/fault/outage.fault.test.ts#NFR-06 --> <!-- proof: test/fault/shutdown-worker.fault.test.ts#NFR-07 --> |
| OpenTelemetry traces, RED and domain metrics, observability compose profile (NFR-10) | built <!-- proof: test/e2e/observability.e2e.test.ts#NFR-10 --> |
| Runbook and ADRs 001–021 | written <!-- proof: docs/runbook.md --> |
| k6 load with measured NFR-03/NFR-04 numbers, Kubernetes manifests, ZAP workflow (M4); gRPC adapter declined, see [ADR 022](docs/adr/022-no-grpc-adapter.md) | built <!-- proof: make load --> <!-- proof: deploy/k8s/api.yaml --> <!-- proof: .github/workflows/zap.yml --> |

## Production mapping (not built)

| Local | Production |
| --- | --- |
| PostgreSQL 18 in compose | RDS or Aurora with RDS Proxy |
| Kafka 4 in compose | MSK with IAM auth over TLS |
| `api` and `worker` roles | ECS Fargate or EKS |
| mock OAuth2 | the bank's IdP or Cognito |
| env vars in compose | Secrets Manager |
| Prometheus/Grafana/Jaeger | ADOT collector → CloudWatch and X-Ray |

## Time and cuts

Each milestone gate is logged with a timestamp in `.harness/4-state/BUDGET.md`. Cut order when behind: M4 (k6, ZAP, k8s) →
OpenTelemetry profile → invariant job → list endpoints → outbox relay. In the end nothing was
cut.
<!-- proof: .harness/4-state/BUDGET.md -->
