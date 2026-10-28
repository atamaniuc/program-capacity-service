# Tasks — NNNN <lane name>

_Copy to `specs/NNNN-<slug>/tasks.md`. One list, ordered by priority. P0 is what makes the
lane shippable; anything that could be dropped without breaking the deliverable is not P0._

**A checked box names the check that proves it.** `harnessimo tasks` reads this file and
fails on a tick that names nothing, because a box ticked on somebody's say-so is the
failure this whole tool exists to catch.

## P0

- [ ] T1 — <the first thing that has to be true>
- [ ] T2 — <the next one>

## P1

- [ ] T3 — <valuable, not blocking>

## Notes

A ticked box carries its evidence inline: after the task text, a proof marker naming the
test, the eval case or the query that proves it — `test/<file>.test.ts#<the test name>`,
wrapped in the marker comment.

That marker is what makes the tick checkable. Without one the gate rejects it, which is the
point: the difference between "done" and "claimed done" is whether something other than the
author agrees.

(This paragraph describes the syntax rather than showing a ticked example, because the gate
reads this file too — and a template that fails the rule it teaches is a template nobody
should trust.)
