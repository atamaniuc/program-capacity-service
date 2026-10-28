# Closed tracks

Newest first. One or two sentences per track: what came out of it. Lasting decisions go to
`.harness/4-state/DECISIONS.md`, not here; git carries the rest.

Closing a track is a distillation, not an archive move: the outcome in a sentence, the
decisions where decisions live, then the handoff is deleted. A handoff kept "just in case"
is a file nobody trusts and everybody reads.

- **Stretch (M4) (spec 0005)** — M4 gate passed: k6 load (NFR-03 met spread, NFR-04 hot documented), ZAP workflow, k8s manifests validated by kubeconform; FR-16 gRPC declined (ADR 022); architect review APPROVE (3 MINOR + 1 NOTE addressed)

- **Production polish (M3) (spec 0004)** — M3 gate passed: production polish closed after architect review (2 MAJOR fixed at merge, all 10 mutation probes green)

- **Treasury ingest (M2) (spec 0003)** — M2 gate passed: treasury ingest closed after architect review (APPROVE, 3 MINOR + 3 NOTE fixed)

- **Core capacity (M1) (spec 0002)** — M1 green (f10d012 + review fixes): schema with DEFERRABLE release FK (prevents release/release deadlock), Money/FX bigint domain, reserve/release with Idempotency-Key (no FOR UPDATE), stored business rejections incl. 404, release_ref fingerprint, JWT pre-parser middleware (S6) + scope guard default-deny, JWKS outage → 503, OpenAPI from zod + contracts:check. AC-01..06, AC-13, AC-16, AC-17, NFR-09, FR-01, I2 guard (mutation-proven). Architect review: CHANGES REQUIRED → all 6 findings fixed. Rule for new writers: claim dedup row, then program FOR UPDATE, then reservation.

- **Skeleton (M0) (spec 0001)** — M0 skeleton green: tooling, layer rules (SK-02), config validation (SK-03), ops port (SK-04), migrations on PG18 (SK-05), compose stack + token (SK-06), CI/CodeQL/Dependabot (SK-07); glossary + ADRs 012/016/018/020. Deviations: dist copied to /app/src for #src imports; prom-client 15 deprecated but kept; JWT aud aligned to capacity-service.
