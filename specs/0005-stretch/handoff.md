# Handoff — 0005 Stretch (M4)

## Context

Optional lane after the M3 submission gate. First to be cut (bootstrap §2).

## What to load

1. `specs/0005-stretch/spec.md` and `tasks.md`.
2. `docs/PRD.md` §5 NFR-03/NFR-04 and §11 M4; ADR 022 (why FR-16 is declined).

**What NOT to load:** everything else; this lane adds delivery files and a load script only.

## Owns

- tools/load/**
- deploy/k8s/**
- .github/workflows/zap.yml

## Depends on

- polish

## State

Not started; waits on the M3 gate.

## Decisions taken

- FR-16 gRPC adapter declined (ADR 022); the lane is k6, ZAP and Kubernetes manifests.

## First step

Only if `make status` shows more than 60 minutes left after the M3 gate: write
`tools/load/scenario.js`.
