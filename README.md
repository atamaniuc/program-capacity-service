# Program Capacity Service

Real-time credit capacity for supply chain finance programs: reserve on invoice approval,
release on repayment, reconcile against the bank's treasury, never over-reserve.
Take-home for a senior Node.js role; requirements in [docs/PRD.md](docs/PRD.md). <!-- proof: docs/PRD.md -->

> **Status: M0, M1, M2 and M3 are done; M4 (stretch: gRPC, load, k8s, ZAP) is not built.**
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
| gRPC adapter, k6 load, Kubernetes manifests, ZAP scan (M4) | not built; lane 0005 paused |

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

Each milestone gate is logged with a timestamp in `.harness/4-state/BUDGET.md`. Cut order when
behind: M4 (gRPC, k6, ZAP, k8s) → OpenTelemetry profile → invariant job → list endpoints →
outbox relay. M4 was cut; the other four are built.
<!-- proof: .harness/4-state/BUDGET.md -->
