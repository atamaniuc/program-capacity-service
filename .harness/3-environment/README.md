# Environment — what this project runs in

Reproducibility, so that "works here" and "works anywhere" are the same statement.

- **Runtime version** — pinned in a file CI reads too, so CI and a laptop cannot silently
  diverge.
- **Dependencies** — pinned in a lockfile. Installs are exact rather than approximately
  right.
- **Services** — list what must be running, or state plainly that there are none. The
  cold-start test is only meaningful when this is honest.

## locked-baseline

Records the commit from which the locked-surface rule applies.

Some files define what counts as success: the scoring code, the acceptance rules, the CI
workflow. A system that improves itself will, given the opportunity, improve its own score
instead of its own work. So those files are placed out of reach, and `harnessimo locked`
enforces it.

The baseline exists because the commit that *creates* a protected file necessarily touches
it. Moving the baseline forward widens what the system may change, which is a decision a
person makes.
