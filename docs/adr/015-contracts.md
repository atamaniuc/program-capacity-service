# 015. Contracts generated from zod

- Status: accepted
- Date: 2026-10-28

## Context

Validation and documentation drift when written twice.

## Decision

zod 4 schemas in `src/capacity/adapters/in/http/schemas.ts` validate requests and describe
responses. `zod-openapi` builds OpenAPI 3.1 from them (`npm run contracts` writes
`contracts/openapi.yaml`). `npm run contracts:check` regenerates in memory and exits 1 on drift.
`test/e2e/contract.e2e.test.ts` validates real responses against the generated component
schemas with ajv. The document is served as `/docs` and `/docs/openapi.json` on the ops port
only. No `@nestjs/swagger`, no class-validator.

## Consequences

- The committed YAML is reviewable in diffs; breaking changes show up as diff lines (NFR-14).
- The file is generated, so Prettier ignores `contracts/`.

## Alternatives rejected

Hand-written YAML (drift), decorators on classes (second schema language), Pact (settled).
