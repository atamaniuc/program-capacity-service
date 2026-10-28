# Handoff — 0005 Stretch (M4)

## Context

Optional lane after the M3 submission gate. First to be cut (bootstrap §2).

## What to load

1. `specs/0005-stretch/spec.md` and `tasks.md`.
2. `docs/PRD.md` FR-16 and §7 "Evolution".

**What NOT to load:** everything else; this lane adds adapters and delivery files only.

## Owns

- src/capacity/adapters/in/grpc/**
- contracts/capacity.v1.proto
- tools/load/**
- deploy/k8s/**
- .github/workflows/zap.yml
- test/e2e/grpc.e2e.test.ts

## Depends on

- polish

## State

Not started; waits on the M3 gate.

## Decisions taken

- gRPC is a driving adapter over the same use cases, never a transport between modules.

## First step

Only if `make status` shows more than 60 minutes left after the M3 gate: write
`contracts/capacity.v1.proto`.
