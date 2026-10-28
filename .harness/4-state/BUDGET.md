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

current lane: 0002-core-capacity
last green command: `npx harnessimo queue verify m0-skeleton` (make verify && npm run test:int)
exact next action: lane 0002 — write test/integration/reserve-concurrency.int.test.ts `AC-01 …`, then T1 schema migration (specs/0002-core-capacity/handoff.md "First step")
resume command: `claude` in the repo root, then `make status`
