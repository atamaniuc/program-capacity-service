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
| 015 | Contracts and compatibility: zod to OpenAPI and AsyncAPI (treasury in, DLQs, `capacity.events.v1` out), served on the ops port; real events checked against the schemas; `oasdiff`; no Pact until the first split | [015-contracts](../../docs/adr/015-contracts.md) |
| 016 | Testing strategy: Testcontainers, property tests, AC-named tests | [016-testing-strategy](../../docs/adr/016-testing-strategy.md) |
| 017 | Out of scope and why: GraphQL, gateway, event sourcing, Saga, CDC, Kubernetes, AWS emulation | [017-out-of-scope](../../docs/adr/017-out-of-scope.md) |
| 018 | Architecture: hexagonal, vertical slices, tactical DDD; no monorepo tooling | [018-hexagonal-architecture](../../docs/adr/018-hexagonal-architecture.md) |
| 019 | Aggregate design: `Program` root, reservations loaded one at a time | [019-aggregate-design](../../docs/adr/019-aggregate-design.md) |
| 020 | Ubiquitous language and naming rules | [020-ubiquitous-language](../../docs/adr/020-ubiquitous-language.md) |
| 021 | Evolution path: split triggers T1–T4 and the order of the split | [021-evolution-path](../../docs/adr/021-evolution-path.md) |
| 022 | No gRPC adapter: FR-16 declined, revisit triggers (superseded on branch `microservices` by 024) | [022-no-grpc-adapter](../../docs/adr/022-no-grpc-adapter.md) |
| 023 | Branch `microservices`: trigger T3 fired, `funding-service` as a new bounded context; database per service; capacity not cut | [023-t3-funding-context-database-per-service](../../docs/adr/023-t3-funding-context-database-per-service.md) |
| 024 | Branch `microservices`: internal gRPC driving adapter over the same use cases, one boundary for validation, auth and the problem mapping; supersedes 022 there | [024-grpc-driving-adapter](../../docs/adr/024-grpc-driving-adapter.md) |
| 025 | Branch `microservices`: hand-rolled orchestrated funding saga in PostgreSQL; compensation, unknown outcomes, exactly-once effect across the gRPC hop | [025-funding-saga-orchestration](../../docs/adr/025-funding-saga-orchestration.md) |
| 026 | Branch `microservices`: Helm charts and a local kind cluster `finverity-ms` (amends 017) | [026-helm-and-kind](../../docs/adr/026-helm-and-kind.md) |
| 027 | Branch `microservices`: npm workspaces with capacity at the root; side-by-side isolation from `main` | [027-repository-layout-and-side-by-side-isolation](../../docs/adr/027-repository-layout-and-side-by-side-isolation.md) |
| 028 | Branch `microservices`: contracts package and Pact, after the MVP cut (amends 015) | [028-contracts-package-and-consumer-contracts](../../docs/adr/028-contracts-package-and-consumer-contracts.md) |
| 029 | Branch `microservices`: API gateway, Envoy Gateway on the Gateway API in kind only; services still verify the JWT; one cluster issuer; local per-tenant rate limit, no Redis (amends 017 and 026) | [029-api-gateway](../../docs/adr/029-api-gateway.md) |

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

---

## 2026-10-29 — Branch `microservices`: an evolution demo with branch-scoped supersessions

`main` stays the submitted take-home and keeps every decision above. Branch `microservices`
shows the split the ADRs said would come when a trigger fires, for the job description's
microservices, gRPC, Saga and Kubernetes asks. Lane 0006 specifies it.

- **Fired on the branch only:** ADR 021 T3 (ADR 023); ADR 022's third revisit trigger, gRPC
  half (ADR 024 supersedes ADR 022); ADR 017 rows "Saga, Temporal" (ADR 025, Temporal still
  rejected), "Helm, a real cluster" (ADR 026, Helm and kind only), "Pact" (ADR 028), "gRPC
  adapter" (ADR 024) and "API gateway in this repo" (ADR 029, Envoy Gateway in kind only).
- **Still settled on the branch:** the capacity service is not cut and I1–I8 hold; no Redis,
  event sourcing, GraphQL, CQRS read store, service mesh, Temporal, schema registry; no
  `SELECT … FOR UPDATE` on the idempotency path (D3 closed); zod is the only validator, no
  `@nestjs/swagger`.
- **Owner rulings recorded in the ADRs:** split by T3 not by cutting capacity; hand-rolled
  orchestrator persisted in PostgreSQL; database per service; gRPC alongside REST with
  `buf lint`/`buf breaking`; Helm and kind; contracts package and Pact allowed to follow the
  MVP cut; the branch runs side by side with `main` (ports +10000, project
  `program-capacity-ms`, kind cluster `finverity-ms`).
- **Constraint 9, owner ruling (2026-10-29):** on this branch the Saga, Pact and gRPC items are
  lifted, and the agent amends any rule that blocks showing the evolution, citing the ADR. The
  `CONSTRAINTS.md` change is committed by the owner, because `harnessimo locked` refuses agent
  commits on that file. `main` keeps the original rule.
- **Lane close and docs, owner ruling (2026-10-29):** lane 0006 closes after T18, so every ADR
  021 precondition holds; branch Russian docs are new `docs/micro-srv-*.ru.md`, `main`'s are not
  edited.
- **No schema registry, review finding (2026-10-29):** ADR 021 promised one "with the first
  split", and ADR 028 dismissed it in one line. Its trigger (a second deployable consuming
  `capacity.events.v1`) fires only at T24, and a registry is a run-time check for schemas spread
  across repositories. ADR 028 now says what replaces it at build time (contracts package, JSON
  Schema backward-compatibility check added to T18, `buf breaking`, Pact, `.v2` topics for a
  wanted break) and the triggers that bring it in (another repository reads a topic, Avro or
  Protobuf payloads, producers deploying independently of the contracts package).
- **API gateway, owner ruling (2026-10-29):** ADR 017's gateway trigger ("a second public
  service needing shared policies") fires: `funding-service` exposes `POST /v1/funding-requests`
  next to capacity's REST, and both need the same JWT, CORS, rate-limit and routing policy.
  Envoy Gateway on the Kubernetes Gateway API, in kind only (no gateway in compose): routes
  `/v1/programs…` to capacity and `/v1/funding-requests…` to funding, checks the JWT at the edge,
  applies CORS and rate limits. Each service still validates the JWT itself (ADR 011), so a call
  that bypasses the gateway still gets 401; gRPC is never exposed. No hand-written NestJS
  gateway, no Kong. AWS analogue: API Gateway or ALB. Recorded in
  [ADR 029](../../docs/adr/029-api-gateway.md), which also fixes one issuer per kind deployment
  (the in-cluster FQDN of the mock OAuth2 Service, one Makefile constant for the services and the
  gateway) and adds lane 0006 task T16a with GW-01 to GW-05.
- **No Redis, owner ruling (2026-10-29):** Redis stays out on the branch too, both as a cache and
  as a rate-limit backend. Caching capacity data is rejected because availability is money: a
  stale value is a defect, the reserve is checked under the `program` row lock anyway, and ADR
  017's trigger (measured read load on the primary) has not fired. Envoy Gateway's global rate
  limit needs a Redis backend, so the gateway uses **local** rate limiting: a counter per
  gateway replica, so a tenant's effective limit is N × the configured value with N replicas.
  With one replica in kind that is exact. Trigger to revisit: several gateway replicas plus a
  contractual per-tenant quota.

**Why:** the trigger table in ADR 021 is only credible if a firing produces the structure it
promised, with the invariants intact.

**Rejected:** rewriting `main`; moving capacity to `services/capacity` (ADR 027); Temporal
(ADR 025).

## 2026-10-30 — Architect review of lane 0006 T11–T13 (saga driver, compensation, exactly-once): APPROVE WITH FIXES

Reviewed cold at d3dcd9b, 94cee19 and 932e71a (code as committed, not the T14 work in the tree).
No BLOCKER; no second review. T11–T13 stay ticked; the fixes below land in the `funding` lane with
T14. `make verify` green on the working tree; `npx harnessimo check` green; `make test` belongs to
the funding agent (its T13 run is quoted in the handoff).

- **The money path is right as built.** One deterministic key per step (`funding:<id>:<step>`);
  the Reserve body and the payment body are pure functions of the persisted row (bytes asserted).
  No path re-enters `DISBURSING`, and no edge leads from an unknown disbursement to
  `COMPENSATING`: an unknown disbursement is retried with a lookup first, then parked
  (`NEEDS_ATTENTION` is outside the claim predicate). `Release` is reachable only with a
  `reservation_id` taken from `CREATED` under the saga's key (S3). Claim, then call outside any
  transaction, then one record transaction (row `WHERE version = claimed`, attempt row, outbox
  row); the claim bumps the version, so a version match proves no later claim. No `FOR UPDATE`
  on any idempotency row; `lock_timeout`/`statement_timeout` per transaction.
- **Accepted:** `record` checks the version and not `lease_owner` (a late record under an
  expired but unclaimed lease is a correct record). The worker reads and writes by request id
  across tenants: it is a system actor; tenant isolation on the effect side is the per-tenant
  capacity token, and the token cache and its in-flight map are keyed by tenant. The per-call
  gRPC deadline on `Release` is a transport timeout, not a business deadline (FS-11 proves the
  compensation outlives 1 ms limits). `release-exceeds-remaining` as compensated is proven on the
  real image first. Review m4 (T7–T9) is closed: `tenant_id` is sent and asserted in the form and
  in the minted claim.
- **M1 — the key-retention bound is not what boot validates.** `validateSagaConfig` bounds only
  `reserveResolutionLimitMs < 24 h`. The window that must fit inside capacity's key retention
  runs from the first Reserve to the last resolving Reserve: reserve deadline + resolution limit
  + one backoff cap + one lease. 13 h + 13 h passes today; at hour ~25 the repeat meets the
  natural key, capacity answers `EXISTING`, the resolving path ends `FAILED` without a release,
  and the reservation is held for good with no alert (S5 broken). Ruling: boot refuses
  `reserveDeadline + resolutionLimit + 1 h margin >= 24 h`; ADR 025's bound column says "the sum".
- **M2 — `PERMISSION_DENIED` on Reserve is not a statement about earlier attempts.** Capacity
  refuses 403 before the key is consulted (ADR 006 table), so on a repeat it cannot mean "nothing
  held". Attempt 1 commits and its answer is lost; the tenant's client loses `capacity:write`
  (offboarding, an IdP mapping change); the repeat gets `PERMISSION_DENIED` and the saga ends
  `REJECTED` (or `FAILED` while resolving) with capacity still holding the reservation, silently.
  Ruling: for Reserve, `PERMISSION_DENIED` is **unknown** (a misconfigured tenant then goes
  RESERVING → COMPENSATING → `NEEDS_ATTENTION` with an alert, which is the visibility it
  deserves). Release keeps it definite (it already parks). `INVALID_ARGUMENT` stays definite: it
  is a function of the identical body. ADR 025's outcome table is amended accordingly.
- **Minor:** the lease bound ignores the token fetch and the one-refresh retry (m1); FS-08's
  `effects.size >= 1` asserts nothing (m2); FS-12's "receiver sees one effect" is proven against a
  fake whose dedup lives in the test (m3); FS-09's "capacity's reserved ends where it started" is
  not what its fake-backed proof asserts (m4); the schema does not back "DISBURSING/COMPLETED
  have a reservation, COMPLETED has a payment" (m5). Fix list in the lane handoff.

**Why:** the saga's exactly-once argument rests on two facts: capacity still holds the key, and
a definite failure really means nothing was held. M1 and M2 are the two places where the code
lets either fact lapse without an alert; everything else is proven and would turn red if broken
(the version-check and random-key probes were read and agree with the reported failures).

**Rejected:** a lease-owner check in `record` (redundant with the version bump), a business
deadline on compensation (ADR 025: `release_ref` never expires), treating every definite Reserve
failure on a repeat as unknown (`FAILED_PRECONDITION`, `NOT_FOUND`, `ALREADY_EXISTS` are stored
under the key and replayed, so they are definite on any attempt).

## 2026-10-30 — Architect review of lane 0006 T7 fixes, T8, T9: APPROVE WITH FIXES

Reviewed cold at 9b89069 and e6da9a8. No BLOCKER; no second review. T7, T8, T9 stay ticked;
the fixes below land in the `funding` lane before T11 starts.

- **The money and idempotency path is right as built.** Amount parsed with `parseMoney`
  (bigint, scale, `> 0`, BIGINT bound) before the key is claimed, so a 400 never takes it
  (ADR 006 table). Key claim `INSERT … ON CONFLICT DO NOTHING`, no `FOR UPDATE`; then the
  natural-key insert; outbox and stored response in the same transaction with `lock_timeout`
  and `statement_timeout`. Lock order key → `funding_request`, so no deadlock between keyed and
  unkeyed requests for one invoice. The 20-call burst test fails if the claim is removed
  (19 answers become 200).
- **M1 — the mock OAuth2 scope mapping does not match.** mock-oauth2-server treats `match` as a
  regular expression (`*` alone is the wildcard). `"funding:*"` matches `funding`, `funding:`,
  never `funding:write funding:read`, so a compose token for the funding API falls through to
  the default mapping with `aud` `capacity-service` and the API answers 401. The e2e test signs
  its own tokens and cannot see it. Fix: `"match": ".*funding:.*"`, and a compose check that
  mints a funding token and asserts `aud` (part of T11's compose wiring at the latest).
  `funding-service.*` works only because it is also a valid regex; write it `funding-service\\..+`.
- **m1 — funding answers before authenticating on unknown routes and wrong methods** (404/405
  without a token). ADR 011's rule applies to funding too: authenticate every `/v1/` request
  first, then route. A 405 gets its own type `method-not-allowed`, not `not-found`.
- **m2 — compose healthcheck races the init script.** `pg_isready` over the Unix socket is
  ready while the entrypoint's temporary server runs `init-databases.sh`, before the roles exist.
  Use `pg_isready -h 127.0.0.1 -U funding -d funding` (the temporary server has no TCP
  listener). An existing volume from before 9b89069 has no `funding` database and a superuser
  `capacity`: the runbook says `make down -v` once.
- **m3 — ADR 006 cases without a test.** A business rejection under a key is stored and
  replayed (409 with key `k`, then the same body and key: 409 again, one `idempotency_key` row
  with status 409); a JWKS outage answers 503 with `Retry-After`. Add both under `FS-02`.
- **m4 — the `${tenant_id}` request-param mapping for `funding-service.<tenant>` clients.** If
  the minter omits the form parameter the claim is the literal placeholder and capacity answers
  404 for every program. T11's client sends it and a test asserts the claim.
- **Accepted:** plain SQL migrations under a transaction-scoped advisory lock (ADR 012 says
  exactly this; "Kysely SQL migrations" in tasks.md means the same). `saga_step_attempt` has no
  `tenant_id`: it is reached only through a tenant-filtered `funding_request`; any future read
  API joins through it. Unit-project `testTimeout` 30 s is load headroom, not a mask.

**Why:** an unkeyed and a keyed retry must never produce two funding requests or a second
reserve, and that holds; the findings are on the edges (dev token issuance, anonymous probing,
first boot) that would make the demo fail or leak routes, not on the money path.

## 2026-10-30 — Architect review of lane 0006 T16 + T16a (kind, API gateway): rulings

APPROVE WITH FIXES at 39f15e4: 0 BLOCKER, 2 MAJOR, 5 MINOR (fix list in the lane handoff).
T16 and T16a stay ticked; both MAJORs bite only when the funding release first lands in kind.

- **Wrong audience at the edge is 403, accepted.** Envoy's `jwt_authn` maps
  `JwtAudienceNotAllowed` to 403 and the other token failures (missing, signature, `exp`,
  unknown `iss`) to 401. This is Envoy's behaviour, not configuration, and it is the more precise
  answer: the token is authentic but not for this API. What GW-02 must prove is unchanged: the
  edge refuses it and the body is not `application/problem+json`, so the service never saw it.
  The services keep ADR 011 (wrong `aud` → 401 at the service); `docs/api.md` lists both.
- **Edge tenant handling is sound.** `x-tenant-id` is removed in `earlyRequestHeaders` and set
  only by `claimToHeaders` from the verified token, used only as the rate-limit key; no service
  reads it (grep of `src/` and `services/`: no match). The tenant still comes from the token in
  each service (ADR 011). A token without `tenant_id` escapes the per-tenant limit; accepted in
  kind (the mock always sets it, the services 401 without it), revisit with a real IdP.
- **Defence in depth holds.** The gateway forwards `Authorization` (GW-01 200 through the edge
  proves capacity re-verified it); GW-03 proves capacity refuses a direct ClusterIP call without a
  token and with a foreign-issuer token, with an RFC 9457 body.
- **Isolation from `main` holds.** No `extraPortMappings`; every `kubectl`/`helm` call goes
  through `$(KUBECTL)`/`$(HELM)` with the `.kind/kubeconfig` file and context (K8-04 asserts it);
  `kind create`/`export`/`delete` pass `--kubeconfig` (not yet asserted, m2); forwards stay in
  23000–23099; `.kind/` is git-ignored.
- **Skipped funding checks: honest, but not self-arming.** GW-03 (funding) turns on by itself when
  `funding-service:ms-local` exists. GW-01 (funding) turns on and fails on purpose (a placeholder),
  and could not pass anyway: the mock issues no `aud=funding-service` token, and kind-up leaves
  funding's `oauth.tokenUrl` at the short Service name, so its capacity tokens carry a foreign
  `iss` (ADR 029 violation). Fixed before funding is deployed (M1, M2).

**Why:** the gateway is the branch's answer to ADR 017's trigger; it must not weaken ADR 011,
and a green smoke must mean what it says for both routes, not only capacity's.

## 2026-10-30 — Architect re-review of lane 0006 T5: APPROVE

APPROVE at 76d6020: every first-review finding fixed and probed. T5 ticked.

- **The first review's GR-04 probe was weaker than reported.** Its mutant still forwarded the
  message only after authentication settled. The strong mutant (forward at once, with or
  without the handler's principal check) fails 12 or 14 of 15 tests, including the new
  late-rejection test. The new test stays: it is the one that proves "no use case before auth".
- **Two `make test` flakes predate the branch and exist on `main` unchanged.** (a) `freePort()`
  picks a port and closes it before the app binds `0.0.0.0`; on macOS a wildcard bind succeeds
  next to another process's `127.0.0.1` listener on the same port (reproduced), so a request to
  `127.0.0.1` reaches that process. Fix: servers bind port `0` and report the bound port.
  (b) `pg_stat_activity` still lists a backend shortly after its client disconnects; the
  shutdown tests must poll for zero, not read it once. Both are fixed on this branch before T6.
  For `main`, the submitted solution, the same two test-only fixes are recommended; the owner
  decides, because `main` changes only by owner decision.
- **Carried to T6:** a cross-currency release over both transports, because a swap of
  `repaid_amount` and `released_amount` survives a same-currency test.

**Why:** a reviewer running `make test` on `main` can hit (a) on a busy machine, and a red run is
read as a broken solution.

## 2026-10-30 — Architect review of lane 0006 T5 (gRPC adapter, GR-04..GR-07): rulings

CHANGES REQUIRED at a90b53e (T4 carry-overs at 0292242 accepted). T5 stays unticked.

- **The gRPC port is internal; local compose may publish it on loopback.** "Internal" means not
  reachable from outside the deployment: ClusterIP in kind, never routed by an ingress or the
  gateway. Compose keeps ADR 027's host port 60051 for `grpcurl` and a host-run funding service,
  bound to `127.0.0.1` only. Tests never use it. Recorded in ADR 024 (Placement), ADR 027 (port
  table) and the spec's Boundaries.
- **A proto field means one thing in every RPC.** The release view is release-level (repaid
  amount, capacity freed by this release); `Reservation.invoice_amount` / `released_amount` are
  reservation-level (invoice amount, cumulative release). Overloading them would be a silent
  meaning change that `buf breaking` cannot catch once a consumer reads it, so it is fixed in
  T5, additively: `ReleaseResponse.release = 3` (`Release` with `release_ref`, `reservation_id`,
  `reservation_status`, `reason`, `repaid_amount`, `released_amount`, `remaining_amount`);
  `ReleaseResponse.reservation` is not set. The mutation `capacity` echo is the REST
  `CapacitySnapshot` and the proto comment says so. The saga needs only `reservation_status`
  (RELEASED) and the OK/`release-exceeds-remaining` outcome; the rest is for audit and GR-03.
  Recorded in ADR 024.
- **`FUNDING_GRPC_DEADLINE_MS` is 21000, not 5000.** ADR 024 and ADR 025 both require the client
  deadline above capacity's `lock_timeout + statement_timeout`; those are 5 s + 15 s, so 5000
  contradicted the rule. The step lease (30 s) stays above one call. A commit after the deadline
  is still possible (pool wait, several statements) and is resolved by the same-key retry (GR-05).
  Recorded in ADR 025.
- **Decode before auth is accepted.** grpc-js deserialises before any interceptor; the cost is
  bounded by `grpc.max_receive_message_length` = 100 kB, enforced after decompression, and unknown
  methods answer `UNIMPLEMENTED` before the interceptor (so metric labels stay bounded). No zod
  parse and no use case runs before authentication.

**Why:** the saga reads these answers to decide whether money is held; a field whose meaning
differs by RPC, or a deadline below the server's own bound, turns definite answers into
unknown ones.

## 2026-10-30 — Architect review of lane 0006 T4 (shared boundary, GR-02): rulings

APPROVE at 74acf32. REST behaviour and `contracts/openapi.yaml` unchanged; layer rules probed.

- **`fx-rate-unavailable` rejects the funding request.** Stored under the key on `main` (ADR 005,
  006) and `FAILED_PRECONDITION` over gRPC (ADR 024), so the saga's deterministic-key retry would
  only replay it. The saga ends `REJECTED` with that reason; the platform resubmits a new funding
  request later. Recorded in ADR 025 (outcome classes). The semantics stay in the ADR, not the code.
- **`reservation-conflict` → `ALREADY_EXISTS` is "not ours"**, like `EXISTING`: `REJECTED`, nothing
  released. `service-unavailable` (`UNAVAILABLE`) is a transport problem the use cases cannot
  return, so it is never stored.
- **Carried into T5 (MINOR):** the GR-02 non-retryable check becomes an allowlist of ADR 025's
  definite-failure codes; `boundary-is-for-driving-adapters` becomes an allowlist of
  `in/(http|grpc)`. Details in the lane handoff.

**Why:** the saga reads gRPC codes as definite or unknown; a stored answer read as unknown
would be retried against a replay for 12 h.

## 2026-10-29 — AsyncAPI covers the outbound events and is served at `/docs/asyncapi`

`contracts/asyncapi.yaml` described only the treasury input, while `docs/api.md` called it the
event contract, `repository-map.md` said "in and out" and PRD §7 promised schema validation of
outbound events. The outbox payloads had no schema at all (`payload: unknown`). Now
([ADR 015](../../docs/adr/015-contracts.md), amended):

- **One source.** `application/shared/capacity-events.ts` holds zod schemas of the four events
  and their Kafka headers; `OutboxEvent` is a union of the inferred payload types, so every use
  case builds a payload the contract describes. DLQ headers, the consumer group and the DLQ
  topic name moved into `treasury-messages.ts` and are used by the consumer.
- **One document.** `src/platform/contracts/asyncapi.ts` builds AsyncAPI 3.1 (version 1.1.0): both treasury topics, both DLQs, `capacity.events.v1`, Kafka keys and
  consumer group bindings, header schemas, delivery and evolution rules, and an example per
  message. `npm run contracts` writes it with one draft-07 JSON Schema per message;
  `contracts:check` now covers every file in `contracts/`, so `make verify` and CI catch
  AsyncAPI drift (before, only `make test` did).
- **Open schemas, strict tests.** Published schemas allow unknown fields (consumers must ignore
  them; `v1` grows additively). Tests compile a strict variant from the same zod source; the
  full-stack test `capacity-events.kafka.test.ts` validates every real record of all four types
  against both, plus headers, key and gap-free `seq`. Mutation probe: an extra payload field in
  `ReservationCreated` fails it (`must NOT have additional properties`). All 314 events already
  on the local stack's topic, produced before the change, passed the strict check.
- **Served offline.** `/docs/asyncapi` renders the document with `@asyncapi/react-component`
  (devDependency; the image copies only the standalone bundle, stylesheet and licences, ~3 MB).
  Swagger UI and the AsyncAPI page link to each other.
- **QA.** QA-05 (page on the ops port only), QA-72 (`npm run contracts:events` per program, all
  four types). `make qa`: 103/103.

**Why:** the event stream is half of the published language (PRD §7); without a schema a
consumer can only reverse-engineer it, and a reviewer reading the docs would find the claim
false.

**Rejected:** a hand-written AsyncAPI file (drift), JSON Schema 2020-12 files (AsyncAPI schema
objects are draft-07, a second copy would be needed), closed published schemas (every additive
change would break strict consumers), the viewer from a CDN or as a runtime dependency (offline
docs; image size and scan surface), a schema registry (no consumer yet; arrives with the first
split).

- **Treasury schema files changed format, not meaning.** They moved from JSON Schema 2020-12
  with `$defs` to self-contained draft-07, so an `Ajv2020` consumer of those files must switch
  to draft-07. `contracts:compat` against efa1d4f, which inlines references first, reports no
  semantic change.
- **Compatibility is now checked, not only drift** (review M1). The docs said `oasdiff` ran in
  CI; nothing did. `npm run contracts:compat` (CI on every push and pull request, `make compat`)
  runs oasdiff on `openapi.yaml` and a field-by-field rule on the message and header schemas:
  only a new optional field, a new `event-type` value and documentation may change within `v1`.
  Enums are closed, event types open.
- **`ProgramCapacityChanged.status`** (review m1): every applied `ProgramLimitSet` emits the
  event, including a suspend or resume, but the payload had no status, so a consumer could not
  see a suspension. Added as an optional field (older records lack it); the Kafka test checks
  the code always sends it.
- **Architect review (fresh context): CHANGES REQUIRED, 2 MAJOR + 11 MINOR, all addressed.** M2:
  `docs/WIP.md` added to `.git/info/exclude`. m2/m3/m4: the AsyncAPI description states that
  reconciliation is reported per program, not per reservation, the drift-amount exception to
  the money rule, and the enum policy. m5: the DLQ test checks the published `DlqHeaders`. m6:
  `toEnvelope` is typed against the contract envelope. m7: the builder moved from the
  application layer to `src/platform/contracts/`; its tests to `test/contracts/` (unit). m8:
  `contracts:events` stops at the partitions' high watermark instead of an idle timer. m9: the
  viewer fallback is unit-tested; ADR 015 says the bundle hides its dependencies from the scan
  rather than removing them. m11: PROGRESS and BUDGET updated. Notes: QA-71 wording, FX age,
  `releaseRef` text, the `MAX_DRIFTS_IN_EVENT` re-export, `programId` bound, and the Kafka test
  deduplicates by `messageId` before counting.

**Left as found, for the owner:** drift amounts in `ReconciliationDriftDetected` are integer
minor units without a currency, unlike every other amount; the contract documents them as they
are. Changing them is a payload change on the reconciliation path, and with this check in place
a `v2` of the event.

