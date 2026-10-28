# Handoff — NNNN <lane name>

_Copy to `specs/NNNN-<slug>/handoff.md`. Written for a session that has none of your
context and cannot ask you a question._

## Context

Why this lane exists and what problem it is solving. Two or three sentences. If the lane
came out of an incident, a review, or a decision, link it.

## What to load

- The two or three files to read first, in order.
- **What NOT to load**, and why. This half is the one that saves a session: the next
  agent's budget goes on whatever you fail to rule out.

## Owns

The paths this lane is editing, so a second lane can see the fence: a file
(`src/a.ts`), a directory (`src/`) or a prefix (`src/**`). Nothing else — a
claim whose overlap cannot be computed protects nothing.

- <the paths this lane is editing, one per line>

Leave the list as it is when nobody else is working here. Declaring nothing is
not an error; two lanes declaring the same path is, and `harnessimo tracks`
says so.

## Depends on

The lanes this one is built on, by slug — leave it empty when it stands alone.
`harnessimo tracks` refuses a slug that names no lane and refuses a cycle, and
this lane cannot be closed while one it waits on is still open.

- <the lanes this one waits on>

## State

What is built and proven, what is written but unproven, what has not been started. Name
the test or command that proves each "done" — an unproven claim here becomes the next
session's wasted afternoon.

## Decisions taken

Choices already made that must not be relitigated, each with its reason. Also the ones
rejected, so they stay rejected.

## First step

The single next action, concrete enough to start without a decision. Not "continue the
lane" — the file path, the test name, the command.
