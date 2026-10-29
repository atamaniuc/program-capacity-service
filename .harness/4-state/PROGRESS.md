# PROGRESS

State carried between sessions. Read this first; update it before you stop.

## Now

All five lanes are closed and all queue gates pass. A post-submission review of lanes
0003–0005 found 1 BLOCKER and 5 MAJOR items; all are fixed,
re-reviewed (APPROVE) and recorded in DECISIONS. Docs were rewritten for human readers
(`docs/README.md`), the gRPC adapter was declined (ADR 022), `/docs` became an interactive
Swagger UI, and the k6 numbers were re-measured with a warm-up. Last full run: 95 unit + 100
integration tests green. `make install` sets up a fresh clone in one command (~3 min);
`make qa` runs the [QA test cases](../../docs/qa.md) on the live stack: 98/98 on 2026-10-29.

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

## Next

1. Owner review of the finished submission (M0–M4).
2. Human acts: locked-baseline, PRD Drizzle fact decision, CI remote (see open questions).

## Open questions for the human

- Set `.harness/3-environment/locked-baseline` (suggested: bootstrap commit 611505b) — a human act.
- PRD §10 dated fact is stale: `npm view drizzle version` = 1.4.0 (PRD says v1 rc, latest 0.45). PRD is frozen for agents.
- CTO questions live in PRD §14.

_Last updated: 2026-10-29 (branch `microservices`: lane 0006 T1 done)_
