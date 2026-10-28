# Definition of Ready

Checked when an item is started, not when it is finished. The expensive failure is
starting work whose success cannot be decided, because it is discovered only at the end,
when the work is already done and unfalsifiable.

The machine-decidable parts are enforced by `harnessimo queue activate`. The rest is
judgement, written down here because judgement that is written down is at least
reviewable.

**The behaviour is an outcome, not an activity.** "The validator rejects a question with
fewer than two answer bullets" can be checked. "Add validation" is complete when you stop
typing. _Enforced._

**A verification command exists and can fail.** If nothing can fail, nothing can be
confirmed, and the item will be closed on an opinion. _Enforced._

**The kind is set.** Different kinds of work close by different rules; conflating them is
how unverified work ships. _Enforced._

**Dependencies have reached a terminal state.** Building on an unfinished dependency
produces work that gets redone when it lands. _Enforced._

**The scope is settled.** No `TODO` left in the behaviour. _Enforced._

**It fits in one session.** Not machine-checkable, so it is a judgement call: if you
cannot see the end of it, split it. An item that spans sessions loses its context between
them, and that is exactly what the harness exists to prevent — a handoff is the fallback,
not the plan.
