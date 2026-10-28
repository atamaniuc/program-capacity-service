# Work tracks

Index of live tracks (handoff-driven development). One line per track: essence — handoff —
status, date, next step. Statuses: `active` / `paused` (+ why) / `blocked` (+ on what).
Closed tracks are distilled into [TRACKS-LOG.md](TRACKS-LOG.md) and their handoffs deleted.

`harnessimo tracks` verifies this file: every link must resolve and every line must carry a
status. A track line pointing at a handoff that no longer exists is a dead marker the next
session would trust.

The shape of a line, kept in a fence so it is an example rather than a track:

```
- **Retrieval quality (spec 0004)** — [handoff](specs/0004-retrieval/handoff.md) — active, next: T3 recall@5 eval on the held-out set
```

- **Stretch (M4) (spec 0005)** — [handoff](specs/0005-stretch/handoff.md) — paused (after the M3 gate; first to cut), 2026-10-28, next: k6 scenario
