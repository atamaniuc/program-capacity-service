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

## Resume with independent agents, one herdr pane each (2026-10-30, supersedes the team prompt)

The agent team was started and paused within minutes: no commits; its edits are uncommitted in
each worktree. A kind cluster `finverity-ms` is running. The coordinator pane (`claude` in this
worktree) opens the panes and starts the agents itself with `herdr agent start` and
`herdr agent prompt`; the owner does not copy prompts. Side worktrees branch off before this file
existed, so every prompt is self-contained and names this file by absolute path.

Common rules (inlined in every prompt): absolute paths, work only in your own worktree; no push;
never touch `~/work/finverity` or `main`; never stage `.harness/1-instructions/CONSTRAINTS.md`;
commit per task only after `make verify`, `make test` and `npx harnessimo check` are green, the
message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; blocked more than
three attempts → write it in the worktree's handoff.md and stop; report to the owner in Russian.

| Agent | Worktree (branch) | Task |
| --- | --- | --- |
| `funding` | `~/work/finverity-microservices` (`microservices`) | T7 review findings (missing deadline = passed; `EXISTING → FAILED` test), T8 (FS-14), T9 (FS-02); then architect review of T8–T9 |
| `k8s` | `~/work/finverity-ms-helm` (`ms-helm`) | tick T15, T16 (K8-04), T16a (GW-05), live `make kind-up kind-smoke` |
| `contracts` | `~/work/finverity-ms-contracts` (`ms-contracts`) | T18 (CT-01, CT-04), `docker build` |

Merges into `microservices` belong to the coordinator: `ms-contracts` after T8+T9 (conflict in
`services/funding/package.json`), `ms-helm` after its architect review of T16a. Then T11 → T12 →
T13 → T14 in `funding`; T17 recheck in `~/work/finverity-ms-docs` last.

## Finish plan after the quota reset (written 2026-10-30 16:30, quota at 90 %+)

State at 16:30: `funding` (T7+T8, T9), `k8s` (T16, T16a) and `contracts` (T18) had `make verify`
green and were waiting for their own `make test` before committing; nothing committed yet.
`disk` (cleanup, 22 GB free now) and `harnessimo` (0.13.0 = `ccd297b`, unpushed, unreviewed) are
not finverity work: leave them until finverity is done.

Order, no detours:
1. Each lane agent: if its work is uncommitted, run `make test` once, then commit. Run `make test`
   in one worktree at a time (three parallel Testcontainers runs caused timeouts).
2. Coordinator merges into `microservices`: funding commits are already there; then `ms-contracts`
   (resolve `services/funding/package.json`), then `ms-helm`. One `make verify` after each merge.
3. One architect review (opus) for T8–T9 + T18, one for T16a. Apply findings in the same lane,
   no second review unless a BLOCKER.
4. `funding`: T11 → T12 → T13 → T14, one batched architect review for T11–T13.
5. T17 docs recheck in `~/work/finverity-ms-docs`, merge, final `make verify` + `make test`.

Harness friction to avoid: gates run only at commit and merge, not after every edit; no re-reading
of rules mid-task; no `/model` or `/effort` in a running agent (launch with
`-- --model sonnet --effort high`); at most 4 panes per herdr tab; the coordinator does herdr routine
itself and never asks the owner about routine.

## CI for k8s and the push (owner ruling 2026-10-30 22:00)

T23 (CI: `make helm-check`, funding and payments-mock image builds, a `kind` job with
`helm/kind-action` running `make kind-up kind-smoke` on push to `microservices`) moves into the
current batch, done by `k8s` after the live kind run. Branch `microservices` is pushed to
`origin` once, at the end, after T17 (no force push); the coordinator then watches CI and fixes red
until it is green.
