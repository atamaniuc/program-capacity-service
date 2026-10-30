# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- Main session: planning, orchestration, gate verdicts. Code goes to the `implementer`
  subagent, one lane at a time; recon goes to `scout`; specs, ADRs and any diff touching
  concurrency, money, rounding, reconciliation or idempotency go to `architect` with a
  fresh context.
- The Task tool is the only delegation path. An implementer never spawns another implementer.
- Hooks in `.claude/settings.json`: `SessionStart` runs `npx harnessimo brief`; `Stop` and
  `SubagentStop` run `npx harnessimo check`.
- Memory lives in `.harness/4-state/` (PROGRESS, DECISIONS, the BUDGET time log) and the lane
  handoff, never in chat. Update PROGRESS.md after every task batch; log each gate in BUDGET.md.
- Repository artifacts are in English. Reports to the owner are in Russian.

## Delivery on branch `microservices` (owner ruling 2026-10-30)

- Independent task streams run in parallel worktrees (`tools/worktree.sh add <name>`), each
  with its own implementer; the main worktree owns `handoff.md` and PROGRESS.md, side
  branches merge back with `tools/worktree.sh merge <name>`.
- An implementer may chain several tasks of one stream. `[review]` tasks get one batched
  architect review per stream instead of a stop after each; the gate is still that review.
- The orchestrator never idles: on an agent's completion notice it merges, then launches the
  next stream or review in the same turn.
- Tests stay green and checks are never bypassed; speed comes from parallelism, not shortcuts.
