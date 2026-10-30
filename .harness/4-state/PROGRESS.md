# PROGRESS

State carried between sessions. Read this first; update it before you stop.

## Now

All five lanes are closed and all queue gates pass. A post-submission review of lanes
0003–0005 found 1 BLOCKER and 5 MAJOR items; all are fixed,
re-reviewed (APPROVE) and recorded in DECISIONS. Docs were rewritten for human readers
(`docs/README.md`), the gRPC adapter was declined (ADR 022), `/docs` became an interactive
Swagger UI, and the k6 numbers were re-measured with a warm-up. On 2026-10-29 the Kafka
contract was completed: AsyncAPI now covers `capacity.events.v1` and both DLQs, is generated
from the zod schemas that type the outbox payloads, is served at `/docs/asyncapi`, and every
real event is checked against it; `make compat` (CI) blocks breaking contract changes. Last
full run: 106 unit + 102 integration tests green. `make install` sets up a fresh clone in one
command (~3 min); `make qa` runs the [QA test cases](../../docs/qa.md) on the live stack:
103/103 on 2026-10-29. Kafka UI (`kafbat/kafka-ui`, `localhost:8080`) is in the
`observability` compose profile with Prometheus, Grafana and Jaeger; `make up-all` starts them all; how to check the service with it is in `docs/qa.md`.

## Done

- Repository initialised; harnessimo 0.10.1 adopted from npm (no divergence from upstream templates).
- PRD edits per bootstrap §5 / review §7: FR-16 renamed "gRPC adapter (P2)"; Evolution
  section gains split preconditions and when Pact or a schema registry appear; cut order
  recorded in §11; OpenAPI-from-zod and `/docs` placement in §10; dated facts
  re-checked on 2026-10-28 (Node 26 enters LTS today, Drizzle v1 is an RC, TS 7 is `latest`
  but Nest CLI 12 pins TS 6); repo tree shows `specs/` and `.harness/`.
  Review items already present in the PRD before this session: D4/D5 (contiguous watermark,
  tolerance in invoice currency, snapshot cap), D6 (composite `(tenant_id, id)` key), D7
  (DLQ dedup, lease TTL, `make dlq-replay`), D9 (no broken embeds; `release-ref-mismatch`).
- Lanes 0001–0005 written with ACs copied from the PRD and proof markers per task.
- M0: lane 0001 closed — tooling, layer rules, config validation, ops port, PG18 migrations,
  compose stack (postgres, kafka, oauth, migrate, api, worker), token CLI, CI/CodeQL/Dependabot,
  glossary, ADRs 012/016/018/020. Distillate in specs/TRACKS-LOG.md.
- M1: lane 0002 closed — reserve/release/read, idempotency, JWT auth, ledger, OpenAPI; AC-01..06,
  AC-13, AC-16, AC-17 green; architect review found a missing guard test and 5 hardening items,
  all fixed; ADRs 003/004/005/006/010/011/014/015/019.
- M2: lane 0003 closed — Kafka consumer (inbox/DLQ/backoff), FX, reconciliation with the
  `reconcile_snapshot_row` staging table, simulator, seeds, `make dlq-replay`; architect review
  APPROVE with 3 MINOR + 3 NOTE, all fixed; queue m2-treasury-ingest passing.
- M3: lane 0004 merged (`worktree-agent-ae0ecf817fc70646c`) and closed — queries, outbox relay,
  jobs, outage/SIGTERM behaviour, observability; architect review CHANGES REQUIRED with 2 MAJOR
  (consumer wiring kept at merge, NFR-07 drain), fixed; all 10 mutation probes green; queue
  m3-polish passing.
- Architect review record: `.harness/4-state/architect-review-0003-0004.md`; rulings in
  DECISIONS and ADRs 007/008; DECISIONS ADR index complete for 001–021; README final.
- M4: lane 0005 closed — FR-16 gRPC adapter declined before any code (ADR 022);
  k6 load with per-phase NFR-03/NFR-04 numbers (spread: read 4.60 / reserve 13.39 / release
  16.76 ms p95 — targets met; hot-program contention documented), ZAP workflow, k8s manifests
  validated by kubeconform; architect review APPROVE with 3 MINOR + 1 NOTE, all addressed; queue
  m4-stretch passing.
- S7: pushed to <https://github.com/atamaniuc/program-capacity-service> on 2026-10-29; ci
  (verify, integration, secrets, image), codeql and ZAP baseline green on `main`. The first
  run failed the Trivy image scan on CVEs in the npm bundled with the base image; npm is now
  removed from the runtime stage, and Dependabot no longer proposes major Node.js bumps.
- Post-review DX and QA: `make install`/`make doctor` with a requirements table, FX 24 h
  freshness warning on `make seed`; `docs/qa.md` + `make qa` (every endpoint, every treasury
  message type, DB/Kafka/metric side effects). The QA pass corrected two claims in `docs/api.md`
  (natural-key replay is 200; `release-ref-mismatch` is 422).
- Branch `microservices`, lane 0006 T1: side-by-side isolation from `main` (compose project
  `program-capacity-ms`, ports +10000 from `HOST_PORT_*`, `:ms-local` image, `make isolation-live`);
  both stacks ran together and `make down` removed only the branch project.
- Branch `microservices`, lane 0006 T2: npm workspaces (`services/funding`, `services/payments-mock`
  skeletons), WS-01 architecture test, `make verify`/`make test`/CI run every workspace.
- Branch `microservices`, lane 0006 T3: `CapacityService` proto (`contracts/proto`), `buf` lint and
  breaking in `make verify`/CI, committed ts-proto stubs (capacity server, funding client) with a
  drift check, GR-01 architecture test.
- Branch `microservices`, lane 0006 T3 fix: `@bufbuild/protobuf` declared as a runtime dependency
  (root and `services/funding`, with `@grpc/grpc-js`), GR-01 dependency test for `generated/`
  imports, `buf breaking` baseline is `HEAD` locally and the PR base or push `before` in CI.
- Branch `microservices`, lane 0006 T4 (awaits architect review, not ticked): shared boundary
  `src/capacity/adapters/in/boundary/` (schemas moved from `in/http`, `JwtVerifier` and `Principal`,
  `parse`/`money`, exhaustive `PROBLEM_MAP`), HTTP adapter rewired, two depcruise rules. Also the
  GR-01 drift test no longer fails on `npm warn` stderr (own commit). T4 approved 2026-10-30; its
  review carry-overs (GR-02 allowlist, boundary allowlist rule, OpenAPI `servers` host from
  `HOST_PORT_API`) are committed.
- Branch `microservices`, lane 0006 T5 (awaits architect review, not ticked): gRPC server in
  `src/capacity/adapters/in/grpc/` (auth interceptor with default-deny scope table, ErrorInfo in
  `google.rpc.Status`, deadline check, RED metrics and spans, drain on SIGTERM), `GRPC_PORT`,
  readiness `grpc`, compose host port 127.0.0.1:60051. Tests GR-04..GR-07. Review fixes (additive
  `Release` message, early-auth and deadline tests) done, awaiting re-review.
- Branch `microservices`, flakes fixed (2026-10-30): port 0 for HTTP/ops/gRPC with `RunningApp`
  reporting the bound ports, tests build URLs from it (regression test in `ops.e2e.test.ts`);
  shutdown fault tests poll `pg_stat_activity`. `make test` green three runs in a row (each: unit 30 files / 143 tests, integration 26 files / 119 tests). Next: T6.

- AsyncAPI and contract compatibility (2026-10-29, post-lane like the Swagger UI): event
  schemas in `capacity-events.ts`, builder in `src/platform/contracts/`, `/docs/asyncapi`,
  `make events`, `make docs-events`, `npm run contracts:events` (QA-72), `make compat` (oasdiff
  + message-schema rule, CI); architect review CHANGES REQUIRED (2 MAJOR + 11 MINOR), all
  addressed; rulings in DECISIONS and ADR 015; rules for changing a contract in `docs/api.md` §8.

## Next

1. Owner review of the finished submission (M0–M4).
2. Human acts: locked-baseline, PRD Drizzle fact decision, CI remote (see open questions).

## Open questions for the human

- Set `.harness/3-environment/locked-baseline` (suggested: bootstrap commit 611505b) — a human act.
- PRD §10 dated fact is stale: `npm view drizzle version` = 1.4.0 (PRD says v1 rc, latest 0.45). PRD is frozen for agents.
- CTO questions live in PRD §14.
- Drift amounts in `ReconciliationDriftDetected` are minor units without currency (documented
  exception); unifying them is a `v2` of that event — owner's call.

_Last updated: 2026-10-30 (branch `microservices`: lane 0006 T5 approved, test flakes fixed, next T6)_
