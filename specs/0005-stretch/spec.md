# 0005 — Stretch (M4)

**Status:** proposed · **Owner:** unassigned. First item in the cut order; starts only after the M3 gate.

## Why

Shows the job description's remaining asks (load numbers, DAST, Kubernetes readiness) once
the submission is safe: NFR-03/NFR-04 numbers and the M4 items of PRD §11. FR-16 (gRPC
adapter) was declined before any code; see ADR 022.

## Acceptance criteria

**NFR-03/NFR-04** — GIVEN the compose stack WHEN the k6 script runs a 100 req/s mix THEN p95
figures and hot-program throughput are recorded in the README.
proof (planned): `make load`

**ZAP** — GIVEN the api container WHEN the OWASP ZAP baseline scan runs in CI THEN no
high-risk alert. proof (planned): `.github/workflows/zap.yml`

**K8S** — GIVEN `deploy/k8s/` WHEN `kubectl apply --dry-run=client` runs THEN manifests for
api, worker and the migrate job validate with probes on the ops port.
proof (planned): `deploy/k8s/api.yaml`

## Invariants

No change to application code: this lane adds delivery files and a load script only.

## Out of scope

Helm, a real cluster, service mesh, a gRPC adapter (ADR 022).

## Tasks

See `tasks.md`.
