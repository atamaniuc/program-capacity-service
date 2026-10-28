# Definition of Done

Referenced, never copied: a spec or task list that restates it is wrong, because the copy
is what goes stale.

**The verification command passed.** _Enforced._

**Evidence is recorded.** The command's output is stored against the item, because CI
re-runs every passing claim and a claim with no output cannot be re-checked. _Enforced._

**No placeholders.** No `TODO`, `FIXME`, `test.skip`, `test.only`, no empty branch left
as an exercise.

**A negative test exists where a rule was added.** A validation rule with no failing test
is an assumption, not a rule.

**Documentation follows a changed contract.** If the item changed a schema, a command, or
a promise the product makes, the document that states it changed in the same commit — and
its proof marker resolves. _Enforced by `harnessimo proof`._

**Checked boxes name their check.** A ticked task in a live lane carries a proof marker.
_Enforced by `harnessimo tasks`._

**Locked surfaces untouched.** _Enforced by `harnessimo locked` in CI._

## What is deliberately not here

**Coverage thresholds.** They measure lines executed, not behaviour verified, and a team
that has to hit one writes tests for the easy paths.

**Estimates.** Work in progress is capped at one item; how long it takes is information,
not a commitment.
