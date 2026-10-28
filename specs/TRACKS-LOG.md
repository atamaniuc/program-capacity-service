# Closed tracks

Newest first. One or two sentences per track: what came out of it. Lasting decisions go to
`.harness/4-state/DECISIONS.md`, not here; git carries the rest.

Closing a track is a distillation, not an archive move: the outcome in a sentence, the
decisions where decisions live, then the handoff is deleted. A handoff kept "just in case"
is a file nobody trusts and everybody reads.

- **Skeleton (M0) (spec 0001)** — M0 skeleton green: tooling, layer rules (SK-02), config validation (SK-03), ops port (SK-04), migrations on PG18 (SK-05), compose stack + token (SK-06), CI/CodeQL/Dependabot (SK-07); glossary + ADRs 012/016/018/020. Deviations: dist copied to /app/src for #src imports; prom-client 15 deprecated but kept; JWT aud aligned to capacity-service.
