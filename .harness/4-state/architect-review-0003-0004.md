# Architect review — lanes 0003 & 0004

Reviewer: architect (subagent) · Date: 2026-02-05 (session time)
Method: read-only inspection of main before the 0003 fixes (lane 0003; fixes in 0a0961e) and branch
`worktree-agent-ae0ecf817fc70646c` @ 4eda209 (lane 0004, read via `git show`).
Baseline run (no containers): the five 0003 unit/contract test files pass — 26/26 tests
(`vitest` exit 0). Container tests (kafka/fault) were not run; mutation probes were not
executed because the review mandate forbids editing source, so exact mutations to run later
are stated instead.

---

## Lane 0003 — Treasury ingest (before the fixes in 0a0961e)

**Verdict: APPROVE** — 0 MAJOR · 3 MINOR · 3 NOTE

### Findings

**MINOR-1 · Tenant ownership is not checked on the ProgramLimitSet create path.**
- Evidence: `src/capacity/application/use-cases/apply-treasury-event/apply-treasury-event.ts:67-72`
  (`createIfMissing` inserts under the message tenant, then `lockForUpdate` locks that row;
  there is no lookup of the program id under other tenants before applying).
- Violation: PRD §9 line 401 — "The consumer rejects a message whose tenantId does not own the
  program." `repay` (same file :128-129) and `reconcile-program` (:63-65) do reject via
  tenant-scoped reads; only the limit-set path is open.
- Scenario: program `prg` exists under `bank-a`; a `ProgramLimitSet` arrives with
  `tenantId=bank-b, programId=prg` and a key of `bank-b:prg` (the key check in
  `treasury-handler.ts:66-72` only compares the key to the message body, so it passes).
  `createIfMissing` inserts `(bank-b, prg)` and the limit is applied to a new parallel
  program instead of being rejected.
- Fix: before `createIfMissing`, read the program id across tenants and throw
  `PermanentError('tenant-mismatch', …)` when it exists under a different tenant (or document
  the deliberate create-on-mismatch decision in an ADR).

**MINOR-2 · No reconciliation staging table; the ADR that justifies it does not exist.**
- Evidence: `src/capacity/adapters/out/postgres/migrations/0003_treasury.sql:1-3` — "plans its
  diff in memory … (ADR 008), so no staging table is created". `docs/adr/` contains no 008, and
  `specs/0003-treasury-ingest/tasks.md` T5 is ticked with the words "staging table"; T8
  ("ADRs 007 and 008") is unticked. `tools/simulator/messages.ts:89` also cites the missing
  ADR 007.
- Violation: PRD §8 line 332 ("loads the snapshot into a staging table"); task proof marker
  claims a staging table the code does not have.
- Mitigating fact: correctness is preserved by planning in memory outside the lock and
  re-checking `version` under the lock (`reconcile-program.ts:61-78, 97-98`), so this is a
  spec-conformance/documentation defect, not a money/concurrency defect.
- Fix: write ADR 008 (and 007) or implement the staging table; align the T5 wording and proof
  marker with what actually shipped.

**MINOR-3 · A stale snapshot with an invalid payload is DLQ'd instead of skipped.**
- Evidence: `reconcile-program.ts:59` (`this.snapshotOf(message)` — duplicate invoice ids,
  zero outstanding amounts, size cap) runs before the stale check at :67-68.
- Violation: AC-09 / PRD §8 CP-3 step 3 and case table row 1 ("Snapshot seq ≤ treasury_seq →
  Skip as stale"). A stale snapshot that is oversized or lists an invoice twice throws
  `snapshot-too-large`/`invalid-snapshot` and is parked in the DLQ; `make dlq-replay` then
  re-parks it forever because it is still stale.
- Fix: perform the duplicate/seen and stale checks before `snapshotOf`'s semantic validation
  (a size guard may stay first as a resource limit, but then the stale-precedence decision must
  be written down).

**NOTE-1 · Consumer boot has no retry when Kafka is down.**
- Evidence: `consumer-runner.ts:63-65` — `producer.connect()`/`consumer.connect()` throw out
  of `start()`; the pause-and-backoff machinery (:104-158) only exists after `run()`.
  A worker booting during a Kafka outage fails instead of retrying.

**NOTE-2 · AC-11 test asserts only the first of two DLQ'd records.**
- Evidence: `test/kafka/treasury-consumer.kafka.test.ts:89-99` reads 2 parked records but
  checks headers/body only of `parked[0]`. The second poison (schema-invalid `ProgramLimitSet`)
  is asserted only indirectly by the offset advancing; its `x-error-code` header is unverified.

**NOTE-3 · Reconciliation overwrite SQL has no tenant/program guard.**
- Evidence: `treasury.repository.ts:122-141` — `UPDATE reservation … WHERE r.id = v.id`.
  Safe today because the ids come from the tenant-scoped `listForProgram` under the program
  lock, but a `tenant_id = … AND program_id = …` predicate would be defense-in-depth.

### Test audit — does each test prove its AC?

| AC | Test | Proves? | Mutation that would expose broken code |
| --- | --- | --- | --- |
| AC-07 | `treasury-consumer.kafka.test.ts:104-159` | Yes — asserts `available=0`, `overLimitBy=620000`, reserve refused `program-over-limit`, release still succeeds, 2 `LIMIT_SET` ledger rows. | Make `applyChange` skip `status` (SUSPENDED) or make `release` not decrement `reserved_minor` — the release/reserved assertions fail. Make `availableMinor` return a negative floor — line 132 fails. |
| AC-08 | `reconcile.int.test.ts:145-293` (3 tests) | Yes — keep-unseen, HOLD-seen, RELEASE-seen and fallback legs are all exercised against a real DB, with `expectI1` checks. | Change `treasuryHasSeen` to always keep only-ours → HOLD test (:197) fails; change `reserved_minor` update to ignore `keptUnseen` → first test's `43100000` (:185) fails. |
| AC-09 | `treasury-consumer.kafka.test.ts:161-196` + `reconcile.int.test.ts:436-462` | Yes — 4 stale messages skipped/logged/committed, program row unchanged, `treasury_seq` still 42. | Remove the `seq <= program.treasurySeq` guard → `programRow` changes, :185 fails. |
| AC-10 | `treasury-consumer.kafka.test.ts:46-75` | Yes — redelivery commits offset 2, broker offset agrees, ledger/outbox/inbox counts unchanged. | Make `PgInboxStore.claim` always return true → second delivery appends a second ledger row, :60 fails. |
| AC-11 | `treasury-consumer.kafka.test.ts:77-102` | Yes — two poison records then a good one; offset advances by 3, DLQ has the raw bytes with `x-error-*` headers, good record applied. | Classify `ZodError` as transient → offset never reaches `before+3`, `waitFor` times out. |
| AC-12 | `fx.int.test.ts:64-114` | Yes — stale rate → 422 `fx-rate-unavailable` and nothing reserved; fresh rate converts; late older rate loses. | Remove the `notBefore`/`FX_MAX_AGE` filter from `FxRateReader.latest` → old rate accepted, :74 fails. |
| AC-14 | `reconcile.int.test.ts:295-331` + `policy.test.ts:47-57` | Yes — 1-minor-unit diff leaves reservation and ledger untouched and logs `within-tolerance`. | Change tolerance comparison to strict `<` → diff of exactly 1 is treated as drift, ledger gains `RECON_ADJUST`, :318 fails. |
| AC-15 | `reconcile.int.test.ts:333-433, 497-525` + `policy.test.ts:65-131` | Yes — invoice-diff overwrite, beyond-tolerance overwrite, adoption with `origin=TREASURY`, size-cap refusal all asserted with ledger/outbox/`expectI1`. | Skip `overwrites` when invoice differs → :354-359 fails; skip `insertMany` → :428 fails; remove the size check → :514 fails. |

The 0003 container suite is well targeted; the only weak assertion is NOTE-2.

---

## Lane 0004 — Production polish (branch `worktree-agent-ae0ecf817fc70646c` @ 4eda209)

**Verdict: CHANGES REQUIRED** — 2 MAJOR · 0 MINOR · 3 NOTE

### Findings

**MAJOR-1 · The branch's worker bootstrap does not run the lane 0003 treasury consumer.**
- Evidence: `git merge-base main worktree-agent-ae0ecf817fc70646c` = `b638a54` (pre-0003);
  main has the consumer before the fixes. On the branch,
  `src/platform/bootstrap/worker.ts:24-76` defines `startWorkerComponents` with only the
  outbox relay and the two jobs; `src/platform/bootstrap/start.ts:60-64` calls only that;
  `git grep 'TreasuryConsumerRunner|createTreasuryConsumer|consumer.check'` over the branch's
  `src/` is empty, and the diff removes the `kafka` readiness check.
- Violation: PRD §8 components — the worker role is "Treasury consumers (capacity and FX
  topics), outbox relay, scheduled jobs". A worker built from this branch consumes nothing;
  AC-07..AC-15 silently regress the moment the branch merges.
- Fix at merge (before gate): keep `createTreasuryConsumer` from main's `worker.ts` alongside
  `startWorkerComponents`, restore the consumer readiness check in `start.ts`, and order
  shutdown as consumer → relay/jobs → pool. Add a fault test that runs role `all` and asserts a
  treasury message is still ingested while the relay is active, so a merge that drops the
  consumer fails.

**MAJOR-2 · NFR-07's message leg is neither implemented nor tested.**
- Evidence: `test/fault/shutdown.fault.test.ts:16` starts `role: 'api'` only, so no consumer
  or relay exists in the test. The AC says "in-flight requests **and messages** … offsets
  commit … within 25 s"; the test proves only the HTTP request leg (readiness 503, in-flight
  reserve completes, pool closes). On the consumer side,
  `src/capacity/adapters/in/kafka/consumer-runner.ts:96-102` (main) `stop()` sets
  `stopping`, wakes the backoff waiter and immediately disconnects; it never awaits the
  in-flight `process`, so a message mid-transaction gets its offset commit attempted against a
  disconnected consumer and the commit fails.
- Violation: NFR-07 (0004 spec restates it as the shutdown AC). The proof marker
  `test/fault/shutdown.fault.test.ts#NFR-07` overstates what the test proves.
- Fix: make `TreasuryConsumerRunner.stop()` wait for the in-flight `process` to finish (and
  commit) before disconnecting; add a shutdown fault test with role `worker` (or `all`) that
  holds a treasury message in flight behind a row lock, sends SIGTERM, releases the lock and
  asserts the offset was committed and the pool closed within 25 s.

**NOTE-1 · Timed-out Kafka sends are not cancelled and can duplicate an entire batch.**
- Evidence: `event-publisher.ts:33-49, 68-97` — `withTimeout` only races; the underlying
  `producer.send` is not aborted. On timeout the relay `reset()`s the producer and the next
  cycle resends the whole batch, while the first send can still land. Consumers must therefore
  dedup by `event-id` and order by `program_seq` exactly as PRD §8 requires; the relay test
  does not exercise this path.

**NOTE-2 · Batch ordering is (tenant, program, seq), so one busy program can delay others.**
- Evidence: `outbox-relay.repository.ts:60-66` — `ORDER BY tenant_id, program_id,
  program_seq, id LIMIT n`. With `batchSize` 200, a program with a large backlog holds the
  head of every batch until it drains, delaying the first event of other programs. Correct per
  FR-13 (per-program order), but worth documenting as the hot-program behaviour (NFR-04).

**NOTE-3 · Lease row deletion is not self-healing.**
- Evidence: `outbox-relay.repository.ts:29-40` — `acquireLease` is a single `UPDATE … WHERE
  id = 'outbox-relay'`; if the seeded row (0002 migration) were ever deleted, every worker
  would stay on standby forever because nothing re-inserts it. No code path deletes the row, so
  this is a resilience note, not a live defect.

### Fault-test mutation analysis (exact probes to run later)

All probes require editing source, which this review is forbidden to do; run them against the
merged tree before the gate.

1. NFR-06 Kafka-down leg (`outage.fault.test.ts:55-81`):
   - Probe A: make `reserve` touch Kafka synchronously (or throw when the broker is down) →
     the first `expect(created.status).toBe(201)` fails.
   - Probe B: make the relay mark rows published before `publisher.publish` → `unpublished()`
     is 0 while Kafka is down and the `outbox_lag 3` wait times out.
   - Probe C: make the relay stop retrying after the first publish failure → the
     `outbox drained` wait times out after `kafka.start()`.
2. NFR-06 DB-down leg (`outage.fault.test.ts:83-97`):
   - Probe: remove the `db` readiness check (or make the problem filter return 500 instead of
     503) → `ready().status === 503` or `response.status === 503` fails.
3. NFR-07 (`shutdown.fault.test.ts:42-73`):
   - Probe: remove `ops.markDraining()` from `startApp.close` → the readiness-503 wait fails.
   - Probe: make `app.close()` kill in-flight connections instead of draining → `answer.status`
     is not 201.
   - Probe: never close the pool → `serviceConnections() === 0` fails.
   - Gap probe (would NOT be caught today, exposing MAJOR-2): add a worker-role shutdown test;
     then make `TreasuryConsumerRunner.stop()` disconnect without waiting — the offset of an
     in-flight message is never committed and the new test fails.
4. FR-13 relay fencing (`outbox-relay.kafka.test.ts:92-126`):
   - Probe: make `markPublished` ignore owner/epoch (mark by ids only) → `stale.runOnce()`
     returns `published` instead of `{state:'fenced', sent:3}`, :116 fails.
5. FR-13 per-program order (`outbox-relay.kafka.test.ts:56-90`):
   - Probe: drop `program_seq` from `fetchUnpublished` ORDER BY → per-program `seq` arrays
     are not `[1..6]`, :78 fails.

---

## Verdicts

- **Lane 0003: APPROVE** (0 MAJOR · 3 MINOR · 3 NOTE). The consumer, use cases and tests
  implement AC-07..AC-12/14/15 with correct lock order, bigint money handling, inbox-based
  idempotency and meaningful fault coverage; the MINORs are targeted fixes that do not require
  re-opening the lane's core design.
- **Lane 0004: CHANGES REQUIRED** (2 MAJOR · 0 MINOR · 3 NOTE). The outbox relay lease/epoch
  fencing and the FR-13/NFR-06 tests are sound, but the branch's worker no longer runs the
  treasury consumer (merge hazard) and NFR-07's message/offset leg is unimplemented and
  untested.
