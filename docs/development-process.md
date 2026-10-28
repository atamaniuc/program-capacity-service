# How this repository was built

The service was built with AI coding agents working under a written process. That process
left files in the repository. **None of them is needed to understand or run the service.** If
you came to read the code, skip this page and the folders it describes.

## The folders you can ignore

| Path | What it is |
| --- | --- |
| `AGENTS.md`, `CLAUDE.md` | Short instructions an AI agent reads at the start of a session: where things are, how to check work, rules that must not be broken |
| `.claude/agents/` | Role definitions for the agents: `architect` (specs, reviews of money and concurrency code), `implementer` (writes code for one work lane), `scout` (read-only lookups) |
| `.harness/` | The rules and the state carried between sessions (see below) |
| `specs/` | The work, split into five **lanes** (0001 to 0005), each with a spec, a task list and, while open, a handoff note |
| `harnessimo.config.json` | Configuration of [harnessimo](https://www.npmjs.com/package/harnessimo), the checker that enforces the process |
| `.githooks/pre-commit` | Runs `npx harnessimo check` before every commit |
| `tools/status.sh` (`make status`) | Prints the checker result, time used and the last commits |

## The process in five steps

1. **Requirements first.** [PRD.md](PRD.md) turns the one-page assignment into numbered
   requirements: functional (FR), non-functional (NFR), acceptance criteria (AC) and
   invariants (I1–I8). It also fixes the tech stack and what is out of scope.
2. **Work split into lanes**, each one a milestone:

   | Lane | Milestone | Content |
   | --- | --- | --- |
   | `specs/0001-skeleton` | M0 | Tooling, layer rules, config, health, migrations, compose, CI |
   | `specs/0002-core-capacity` | M1 | Reserve, release, read, idempotency, auth, ledger, OpenAPI |
   | `specs/0003-treasury-ingest` | M2 | Kafka consumer, FX, reconciliation, simulator, seeds |
   | `specs/0004-polish` | M3 | Queries, outbox relay, jobs, shutdown, observability, runbook |
   | `specs/0005-stretch` | M4 | k6 load test, ZAP workflow, Kubernetes manifests |

3. **Every acceptance criterion has a test with its id in the name**, for example
   `AC-01 exactly 10 of 50 concurrent reservations succeed`. Searching the test folder for
   an AC id finds its proof.
4. **Claims must point at evidence.** Documents carry invisible HTML comments such as
   `<!-- proof: test/e2e/auth.e2e.test.ts#AC-13 -->`. `harnessimo check` fails the commit if
   the file or the test name does not exist. A ticked task without a resolving proof also
   fails.
5. **Independent review before each milestone.** Code touching money, rounding,
   concurrency, idempotency or reconciliation was reviewed by a separate `architect` agent with
   a fresh context. Findings and rulings are recorded in the ADRs and in
   `.harness/4-state/DECISIONS.md`; full review notes are in
   `.harness/4-state/architect-review-*.md`.

## What is in `.harness/`

| File | Purpose |
| --- | --- |
| `1-instructions/CONSTRAINTS.md` | 15 hard rules, each with the command that enforces it |
| `1-instructions/definition-of-ready.md`, `definition-of-done.md` | When a task may start, when it counts as done |
| `4-state/PROGRESS.md` | Where the work stands |
| `4-state/DECISIONS.md` | Index of ADRs plus dated rulings |
| `4-state/BUDGET.md` | Time log: when each milestone gate passed (optional) |
| `4-state/feature_list.json` | One gate per milestone; it moves to "passing" only through `npx harnessimo queue verify`, which runs `make verify && make test` |

## Time tracking (optional)

Each milestone gate is logged with a timestamp in `.harness/4-state/BUDGET.md`. A cut order
said what to drop first if time ran short: M4 stretch → OpenTelemetry profile → invariant job
→ list endpoints → outbox relay. Nothing on that list had to be cut.
