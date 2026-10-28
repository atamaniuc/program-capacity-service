# The harness

This folder holds everything that governs *how* work gets done here, as opposed to the work
itself. If you are new to the project, this is the shortest route to understanding how it
runs.

A harness is everything in the engineering infrastructure outside the model's weights: the
instructions it is given, the tools it can run, the environment it runs in, the state it
carries between sessions, and the checks that tell it whether it succeeded.

Without one, "done" is whatever the worker believes — and an unattended run cannot be built
on a belief. That is the problem this folder exists to solve.

```mermaid
flowchart LR
    I["<b>1 · Instructions</b><br/>the recipe shelf"] --> T["<b>2 · Tools</b><br/>the knife rack"]
    T --> E["<b>3 · Environment</b><br/>the stove"]
    E --> S["<b>4 · State</b><br/>the prep table"]
    S --> F["<b>5 · Feedback</b><br/>the quality-control window"]
    F -.->|"what the checks find<br/>becomes a new rule"| I
```

| Folder | What it holds |
|---|---|
| `1-instructions/` | The rules, and which of them a command enforces |
| `2-tools/` | What the project can run |
| `3-environment/` | What it runs in, and what is out of reach |
| `4-state/` | `PROGRESS.md`, `DECISIONS.md`, the work queue |
| `5-feedback/` | How it knows it worked |

All five are mandatory. A kitchen missing a zone is still a kitchen, and you will not cook
in it.

The entry point, `AGENTS.md`, stays in the project root because that is where every tool
looks for it. It is a router: what this project is, how to run it, how to check it, and
links here.

Unfinished work crosses sessions through `specs/TRACKS.md` and the handoffs it indexes.
State is what the harness cannot infer; a handoff is what the next session cannot
reconstruct from git in one pass.

Run `harnessimo doctor` for the honest list of what is enforced here and what is not.

---

The model comes from
[Learn Harness Engineering](https://walkinglabs.github.io/learn-harness-engineering/ru/);
the tooling is [`harnessimo`](https://github.com/atamaniuc/Harnessimo), whose
[guide](https://github.com/atamaniuc/Harnessimo/blob/main/docs/GUIDE.md) is the fastest way in.
