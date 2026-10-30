# Resume point — 2026-10-30 (all agents stopped to switch to agent teams + herdr)

Each stream is a git worktree beside this one. Uncommitted work is real work in progress:
the next teammate on that stream starts by reading `git status` and `git diff` there.

| Stream | Worktree (branch) | Committed | In progress (uncommitted) | Next |
| --- | --- | --- | --- | --- |
| funding core | `finverity-microservices` (`microservices`) | T7 `4eb6f8f` (architect APPROVE), T10 merged `ad84081` | T8: `deploy/postgres/init-databases.sh`, compose, oauth config, `services/funding/src/config.ts`, migrations, `saga.ts`/`saga.test.ts` (T7 MAJOR fix: missing deadline = passed), `services/funding/contracts/openapi.yaml` (T9 start) | finish T8 (+ CHECKs per T7 review), T9, then T11–T13, T14 |
| k8s | `finverity-ms-helm` (`ms-helm`) | T15 `5206901` | T16 kind (`deploy/kind/cluster.yaml`, Makefile, isolation test), T16a gateway chart + `gateway.test.ts` | finish T16, T16a; live kind run |
| contracts | `finverity-ms-contracts` (`ms-contracts`) | — | T18 nearly done (moves into `packages/contracts`, staged renames; touches ci.yml, Dockerfile, Makefile) | finish, verify, commit, merge (conflicts expected with funding) |
| docs | `finverity-ms-docs` (`ms-docs`) | T17 English draft `9588cee` | RU docs `docs/micro-srv-*.ru.md` (local only, may be partial) | re-check against code after the saga lands |

T7 review findings still open: MAJOR missing-deadline (in progress in T8), MINOR pin
resolution `EXISTING → FAILED` test; adapter rules for T11: payments 404 on lookup → POST
again with the same key; Reserve body byte-identical across retries.
Payments mock fault markers (`FAULT-DECLINE`, `FAULT-TIMEOUT`, `FAULT-5XX-<n>`) were chosen by
T10 and must be written into spec.md with T11. T14: payments host port 13200 → 3200, ops 9466,
Dockerfile, `start` script.

`.harness/1-instructions/CONSTRAINTS.md` stays uncommitted for the owner.

## Resume with an agent team inside herdr

1. Start `herdr` in a terminal. In a pane: `cd ~/work/finverity-microservices && claude`
   (`.claude/settings.json` turns agent teams on, sets `teammateMode: auto` — in-process
   teammates unless the terminal is tmux or iTerm2 —, a 1 h teammate prompt cache, and a
   `TaskCompleted` hook that refuses completion while `harnessimo check` is red).
2. Give the lead this prompt:

   > Read specs/0006-funding-saga/RESUME.md and CLAUDE.md. You lead lane 0006 as an agent
   > team. Create the shared task list from the table above (one task per stream step, with
   > dependencies: T11 after T8+T9+T18 merged; T12 after T11; T13 after T12; T14 after T13 and
   > T10; T16a after T16; T17 recheck last). Spawn at most 3 working teammates at a time, 20 s
   > apart, each on its own worktree with absolute paths (`cd <worktree> && …`): `funding`
   > (sonnet, finverity-microservices), `k8s` (sonnet, finverity-ms-helm), `contracts`
   > (sonnet, finverity-ms-contracts). Opus only for the batched architect reviews (T8–T9,
   > T11–T13, T16a). On 429 wait 60/120/240 s and run one teammate fewer. Merge each side
   > branch into `microservices` as it goes green; never touch ~/work/finverity or `main`;
   > no push; leave CONSTRAINTS.md for the owner. Report to the owner in Russian.
