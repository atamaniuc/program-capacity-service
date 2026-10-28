# Architect review — lane 0005 Stretch (M4)

Reviewer: architect (subagent) · main @ the lane 0005 feature commit
Method: read-only inspection of `tools/load/scenario.js`, `.github/workflows/zap.yml` and
`deploy/k8s/*`. `kubectl apply --dry-run=client` cannot complete without a reachable API
server (discovery refused on localhost:8080); the five manifests were instead parsed with the
`yaml` package — all well-formed, probes on ops port 9464.

---

## Verdict: APPROVE — 0 MAJOR · 3 MINOR · 1 NOTE

The lane adds delivery files and a load script only; no application code changes, so no money
or concurrency invariant is touched. FR-16 (gRPC) was declined before the lane started
(ADR 022) and is out of this review. The findings below are ordering, measurement-depth and
documentation gaps.

## Findings

### MINOR-1 · Kubernetes manifests have no migrate-before-api/worker ordering
- Evidence: `deploy/k8s/migrate.yaml:1-16` is a standalone Job; `api.yaml`/`worker.yaml` have
  no initContainer, no `kubectl wait`, no Helm hook. Readiness only checks DB connectivity
  (`start.ts`, the readiness `ready` check), not schema presence, so on a fresh cluster the api pod can become Ready
  before migrations finish and serve 500s.
- Violates: PRD §13 compose semantics ("One-shot migrations before api and worker start") carried
  over to the k8s delivery; the review item "migrate Job ordering".
- Fix: document the ordering expectation, or add an initContainer that waits for the migrate Job
  (or make readiness verify the schema).

### MINOR-2 · k6 scenario never calls Release, so NFR-03's release p95 is unmeasured
- Evidence: `tools/load/scenario.js:39-52` — the 100 req/s mix is 80% capacity reads and 20%
  reserves; there is no release call. README records only aggregate `http_req_duration` p95
  (10.46 ms) and throughput (`README.md:36-39`).
- Violates: NFR-03 "reserve and release p95 ≤ 50 ms" (release half unmeasured); T2's claim of
  recorded load numbers covers reads and reserves only.
- Fix: add a release leg (e.g. reserve-then-release pairs on distinct reservations) and report
  read/reserve/release p95 separately, or explicitly descope the release measurement in the README.

### MINOR-3 · README and TRACKS contradict the merged M4 artefacts
- Evidence: `README.md:7` "M4 (stretch: load, k8s, ZAP) is not built" and the built table
  "not built; lane 0005 paused", while `specs/0005-stretch/tasks.md` T2–T4 are ticked and the
  files are in main. `specs/TRACKS.md` still says "next: k6 scenario".
- Violates: work-discipline constraint 10/11 (proof markers must resolve; claims must match state).
- Fix: update the README status/built table and TRACKS next-step before the M4 gate.

## Notes

### NOTE-1 · ZAP workflow is correct as a gate but shallow in coverage
- `.github/workflows/zap.yml:58` waits on `/health/live` rather than `/health/ready`; the scan
  runs without credentials, so the JWT-protected API surface answers mostly 401 and the baseline
  spider sees little of the real application. The "no high-risk alert" gate is still enforced:
  `zap-baseline.py -I` only suppresses warnings (verified against the upstream script), while
  high-risk FAIL findings still exit non-zero. Consider adding a valid JWT as a ZAP auth header and
  waiting on `/health/ready`.
