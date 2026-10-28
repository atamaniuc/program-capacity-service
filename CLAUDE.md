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
