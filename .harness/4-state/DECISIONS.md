# DECISIONS

What was decided, why, and what was rejected. Append; do not rewrite history. Full ADRs
(MADR, one short file each) live in `docs/adr/NNN-slug.md`; this file is their index plus
decisions about how the work is run.

## ADR index (PRD §14)

| ADR | Decision | File |
| --- | --- | --- |
| 001 | Modular monolith with `api` and `worker` roles | [001-modular-monolith-roles](../../docs/adr/001-modular-monolith-roles.md) |
| 002 | PostgreSQL as the single source of truth; no Redis | [002-postgres-source-of-truth](../../docs/adr/002-postgres-source-of-truth.md) |
| 003 | Concurrency: READ COMMITTED, program row lock, fixed lock order | [003-concurrency-lock-order](../../docs/adr/003-concurrency-lock-order.md) |
| 004 | Money as `bigint` minor units with ISO 4217 scales | [004-money-minor-units](../../docs/adr/004-money-minor-units.md) |
| 005 | FX: treasury-fed rates, stored per reservation, round up, max age | [005-fx-rates](../../docs/adr/005-fx-rates.md) |
| 006 | Idempotency: `Idempotency-Key` in the same transaction, stored business outcomes, natural keys, `release_ref` fingerprint | [006-idempotency](../../docs/adr/006-idempotency.md) |
| 007 | Kafka consumer semantics: client choice, commit after DB, inbox, ordering, DLQ and replay | [007-kafka-consumer-semantics](../../docs/adr/007-kafka-consumer-semantics.md) |
| 008 | Reconciliation: contiguous watermark, tolerance, staged diff, HOLD default | [008-reconciliation](../../docs/adr/008-reconciliation.md) |
| 009 | Transactional outbox with a single relay under a TTL lease with epoch fencing | [009-outbox-relay-lease](../../docs/adr/009-outbox-relay-lease.md) |
| 010 | Append-only ledger plus projection instead of event sourcing | [010-ledger-projection](../../docs/adr/010-ledger-projection.md) |
| 011 | AuthN and AuthZ: JWKS, scopes, tenant-scoped keys, internal ops port | [011-auth](../../docs/adr/011-auth.md) |
| 012 | Data access with Kysely and SQL migrations | [012-kysely-sql-migrations](../../docs/adr/012-kysely-sql-migrations.md) |
| 013 | OpenTelemetry instead of `@nestjs/observe` | [013-opentelemetry](../../docs/adr/013-opentelemetry.md) |
| 014 | API conventions: `/v1`, problem types, cursor pagination, `ETag` | [014-api-conventions](../../docs/adr/014-api-conventions.md) |
| 015 | Contracts and compatibility: zod to OpenAPI, AsyncAPI, `oasdiff`; no Pact until the first split | [015-contracts](../../docs/adr/015-contracts.md) |
| 016 | Testing strategy: Testcontainers, property tests, AC-named tests | [016-testing-strategy](../../docs/adr/016-testing-strategy.md) |
| 017 | Out of scope and why: GraphQL, gateway, event sourcing, Saga, CDC, Kubernetes, AWS emulation | [017-out-of-scope](../../docs/adr/017-out-of-scope.md) |
| 018 | Architecture: hexagonal, vertical slices, tactical DDD; no monorepo tooling | [018-hexagonal-architecture](../../docs/adr/018-hexagonal-architecture.md) |
| 019 | Aggregate design: `Program` root, reservations loaded one at a time | [019-aggregate-design](../../docs/adr/019-aggregate-design.md) |
| 020 | Ubiquitous language and naming rules | [020-ubiquitous-language](../../docs/adr/020-ubiquitous-language.md) |
| 021 | Evolution path: split triggers T1–T4 and the order of the split | [021-evolution-path](../../docs/adr/021-evolution-path.md) |
| 022 | No gRPC adapter: FR-16 declined, revisit triggers | [022-no-grpc-adapter](../../docs/adr/022-no-grpc-adapter.md) |

---

## 2026-10-28 — Adopted harnessimo as a dependency

`harnessimo` 0.10.1 from npm provides the gates; `harnessimo.config.json` says which apply.

**Why:** the build brief mandates it; a copied script is a fork the day after.

**Rejected:** cloning the repo and copying templates — only the fallback if npm is unreachable. It was reachable.

---

## 2026-10-28 — Settled before the build (bootstrap §1, not to be relitigated)

Modular monolith; PostgreSQL single source of truth; no Redis, event sourcing, Saga,
GraphQL or CQRS read store; no gRPC adapter (ADR 022); no Pact (OpenAPI + `oasdiff`
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

The architect reviewed f10d012 cold (verdict CHANGES REQUIRED: 1 major, 5 minor), and the
findings were fixed in b638a54. The rulings below are durable; the full reasoning is in the
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

---

## 2026-10-28 — Architect review of lanes 0003/0004: rulings

The architect reviewed 0003 cold before its fixes (they landed in 0a0961e) (APPROVE: 3 MINOR, 3 NOTE) and 0004 on branch
`worktree-agent-ae0ecf817fc70646c` at 4eda209 (CHANGES REQUIRED: 2 MAJOR, 3 NOTE). Every
MAJOR and MINOR was fixed before the M2/M3 gates; the full reasoning is in
`.harness/4-state/architect-review-0003-0004.md`.

- **Tenant ownership on the Kafka create path** (ADR 007): a `ProgramLimitSet` whose
  programId exists under another tenant is rejected to the DLQ, never creates a parallel
  program row.
- **Reconciliation stages the snapshot** (ADR 008): rows land in `reconcile_snapshot_row`,
  the diff is computed outside the program lock with set-based SQL, and the version is
  re-checked under the lock.
- **Stale snapshots skip before semantic validation** (ADR 008): a stale snapshot is never
  parked; the size cap stays first as a resource guard.
- **The worker role runs consumer and relay together** (ADR 007/009): the 0004 merge kept
  `createTreasuryConsumer` beside `startWorkerComponents`; shutdown order is consumer →
  relay/jobs → pool. A role-all Kafka test fails if a future merge drops the consumer.
- **Consumer stop drains in-flight messages** (ADR 007): `TreasuryConsumerRunner.stop()`
  waits up to 25 s for the in-flight record to commit its offset before disconnecting.

---

## 2026-10-28 — FR-16 gRPC adapter declined

Decided at the start of lane 0005, before any code: the gRPC adapter is not built. No client
needs it, a second transport would duplicate validation, auth, error mapping and idempotency
handling at the boundary of a money service, and it would not move latency (the hot-program
limit is the row lock). Ports and adapters are already shown by HTTP and the Kafka repayment
handler sharing `releaseCapacity`. Reasoning and revisit triggers: ADR 022. PRD FR-16, §10
and §11, ADRs 017/018/021 and constraint 9 updated in the same commit.

---

## 2026-10-28 — Architect review of lane 0005: rulings

The architect reviewed lane 0005 (M4) after its feature commit (APPROVE: 3 MINOR + 1 NOTE).
The MINORs were fixed in the review-fix commit and the k6 spread-phase commit; the full
reasoning is in `.harness/4-state/architect-review-0005.md`.

- **Schema readiness** — readiness verifies `to_regclass('public.program')`, so api/worker
  cannot become Ready before migrations have run.
- **NFR-03/NFR-04** — k6 spread phase meets the targets (read 4.60 ms, reserve 13.39 ms,
  release 16.76 ms p95 at 100 req/s); the hot-program phase is documented as row-lock
  contention with the PRD scale path (capacity buckets, read replica).
- **kubectl dry-run needs a cluster** — manifests were validated with kubeconform (5/5 valid);
  kubectl has no context on this machine.

---

## 2026-10-28 — Second review of lanes 0003–0005: rulings

A second fresh-context architect review of the lanes 0003–0005 code found 1 BLOCKER, 5 MAJOR and several
MINOR items; all were fixed in one commit and re-reviewed.

- **B1 — a program is the `(tenantId, programId)` pair; no cross-tenant lookup.** The limit
  path had gained `findAnyTenant(programId)` and refused a `ProgramLimitSet` when another tenant
  owned the same id. With bank-a and bank-b both owning `prg` (allowed by A12, required by
  AC-16), every limit change of bank-b went to the DLQ, so a limit *cut* never landed and bank-b
  kept reserving against the old limit. The lookup is removed; the Kafka key-vs-body check
  stays; which tenant may write a topic is a Kafka ACL concern. PRD §9 and ADR 007 now say so.
  Proof: `AC-16 sets the limit only on the message tenant's program when another tenant uses the
  same program id`.
- **M1 — staging keyed by message and run.** Concurrent deliveries of one snapshot collided on
  the staging primary key (23505, classed permanent → DLQ). Step-by-step in ADR 008 "Why staging
  rows are keyed by message and run"; migration 0004; orphan sweep after 1 h. Proof: `AC-10 two
  concurrent deliveries of the same snapshot apply once and neither fails`.
- **M2 — the DLQ alert was dead.** `alerts.yaml` read `dlq_messages_total`, which nothing
  emitted. The consumer now counts each successful DLQ send by topic and reason. ADR 013 lists the
  metrics that really exist; consumer lag is taken from the broker side, not the service.
- **M3 — bounded drift events.** `ReconciliationDriftDetected` carries at most 100 drifts plus
  `driftCount` and `truncated`; an unbounded list could exceed 1 MB and stall the single outbox
  relay for every tenant.
- **M4 — the FR-15 ledger branch is now tested**: the test corrupts only `ledger_entry`, and
  fails when the ledger comparison is deleted from the invariant query (probed).
- **M5 — load numbers.** The old hot-phase figures (reserve p95 ≈ 1.3 s) were a cold-start
  artefact: the hot phase ran first. Re-running with spread first moved the slowness to the
  spread phase (≈ 400 ms) and made the hot phase fast, which proved it. The scenario now has an
  unmeasured 20 s warm-up, sends an `Idempotency-Key`, and fails `make load` when NFR-03 is
  missed. Two warm runs: spread reserve p95 19–25 ms; hot (20 writes/s on one row) 28–58 ms.
  The README reports ranges and states that a single program's ceiling was not measured.
- **Minors**: per-partition wake-ups and cleared timers in the consumer; consumer drain capped
  at 40% of the shutdown deadline; retention floors (24 h keys, 7 d inbox) enforced at start-up;
  readiness requires the latest migration; database URL moved to a Kubernetes Secret, resources
  and grace period added; a test named "MAJOR-1" renamed to its requirement id.

Lesson for future lanes: a change that adds a lookup across tenants, or a table shared between
concurrent executions, is checked against PRD A12/AC-16 and against a concurrent duplicate
delivery before it is written.
