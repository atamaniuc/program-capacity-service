# DECISIONS

What was decided, why, and what was rejected. Append; do not rewrite history. Full ADRs
(MADR, one short file each) live in `docs/adr/NNN-slug.md`; this file is their index plus
decisions about how the work is run.

## ADR index (PRD §14)

| ADR | Decision | File |
| --- | --- | --- |
| 001 | Modular monolith with `api` and `worker` roles | planned (0004) |
| 002 | PostgreSQL as the single source of truth; no Redis | planned (0004) |
| 003 | Concurrency: READ COMMITTED, program row lock, fixed lock order | [003-concurrency-lock-order](../../docs/adr/003-concurrency-lock-order.md) |
| 004 | Money as `bigint` minor units with ISO 4217 scales | [004-money-minor-units](../../docs/adr/004-money-minor-units.md) |
| 005 | FX: treasury-fed rates, stored per reservation, round up, max age | [005-fx-rates](../../docs/adr/005-fx-rates.md) |
| 006 | Idempotency: `Idempotency-Key` in the same transaction, stored business outcomes, natural keys, `release_ref` fingerprint | [006-idempotency](../../docs/adr/006-idempotency.md) |
| 007 | Kafka consumer semantics: client choice, commit after DB, inbox, ordering, DLQ and replay | planned (0003) |
| 008 | Reconciliation: contiguous watermark, tolerance, staged diff, HOLD default | planned (0003) |
| 009 | Transactional outbox with a single relay under a TTL lease with epoch fencing | planned (0004) |
| 010 | Append-only ledger plus projection instead of event sourcing | [010-ledger-projection](../../docs/adr/010-ledger-projection.md) |
| 011 | AuthN and AuthZ: JWKS, scopes, tenant-scoped keys, internal ops port | [011-auth](../../docs/adr/011-auth.md) |
| 012 | Data access with Kysely and SQL migrations | [012-kysely-sql-migrations](../../docs/adr/012-kysely-sql-migrations.md) |
| 013 | OpenTelemetry instead of `@nestjs/observe` | planned (0004) |
| 014 | API conventions: `/v1`, problem types, cursor pagination, `ETag` | [014-api-conventions](../../docs/adr/014-api-conventions.md) |
| 015 | Contracts and compatibility: zod to OpenAPI, AsyncAPI, `oasdiff`; no Pact until the first split | [015-contracts](../../docs/adr/015-contracts.md) |
| 016 | Testing strategy: Testcontainers, property tests, AC-named tests | [016-testing-strategy](../../docs/adr/016-testing-strategy.md) |
| 017 | Out of scope and why: GraphQL, gateway, event sourcing, Saga, CDC, Kubernetes, AWS emulation | planned (0004) |
| 018 | Architecture: hexagonal, vertical slices, tactical DDD; no monorepo tooling | [018-hexagonal-architecture](../../docs/adr/018-hexagonal-architecture.md) |
| 019 | Aggregate design: `Program` root, reservations loaded one at a time | [019-aggregate-design](../../docs/adr/019-aggregate-design.md) |
| 020 | Ubiquitous language and naming rules | [020-ubiquitous-language](../../docs/adr/020-ubiquitous-language.md) |
| 021 | Evolution path: split triggers T1–T4 and the order of the split | planned (0004) |

---

## 2026-10-28 — Adopted harnessimo as a dependency

`harnessimo` 0.10.1 from npm provides the gates; `harnessimo.config.json` says which apply.

**Why:** the build brief mandates it; a copied script is a fork the day after.

**Rejected:** cloning the repo and copying templates — only the fallback if npm is unreachable. It was reachable.

---

## 2026-10-28 — Settled before the build (bootstrap §1, not to be relitigated)

Modular monolith; PostgreSQL single source of truth; no Redis, event sourcing, Saga,
GraphQL or CQRS read store; gRPC only as a P2 driving adapter; no Pact (OpenAPI + `oasdiff`
+ JSON Schema/AsyncAPI); OpenAPI generated from zod with `zod-openapi`, `/docs` dev/ops only,
no `@nestjs/swagger`; no `SELECT … FOR UPDATE` on the idempotency path (review D3 closed);
Given/When/Then in specs and test names, no Gherkin runtime.

**Why:** PRD §7, §10 and review §3; D3 verified on PostgreSQL 16.

---

## 2026-10-28 — TypeScript 6, not 7

`typescript` 7.0.2 is `latest`, but `@nestjs/cli` 12.0.11 pins `typescript ~6.0.2`.

**Why:** the PRD's "default toolchain" rule; TS 7's native compiler is a separate migration.

**Rejected:** TS 7 now — unknown decorator-metadata support under Nest's build.

---

## 2026-10-28 — Architect review of lane 0002: rulings

The architect reviewed f875699 cold (verdict CHANGES REQUIRED: 1 major, 5 minor), and the
findings were fixed in 5d5b03c. The rulings below are durable; the full reasoning is in the
ADRs.

- **`release_ref` FK is `DEFERRABLE INITIALLY DEFERRED`** ([ADR 003](../../docs/adr/003-concurrency-lock-order.md)).
  An immediate check took `KEY SHARE` on the reservation before the program lock, which made
  two releases of one reservation deadlock. Made immediate again in a probe: `deadlock
  detected`, 2 of 2 runs. **Rule for lanes 0003+:** dedup row, then program, then
  reservations. Any new FK from a dedup table to `reservation` or `program` is deferred.
- **404 under an `Idempotency-Key` is stored** ([ADR 006](../../docs/adr/006-idempotency.md)).
  The key is taken before the lookup (PRD §8), so 404 is a business outcome (A13).
  Rejected: a special case that would make one key answer 404 first and 201 later.
- **Validation errors never take the key, even those that need the database** (ADR 006). The
  release currency is checked with a plain read before the claim; the invoice currency
  never changes.
- **Amounts above 2^63 − 1 minor units are 400, not 500** ([ADR 004](../../docs/adr/004-money-minor-units.md)).
  A request that can never succeed must not say "retry later".
- **Token before body parser; JWKS outage 503; scope default-deny** ([ADR 011](../../docs/adr/011-auth.md)).
  S6 is meant literally: no business endpoint answers anything but 401 without a valid token.
- **Every money/concurrency guard has a test that fails when the guard is removed**
  ([ADR 016](../../docs/adr/016-testing-strategy.md)). With the I2 `WHERE` guard deleted, the
  suite stayed green, so `program-guard.int.test.ts` tests it at the repository.

**Why recorded here:** lanes 0003 and 0004 add writers (treasury consumer, reconciliation,
relay). They must follow the same lock order and idempotency rules without re-reading the
review.
