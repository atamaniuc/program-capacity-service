# 0005 — Stretch (M4)

**Status:** proposed · **Owner:** unassigned. First item in the cut order; starts only after the M3 gate.

## Why

Shows the job description's remaining asks (gRPC, load numbers, DAST, Kubernetes readiness)
once the submission is safe. Requirement: FR-16 (verbatim in PRD §4), plus NFR-03/NFR-04
numbers and M4 items of PRD §11.

## User stories

**US-01** — As a platform service in a future split, I want a gRPC adapter over the same use
cases, so that the service-to-service contract exists before any new network hop.

## Acceptance criteria

**FR-16** — GIVEN a valid JWT in `authorization` metadata WHEN `Reserve`, `Release` and
`GetCapacity` are called over gRPC with deadlines THEN results match the REST adapter,
including idempotency and tenant isolation.
proof (planned): `test/e2e/grpc.e2e.test.ts#FR-16`

**NFR-03/NFR-04** — GIVEN the compose stack WHEN the k6 script runs a 100 req/s mix THEN p95
figures and hot-program throughput are recorded in the README.
proof (planned): `make load`

**ZAP** — GIVEN the api container WHEN the OWASP ZAP baseline scan runs in CI THEN no
high-risk alert. proof (planned): `.github/workflows/zap.yml`

**K8S** — GIVEN `deploy/k8s/` WHEN `kubectl apply --dry-run=client` runs THEN manifests for
api, worker and the migrate job validate with probes on the ops port.
proof (planned): `deploy/k8s/api.yaml`

## Invariants

The gRPC adapter is a driving adapter only; it adds no business rule and no new code path.

## Out of scope

Helm, a real cluster, service mesh.

## Tasks

See `tasks.md`.
