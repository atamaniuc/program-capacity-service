# BUDGET — time log

started_at: 2026-10-28T13:58:38Z

Optional reading: when each milestone gate passed, in minutes since the start.
`make status` prints the last row. Cut order if time runs short: M4 (k6, ZAP,
k8s) → OTel profile → invariant job (FR-15) → list endpoints (FR-12) → outbox relay (FR-13).

| timestamp (UTC) | phase/task | minutes since start |
| --- | --- | --- |
| 2026-10-28T13:58Z | start: read PRD, review, bootstrap | 0 |
| 2026-10-28T14:08Z | bootstrap gate: git init, harnessimo, PRD edits (FR-16, Evolution, budget, contracts, dated facts), harness files, lanes 0001–0005; commit 611505b | 10 |
| 2026-10-28T14:27Z | M0 gate: lane 0001 closed (make verify, test:int 5/5, make up healthy, make token); JWT aud aligned to PRD; queue m0-skeleton passing | 28 |
| 2026-10-28T15:09Z | M1 gate: lane 0002 closed after architect review (1 MAJOR + 5 MINOR fixed; guard mutation-proven); queue m1 passing; Kafka/OTel deps pre-installed | 70 |
| 2026-10-28T15:43Z | pause: agent usage limit reached. Lane 0003 WIP committed unreviewed; lane 0004 done on branch worktree-agent-ae0ecf817fc70646c (unmerged, review interrupted) | 104 |
| 2026-10-28T17:46Z | M2 gate: lane 0003 closed after architect review (APPROVE; 3 MINOR + 3 NOTE fixed, staging table, AC-16 tenant check); queue m2-treasury-ingest passing | 228 |
| 2026-10-28T17:53Z | M3 gate: lane 0004 merged and closed (2 MAJOR fixed: consumer wiring kept, NFR-07 drain; all 10 mutation probes green); queue m3-polish passing; README/DECISIONS final | 235 |
| 2026-10-28T18:57Z | M4 gate: lane 0005 closed after architect review (APPROVE; 3 MINOR + 1 NOTE addressed); queue m4-stretch passing; k6 load, ZAP workflow, k8s manifests delivered (FR-16 gRPC declined, ADR 022). | 299 |
| 2026-10-29T13:05Z | post-lane gate: AsyncAPI for outbound events and DLQs, `/docs/asyncapi`, contract compatibility check in CI; architect review CHANGES REQUIRED (2 MAJOR + 11 MINOR) addressed; make verify, make test (106 unit + 102 int), make qa 103/103, make compat green | 1387 |

current lane: none — all five lanes closed; queue items m0, m1, m2, m3, m4 all passing
last green command: `make verify && make test` (106 unit + 102 int tests), `make qa` 103/103, `make compat BASE=HEAD`, `npx harnessimo check`; CI on GitHub green for efa1d4f (this change is not pushed yet)
exact next action: submission complete — owner review. Human acts remain: set `.harness/3-environment/locked-baseline` (suggested 611505b); decide the PRD §10 Drizzle fact (`npm view drizzle version` = 1.4.0, PRD says rc/0.45); CI runs on GitHub (S7 green since 2026-10-29).
resume command: `claude` in the repo root, then "continue from .harness/4-state/BUDGET.md exact next action"
