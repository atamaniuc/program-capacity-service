# NNNN — <lane name>

**Status:** proposed | in progress | shipped · **Owner:** <name or unassigned>

## Why

The problem, and the evidence it is real. A spec that opens with a solution is a spec
nobody can argue with.

## User stories

**US-01** — As a <role>, I want <capability>, so that <outcome>.

## Acceptance criteria

Every criterion names an executable check — a test name, an eval case id, a query. A
criterion that cannot run does not exist.

**AC-01** — GIVEN <state> WHEN <action> THEN <observable outcome>
<!-- proof: test/<file>.spec.ts#<the test name> -->

## Invariants

What must stay true while this lane is worked, including things it must not break.

## Out of scope

The boundary. A spec with no stated boundary is a spec that grows mid-lane. Name any
dependency on another lane's undelivered work here rather than discovering it later.

## Tasks

See `tasks.md`. A checked box carries the marker that proves it (`harnessimo tasks`).
