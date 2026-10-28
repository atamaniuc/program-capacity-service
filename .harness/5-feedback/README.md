# Feedback — how this project knows it worked

Checks live next to the code they check; this file maps them. A rule kept far from what it
governs goes stale without anyone noticing.

## One command

```
harnessimo check
```

Everything the harness gates runs from it, and it is what CI runs. Add the project's own
gate — types, tests, whatever proves the code correct — next to it, and make the pair the
only thing anyone has to remember.

## Levels

Skipping any of them means not finished.

**1. Types and schemas.** The fastest feedback, and the only one that runs on every save.

**2. Tests, especially negative ones.** Every rule has a test proving it actually fails on
bad input. A rule with no failing test is an assumption wearing a rule's clothes.

**3. End to end.** `harnessimo cold-start` clones the project into an empty folder and runs
it using only what is in the repository. It catches the class of problem the first two are
blind to: something that works only because of state on this machine.

## Re-checking claims

```
harnessimo check --reverify
```

Re-runs every finished item's own check. An item marked finished by hand, without the
check ever passing, fails here. Run it in CI, so the claim is not taken on trust.

## Failure messages

Failures are written to be acted on, not just read: what failed, why it matters, what to
do. The next person to see one is often a fresh session with no memory of the design, and
"invalid" leaves them guessing.
