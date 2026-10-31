# 025. Funding saga: a hand-rolled orchestrator persisted in PostgreSQL

- Status: accepted (branch `microservices` only)
- Date: 2026-10-29
- Amends: ADR 017 row "Saga, Temporal" (its revisit condition, "a multi-step flow across
  services", is met on this branch)

## Context

A funding request asks to pay one supplier invoice early. Turning it into money needs three
systems that share no transaction: the funding database, the capacity service (ADR 023,
ADR 024) and a payment rail (a mock on this branch). Each step can fail, time out, or succeed
without us hearing about it. The flow must never pay out money without capacity held, and must
never hold capacity for a request that has definitely failed.

## Decision

### Shape

An **orchestrated** saga. `funding-service` owns one `FundingRequest` row per request; its
saga state is columns of that row. A driver loop in the funding `worker` role advances due
requests one step at a time. No workflow engine.

Steps, in order:

1. **Risk check.** A local, deterministic policy (per-currency limits on the invoice amount,
   in minor units). No external call and no effect, so nothing to compensate.
2. **Reserve.** gRPC `Reserve` on capacity, with `Idempotency-Key = funding:<id>:reserve`.
3. **Disburse.** `POST /v1/payments` on the payment rail, with
   `Idempotency-Key = funding:<id>:disburse`. This is the **pivot step**: once it succeeds the
   saga only moves forward.
4. **Compensate** (only on a definite failure after a reservation). gRPC `Release` with
   `releaseRef = funding:<id>:compensation`, no amount (the final release takes the exact
   remainder), reason `CANCELLED`, `Idempotency-Key = funding:<id>:release`.

Every key is derived from the funding request id and the step, never generated per attempt, so
every retry of a step is the same request to the receiver. The keys are also written to the
attempt log for audit.

### Outcome classes

Every call outcome is classified before any transition:

| Class | Reserve (gRPC) | Disburse (HTTP) | Release (gRPC) |
| --- | --- | --- | --- |
| Definite success | OK with `result = CREATED` | `PAID` | OK; or `release-exceeds-remaining` on a final release, which can only mean the remainder is already zero |
| Definite failure | `FAILED_PRECONDITION`, `NOT_FOUND`, `ALREADY_EXISTS`, `INVALID_ARGUMENT`; or OK with `result = EXISTING` (not ours, see below) | `DECLINED` (the rail states that no money moved) | `NOT_FOUND`, `release-ref-mismatch`, a persistent `PERMISSION_DENIED`: unexpected, never retried blindly |
| Unknown | `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `INTERNAL`, `UNKNOWN`, `ABORTED`, `RESOURCE_EXHAUSTED`, connection loss; `UNAUTHENTICATED` after one token refresh; `PERMISSION_DENIED` (a refused token or scope says nothing about whether an earlier attempt landed, so the saga keeps resolving and, past the limit, parks the request instead of ending `FAILED` on it; finding M2 of the architect review of tasks T11 to T13) | timeout, connection loss, 5xx, an unparseable answer | as for Reserve |

**`EXISTING` is not ours.** Under the saga's own key, an earlier attempt that created the
reservation is replayed as `CREATED`. `EXISTING` therefore means the invoice already had a
reservation with the same terms, made by someone else (for example a REST client). The saga
ends `REJECTED` (`invoice-already-reserved`) and never releases that reservation.

**A stale FX rate rejects the funding request; it is not retried** (architect ruling,
2026-10-30, in the review of task T4, the shared driving-adapter boundary). `fx-rate-unavailable` is transient in the world (treasury publishes a
fresh rate later), but capacity stores it under the `Idempotency-Key` like any business
rejection (ADR 005, ADR 006) and ADR 024 maps it to `FAILED_PRECONDITION`. The saga's reserve
key is deterministic, so a retry would only replay the stored 422 for 24 h. The saga therefore
ends `REJECTED` with reason `fx-rate-unavailable`; no capacity is held (saga property S5 below), no money moved, and
the platform submits a new funding request once the rate is fresh. Rejected: mapping it to
`UNAVAILABLE` and not storing it (changes `main`'s REST semantics and the behaviour of acceptance criteria AC-12 (FX conversion) and AC-17 (stored rejections));
per-attempt reserve keys (breaks "every retry of a step is the same request"). Revisit when
FX rejections become an operational burden: then the fix is a funding-side pre-check of rate
freshness or a capacity-side change on `main` first, never a new key per attempt.

**`reservation-conflict` (`ALREADY_EXISTS`) is not ours either.** The saga's own retries carry
the same key and body, so they replay; a conflict means another request reserved the invoice
with other terms. The saga ends `REJECTED` (reason `reservation-conflict`) and releases nothing.

### State machine

| From | Outcome | To | Same transaction |
| --- | --- | --- | --- |
| `RECEIVED` | risk approved | `RESERVING` | `reserve_deadline_at` set |
| `RECEIVED` | risk declined | `REJECTED` | outbox `FundingRequestRejected` |
| `RESERVING` | definite success | `DISBURSING` | `reservation_id`, `disburse_deadline_at` |
| `RESERVING` | definite failure | `REJECTED` | reason = the problem type; outbox |
| `RESERVING` | unknown, before `reserve_deadline_at` | `RESERVING` | `next_attempt_at` = backoff |
| `RESERVING` | unknown, deadline passed | `COMPENSATING` (reservation unknown) | |
| `DISBURSING` | definite success | `COMPLETED` | `payment_id`; outbox `FundingRequestCompleted` |
| `DISBURSING` | definite failure | `COMPENSATING` | |
| `DISBURSING` | unknown, before `disburse_deadline_at` | `DISBURSING` | backoff; the next attempt first asks `GET /v1/payments/{key}` |
| `DISBURSING` | unknown, deadline passed | `NEEDS_ATTENTION` | outbox; alert |
| `COMPENSATING` (reservation unknown) | Reserve repeated with the same key: `CREATED` | `COMPENSATING` (reservation known) | `reservation_id` |
| `COMPENSATING` (reservation unknown) | Reserve repeated: definite failure | `FAILED` (nothing was held) | outbox `FundingRequestFailed` |
| `COMPENSATING` (reservation unknown) | still unknown after `FUNDING_RESERVE_RESOLUTION_LIMIT` | `NEEDS_ATTENTION` | alert |
| `COMPENSATING` (reservation known) | Release definite success | `FAILED` (compensated) | outbox `FundingRequestFailed` |
| `COMPENSATING` (reservation known) | Release unknown | `COMPENSATING` | backoff, **no deadline** |
| `COMPENSATING` (reservation known) | Release definite failure | `NEEDS_ATTENTION` | alert |

`COMPLETED`, `REJECTED` and `FAILED` are terminal: no transition leaves them. `NEEDS_ATTENTION`
is left only by an operator command (after the MVP cut: `COMPLETED` when the payment is
confirmed, `COMPENSATING` when it is confirmed not made). Properties checked by a fast-check
test over random outcome sequences (acceptance criterion FS-01 in the [funding-saga spec](../../specs/0006-funding-saga/spec.md)).
They are numbered S1 to S6 here; these are saga properties, not the PRD's success criteria:

- S1. A terminal state never changes.
- S2. `COMPLETED` implies a reservation created under the saga's key and a `PAID` disbursement.
- S3. `Release` is issued only for a reservation the saga created (`CREATED` under its key).
- S4. No compensation once a disbursement is `PAID` or its outcome is unknown.
- S5. `REJECTED` and `FAILED` leave no capacity held by the saga.
- S6. Every call of a step carries that step's deterministic key.

### Compensation semantics

Compensation is a **forward action**, not a rollback: a new `RELEASE` ledger entry in capacity,
with actor `funding-service`, next to the `RESERVE` it undoes. The audit trail shows both.
It runs only after a *definite* failure of a later step; a step whose outcome is unknown is
resolved first, never compensated on a guess.

**An unknown disbursement is never compensated.** Releasing capacity while the money may have
left would leave a funder exposed with no capacity held for it: the under-reserving direction
that PRD §8 forbids. The saga retries with the same key, asks the rail for the payment by key,
and after `FUNDING_DISBURSE_DEADLINE` parks the request in `NEEDS_ATTENTION` with the
reservation still held and an alert raised.

**An unknown reserve is resolved, then compensated.** When the reserve deadline passes with no
definite answer, the saga repeats `Reserve` under the same key. The receiver replays a committed
reservation (`CREATED`, so the saga now knows the id and releases it) or answers a definite
failure (nothing was held). If the original attempt never landed, the repeat may create the
reservation now; the saga then releases it at once. That costs one `RESERVE`/`RELEASE` pair in
the ledger and is correct.

### When the compensation itself fails

1. **Unknown outcome** (capacity down, timeouts): retry forever with capped exponential backoff
   and jitter. The request stays `COMPENSATING` and capacity stays reserved: over-reserved, the
   safe direction. `FundingCompensationStuck` fires when the oldest `COMPENSATING` request is
   older than 15 minutes.
2. **Retrying is safe for any length of time.** `release_ref` is a permanent natural key in
   capacity (ADR 006), so even after the `Idempotency-Key` has expired (24 h, NFR-11) the same
   release replays its stored result. There is no window in which a retry releases twice.
3. **Definite but unexpected answer** (`NOT_FOUND`, `release-ref-mismatch`): `NEEDS_ATTENTION`.
   The runbook lets an operator release through REST with the same `releaseRef`; whichever path
   wins, `release_ref` admits one release.
4. A compensation never gives up silently: no transition leaves `COMPENSATING` for a terminal
   state without a definite release outcome.

### Exactly-once effect across the gRPC hop

Delivery of each step command is **at least once**: the saga repeats a step until it gets a
definite answer. The **effect is exactly once** because each receiver deduplicates in the same
transaction as the effect: capacity by `(tenant, Idempotency-Key)` and by its natural keys
`(tenant, program, invoice)` and `(reservation, release_ref)` (ADR 006); the payment rail by
its `Idempotency-Key`. Case by case for `Reserve`:

| What happened | What the repeat with the same key gets |
| --- | --- |
| The call never reached capacity | Capacity does the work now: one reservation |
| Capacity committed; the answer was lost or the client deadline expired | The stored `CREATED` answer, same `reservationId`, no second ledger entry |
| The repeat arrives while the first is still in its transaction | It waits at the key's unique index, then replays the committed answer (the path acceptance criterion AC-02 tests: a retry during the first request) |
| Funding crashed after the call, before recording the result | The driver runs the step again from the persisted state: a replay |
| A stale executor (lease expired) records a late result | Its transition updates no row (version check); its call was a duplicate |

The argument holds only while capacity still has the key: 24 hours (NFR-11). After that a
repeat under the same key is a new request, meets the natural key, and is answered `EXISTING`,
which the saga would read as "not ours". So every reserve retry ends well inside the window:
`FUNDING_RESERVE_DEADLINE` (default 2 min) for the normal path,
`FUNDING_RESERVE_RESOLUTION_LIMIT` (default 12 h, half the retention) for resolution, then
`NEEDS_ATTENTION`. `Release` has no such limit because `release_ref` never expires.

### Transactions and lock order in the funding database

- The API transaction: claim the `idempotency_key` row (`INSERT … ON CONFLICT DO NOTHING`, never
  `FOR UPDATE`, ADR 006), insert the `funding_request` (unique per tenant, program and invoice),
  insert the outbox row, store the response, commit. Answer 202 with `Location`.
- A step runs **outside** any transaction; no transaction is held across a network call.
  - **Claim:** a short transaction selects due rows
    (`next_attempt_at <= now()`, lease free or expired) with `FOR UPDATE SKIP LOCKED`, sets
    `lease_owner` and `lease_until = now() + FUNDING_STEP_LEASE`, bumps `version`, commits.
  - **Call** the receiver with the step's key and a deadline.
  - **Record:** one transaction updates the row `WHERE id = :id AND version = :claimed`, appends
    the `saga_step_attempt` row, inserts the outbox row when the state changes, commits. Zero
    rows updated means the lease was lost: the result is dropped.
- Lock order: dedup row (idempotency key), then the `funding_request` row. Nothing else is
  locked. Time comes from the database (`now()`); no session advisory locks (NFR-15);
  `lock_timeout` and `statement_timeout` per transaction (ADR 003).
- `SKIP LOCKED` is right here and wrong for the capacity relay (ADR 009): no order across
  funding requests matters, and the order within one request is held by its row and version.

### Timeouts and retries (defaults, all configurable and validated at boot)

| Setting | Default | Bound |
| --- | --- | --- |
| `FUNDING_GRPC_DEADLINE_MS` | 21000 | Above capacity's `lock_timeout + statement_timeout` (5 s + 15 s, `PostgresUnitOfWork` defaults) |
| `FUNDING_PAYMENT_TIMEOUT_MS` | 5000 | Per HTTP call |
| `FUNDING_TOKEN_TIMEOUT_MS` | 5000 | Per token request |
| `FUNDING_STEP_LEASE` | 60 s | Above the longest step: two attempts of token fetch plus call, 2 × (5 s + 21 s) = 52 s (a Reserve that meets `UNAUTHENTICATED` once), and two payment calls; boot refuses less |
| Backoff | 0.5 s doubling, cap 60 s, full jitter | Per request |
| `FUNDING_RESERVE_DEADLINE` | 2 min | Business deadline of the reserve step |
| `FUNDING_DISBURSE_DEADLINE` | 15 min | Then `NEEDS_ATTENTION`, never compensation |
| `FUNDING_RESERVE_RESOLUTION_LIMIT` | 12 h | Reserve deadline + resolution limit + 1 h (backoff cap and a lease) must stay below capacity's key retention (24 h); boot refuses otherwise |

### Events and observability

The outbox rows (`FundingRequestReceived`, `FundingRequestCompleted`, `FundingRequestRejected`,
`FundingRequestFailed`, `FundingRequestNeedsAttention`) commit with the transition. The relay
that publishes them to `funding.events.v1` comes after the MVP cut; until then the rows are the
seam, as FR-13 was on `main`. Metrics: requests by final state, step attempts by step and
class, requests per state, age of the oldest request per non-terminal state. Alerts:
`FundingNeedsAttention` (any), `FundingCompensationStuck` (15 min),
`FundingReserveUnresolved` (1 h). Trace context crosses the gRPC hop in metadata and the payment
call in headers; each step attempt is a span linked to the request's trace.

## Consequences

- Funding is eventually complete. A client polls `GET /v1/funding-requests/{id}`.
- Capacity can be held longer than the business needed while an outcome is unknown. That cost
  is accepted and visible (metrics and alerts), because the alternative loses money.
- The orchestrator is a transition table, tested as pure code, plus a driver loop. Adding a
  step means a new state, a new key and new rows in the table.
- Whether capacity answers `release-exceeds-remaining` (and not a zero-amount success) to a
  final release of a fully released reservation is a fact to prove, not assume: the system test of acceptance criterion FS-11 tests it
  against the real capacity image.

## Alternatives rejected

- **Temporal** (owner decision, recorded with reasons): another stateful cluster and its own
  database to run in kind and production; workflow-code determinism and versioning rules for a
  three-step flow; it would hide the mechanism this branch exists to show. Revisit with many
  workflow types, long human waits or workflow versioning needs.
- **Choreography through Kafka events.** No component would own the flow or its timeouts, and
  capacity would have to react to funding events. A reservation must be confirmed before
  money moves, which is a request and an answer.
- **Commands through the outbox and Kafka** (funding writes a `Reserve` command, capacity
  replies with an event). Same guarantees as the idempotent gRPC call, plus a command consumer
  and a reply topic in capacity, and higher latency.
- **Two-phase commit or XA across funding, capacity and the rail.** The rail takes part in
  no transaction, and locks would be held across the network.
- **Capacity calling the rail inside its reserve transaction.** An external call under the
  program row lock, which ADR 006 rules out.
- **Compensating on a disbursement timeout.** Under-reserves when the money did leave.
