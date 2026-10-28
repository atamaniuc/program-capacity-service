# PROGRESS

State carried between sessions. Read this first; update it before you stop.

## Now

Lane 0001 (skeleton, M0). Harness, PRD edits and all lane specs are written; the Node
project, compose stack and CI are next. Nothing is waiting on a human.

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

## Next

1. 0001 T1–T8 (skeleton) → lane gate → commit.
2. 0002 core capacity (M1), AC-01 first.
3. 0003 and 0004 in parallel once 0002's domain and ports exist (Owns do not overlap).

## Open questions for the human

- None blocking. The CTO questions live in PRD §14.

_Last updated: 2026-10-28_
