# PROGRESS

State carried between sessions. Read this first; update it before you stop.

## Now

Lanes 0003 (treasury ingest) and 0004 (polish) in parallel. M1 closed at 70 minutes. Nothing is waiting on a human
except the locked-baseline commit (below).

## Done

- Repository initialised; harnessimo 0.10.1 adopted from npm (no divergence from upstream templates).
- PRD edits per bootstrap §5 / review §7: FR-16 renamed "gRPC adapter (P2)"; Evolution
  section gains split preconditions and when Pact or a schema registry appear; cut order recorded in §11; OpenAPI-from-zod and `/docs` placement in §10; dated facts
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

## Next

1. 0003 and 0004 in parallel; architect review of each before its gate.
2. M3 gate: S1–S8, README, dated facts; then 0005 only if > 60 min left.

## Open questions for the human

- Set `.harness/3-environment/locked-baseline` (suggested: bootstrap commit 611505b) — a human act.
- CTO questions live in PRD §14.

_Last updated: 2026-10-28_
