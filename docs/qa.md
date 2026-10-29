# QA test cases

Manual and scripted acceptance checks against the running stack: every HTTP endpoint, every
treasury message type, and what each one must leave behind in PostgreSQL, on Kafka and in the
metrics. The automated tests (`make test`) prove the same rules in isolation; this page is
for a person who wants to see them on a live system, in Swagger, the AsyncAPI page or a
terminal.

**Last run:** 2026-10-29, `make qa` → `TOTAL pass=103 fail=0`, stack from `make install`.

## How to run

```bash
make install     # or: make up && make seed — see the FX note below
make qa          # runs every case on this page (~2 min), prints PASS/FAIL per check
```

`make qa` ([tools/qa/run.sh](../tools/qa/run.sh)) creates a fresh program through Kafka on
every run (`prg_qa_<unix time>`), so it can be repeated on the same stack; the exit code is
the number of failed checks. Treasury messages that the simulator has no scenario for (FX,
snapshots, malformed and cross-tenant records) are published by
[tools/qa/publish.ts](../tools/qa/publish.ts) through the simulator's own message builders.

> **FX rates from `make seed` are valid for 24 hours.** Run `make seed` again on the day you
> test or demo, or every cross-currency reservation fails with `422 fx-rate-unavailable`.

### By hand in Swagger UI

1. Open <http://localhost:9464/docs> (served offline from the ops port).
2. **Authorize** → `localOAuth`. The client id is the bank (`bank-a`, `bank-b`, `bank-c`), any
   secret works. Untick `capacity:write` to get a read-only token.
3. Pick an operation → **Try it out**. Bodies and `Idempotency-Key` are pre-filled from the
   zod schemas → **Execute**.

### The Kafka contract in the browser

Open <http://localhost:9464/docs/asyncapi> (`make docs-events`). The sidebar lists the servers,
the five topics (treasury input, its two DLQs, `capacity.events.v1`) and every message; each
message shows its headers, Kafka key, payload schema and an example. Compare what you see on
the wire with it: `make events` prints every outbound event as `headers | key | value`, and
`npm run contracts:events -- --key bank-a:<program>` checks them against `contracts/` for you
(QA-72).

### Kafka in the browser (Kafka UI)

<http://localhost:8080> (`make kafka-ui`) is [Kafka UI](https://github.com/kafbat/kafka-ui)
(`kafbat/kafka-ui`), pointed at the stack's broker. It is in the `observability` compose profile:
`make up-all` starts it together with Prometheus, Grafana and Jaeger. The contract page above
says what *should* be on a topic; Kafka UI shows what *is* there, and can put a record on one.
No login, and it can produce and delete: local stack only.

What it shows:

| Where | What to look at |
| --- | --- |
| **Topics** | Six topics, 6 partitions each: `treasury.capacity.v1`, `treasury.fx-rates.v1` (input), their `.dlq` twins, `capacity.events.v1` (output) and `capacity.events.v1.dlq` (created for symmetry, the service never writes it) |
| Topic → **Messages** | Every record with partition, offset, timestamp, key, headers and the JSON value. Filter by key or text, seek by offset or time |
| **Consumers** | `program-capacity-treasury` is the worker: state `STABLE`, lag per partition of both treasury topics. `contract-check-*` groups are left by `npm run contracts:events` and are harmless |
| **Brokers** | One KRaft broker, the listeners from `deploy/compose.yaml` |

How to check the service with it:

1. **An event per change.** Reserve something in Swagger UI, then **Topics →
   `capacity.events.v1` → Messages**, newest first. Expect a `ReservationCreated` with key
   `bank-a:prg_grand_usd`, headers `event-type`, `event-id`, `program-seq`, and `seq` one
   above the previous event of that key. Every event of one key sits on one partition.
2. **Treasury input is applied.** **Topics → `treasury.capacity.v1` → Produce Message**, any
   partition, key `bank-a:prg_ui_1`, value:

   ```json
   {"messageId":"ui-prg_ui_1-1","schemaVersion":1,"tenantId":"bank-a","programId":"prg_ui_1",
    "seq":1,"occurredAt":"2026-10-29T10:00:00.000Z","type":"ProgramLimitSet",
    "payload":{"creditLimit":{"value":"5000000.00","currency":"USD"},"status":"ACTIVE"}}
   ```

   Within a second `GET /v1/programs/prg_ui_1/capacity` (bank-a) shows the 5,000,000.00 USD
   limit and `treasurySeq: 1`, and `capacity.events.v1` has a `ProgramCapacityChanged` with
   `cause: limit-set`. The other examples on the AsyncAPI page work the same way. Use a new
   `programId` for each run: a `seq` the program has already seen is not applied again.
3. **A duplicate is applied once.** Produce the same record again. No second event appears and
   the consumer lag returns to 0: the inbox deduplicates by `messageId`.
4. **A broken record is parked.** Produce `{"this is": not json` with key
   `bank-a:prg_grand_usd` to `treasury.capacity.v1`. It lands in `treasury.capacity.v1.dlq`
   with headers `x-error-code: schema-invalid`, `x-error-message`, `x-original-topic`,
   `x-original-partition`, `x-original-offset`; `dlq_messages_total` rises on `:9465/metrics`
   and the worker keeps consuming (lag 0).
5. **The worker keeps up.** **Consumers → `program-capacity-treasury`** during `make demo` or
   `make qa`: lag grows for a moment and returns to 0. Lag that stays above 0 means the worker
   is down or stuck (`make logs`).

Seeded programs: `bank-a` owns `prg_grand_usd` (USD 10,000,000) and `prg_aegean_eur` (EUR);
`bank-b` owns `prg_gulf_aed` (AED) and `prg_kuwait_kwd` (KWD, 3 decimals); `bank-c` owns
`prg_atlas_usd` and `prg_nordic_eur`.

### By hand in a terminal

```bash
TOKEN=$(make -s token TENANT=bank-a)                          # read + write
RO=$(make -s token TENANT=bank-a SCOPES="capacity:read")      # read only
API=localhost:3000
P=prg_grand_usd

curl -s $API/v1/programs/$P/capacity -H "authorization: Bearer $TOKEN" | jq
```

Side effects, used in the "Check also" columns below:

```bash
# SQL (the stack's database)
docker compose -f deploy/compose.yaml exec -T postgres psql -U capacity -d capacity -c "<query>"

# outbound events: headers | key | value (Ctrl-C stops)
make events

# outbound events checked against contracts/ (schemas, headers, key, gap-free seq)
npm run contracts:events -- --key bank-a:<program>

# a dead-letter topic, with the x-error-* headers
docker compose -f deploy/compose.yaml exec -T kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic treasury.capacity.v1.dlq --from-beginning \
  --formatter-property print.headers=true --timeout-ms 8000

# metrics: api (HTTP RED) and worker (outbox, DLQ, invariants)
curl -s localhost:9464/metrics | grep http_requests_total
curl -s localhost:9465/metrics | grep -E 'outbox_|dlq_|invariant_|programs_over_limit'
```

Treasury input from a terminal: `npm run simulate -- <scenario> --tenant bank-a --program <id>
--seq <n>`; scenarios are `limit-cut`, `repayments`, `late-snapshot`, `duplicate-delivery`,
`out-of-order`, `poison-message`, `fx-stale`. Each program's `seq` must grow, so read
`treasurySeq` from the capacity response first and continue from it.

## A. Ops port (:9464 api, :9465 worker)

| ID | Case | Steps | Expected | Check also |
| --- | --- | --- | --- | --- |
| QA-01 | Liveness and readiness | `GET :9464/health/live`, `GET :9464/health/ready` | `200`; ready body `{"status":"up","db":"up"}` | Ready turns `503` when PostgreSQL is down or the schema is behind the latest migration |
| QA-02 | Metrics split by role | `GET :9464/metrics`, `GET :9465/metrics` | api exposes `http_requests_total`; worker exposes `outbox_lag`, `outbox_oldest_unpublished_age_seconds`, `invariant_mismatch_programs`, `programs_over_limit` | `dlq_messages_total` appears on the worker after the first dead letter |
| QA-03 | Swagger UI is local and ops-only | `GET :9464/docs`, `GET :9464/docs/swagger-ui-bundle.js`, `GET :3000/docs` | `200`, `200`, `404` | Works with the network off: no CDN requests |
| QA-04 | CORS only for the docs origin | `OPTIONS :3000/v1/…/reservations` with `Origin: http://127.0.0.1:9464`, then with `Origin: http://evil.example` | `204` with `access-control-allow-origin`; the second has no allow-origin header | Origins come from `CORS_ORIGINS` |
| QA-05 | AsyncAPI page is local and ops-only | `GET :9464/docs/asyncapi`, `GET :9464/docs/asyncapi-ui.js`, `GET :9464/docs/asyncapi.json`, `GET :3000/docs/asyncapi` | `200`, `200`, a 3.1.0 document with the channels `treasury.capacity.v1`, `treasury.fx-rates.v1`, both `.dlq` topics and `capacity.events.v1`, then `404` | The page links to Swagger UI and back; the viewer is served by the service, no CDN |

## B. Authentication and tenants

| ID | Case | Steps | Expected | Check also |
| --- | --- | --- | --- | --- |
| QA-10 | No token | `GET /capacity` without `authorization` | `401`, `type` ends in `unauthorized` | |
| QA-11 | Garbage token | `authorization: Bearer not-a-jwt` | `401` | |
| QA-12 | Scope enforcement | Read-only token: `POST /reservations`; then `GET /capacity` | `403 forbidden`; `200` | No row in `reservation` or `idempotency_key` |
| QA-13 | Tenant isolation | `bank-b` token reads a `bank-a` program | `404 not-found`, not `403` | A caller cannot learn that another bank's program exists |

## C. Capacity read

| ID | Case | Steps | Expected | Check also |
| --- | --- | --- | --- | --- |
| QA-20 | Fresh program | `GET /v1/programs/{id}/capacity` | `limit`, `reserved: "0.00"`, `available = limit`, `overLimitBy: "0.00"`, `version`, `treasurySeq` | Amounts are decimal strings in the program currency, never floats |
| QA-21 | Conditional GET | Repeat with `If-None-Match: <ETag>` | `304`, empty body | ETag is the program `version`; any change makes a new one |
| QA-22 | Unknown program | `GET /v1/programs/prg_does_not_exist/capacity` | `404 not-found` | |

## D. Reserve

| ID | Case | Steps | Expected | Check also |
| --- | --- | --- | --- | --- |
| QA-30 | Reserve | `POST /reservations` `{"invoiceId":"INV-1","amount":{"value":"1000.00","currency":"USD"}}` with `Idempotency-Key: k1` | `201`, `reservationId`, `capacity.reserved` up by 1000.00 | `reservation`: `ACTIVE`, `amount_minor=100000`, `origin=API`. `program.reserved_minor` +100000. `ledger_entry`: `RESERVE`, `delta_reserved_minor=100000`, `reserved_after`, `actor`. `idempotency_key.status_code=201`. `outbox_event` `ReservationCreated` with the next `program_seq`, `published_at` set within ~1 s; the event on `capacity.events.v1`, key `bank-a:<program>` |
| QA-31 | Replay with the same key | Same request, same `k1` | Same `201`, same `reservationId` | Still one `reservation` row, one ledger entry, one outbox event |
| QA-32 | Same key, other body | `k1` with amount 999.00 | `422 idempotency-key-mismatch` | Nothing written |
| QA-33 | Natural key (no or new key) | Same invoice and amount, new key; then same invoice, amount 999.00 | `200` with the existing reservation; then `409 reservation-conflict` | One reservation per invoice and program. A fully `RELEASED` invoice also answers 409 |
| QA-34 | Cross-currency, rounding up | Invoice EUR 100.01 on a USD program (EUR/USD 1.08) | `201`, `reservedAmount` USD 108.02 (108.0108 rounded **up**), `fx.rate` 1.0800000000 | `reservation`: `invoice_currency=EUR`, `invoice_amount_minor=10001`, `amount_minor=10802`, `fx_rate` stored |
| QA-35 | Over available | Amount above `available` | `422 insufficient-capacity` | `idempotency_key.status_code=422`: the refusal is stored, so a replay gets the same 422 |
| QA-36 | Validation | Amount `0.00`, `-5.00`, `1.001`, currency `XXX`, missing `invoiceId`, unknown field, non-JSON | `400 validation-error` each | The key is **not** stored, so the corrected request may reuse it |
| QA-37 | No FX rate | Invoice in GBP (no GBP rate seeded) | `422 fx-rate-unavailable` | |
| QA-38 | Oversized amount | 40-digit amount | `400`, never `500` | |

## E. Release

| ID | Case | Steps | Expected | Check also |
| --- | --- | --- | --- | --- |
| QA-40 | Partial release | `POST /reservations/{id}/releases` `{"releaseRef":"pay-1","amount":{"value":"400.00","currency":"USD"},"reason":"REPAID"}` | `200`, `reservationStatus: PARTIALLY_RELEASED`, `releasedAmount` 400.00, `remainingAmount` 600.00 | `reservation_release` row (`pay-1`, `REPAID`, 40000). `ledger_entry` `RELEASE -40000`. Outbox `ReservationReleased` |
| QA-41 | Same `releaseRef`, same amount | Repeat QA-40 without a key | `200`, original result | Still one `reservation_release` row |
| QA-42 | Same `releaseRef`, other amount | `pay-1` with 1.00 | `422 release-ref-mismatch` | Nothing written |
| QA-43 | Over remaining | 700.00 when 600.00 remains | `422 release-exceeds-remaining` | |
| QA-44 | Wrong currency | Release in USD on an EUR invoice | `400`, detail names the invoice currency | Releases are in the invoice currency |
| QA-45 | Release the rest | Omit `amount` | `200`, `RELEASED`, `remainingAmount` 0.00 | The final release takes the exact remainder, so no cent is left over from rounding |
| QA-46 | Release a released reservation | Another release | `422 release-exceeds-remaining` | |
| QA-47 | Cancel | `{"releaseRef":"cancel","reason":"CANCELLED"}` | `200`, `RELEASED` | |
| QA-48 | Back to zero | After QA-45 and QA-47 | `capacity.reserved` 0.00 | `program.reserved_minor = 0` |

## F. Queries and ledger

| ID | Case | Steps | Expected | Check also |
| --- | --- | --- | --- | --- |
| QA-50 | Get reservation | `GET /reservations/{id}` | `200` with `releases[]` | |
| QA-51 | Unknown or malformed id | Random UUID; `not-a-uuid` | `404` both | A malformed id is not a 500 |
| QA-52 | Cursor pagination | `GET /reservations?limit=1`, then `&cursor=<nextCursor>` | One item each; the last page has `nextCursor: null` | The cursor is opaque; do not build it by hand |
| QA-53 | Filter and bounds | `?status=RELEASED`; `?limit=0` | Only `RELEASED` items; `400` | |
| QA-54 | Ledger | `GET /ledger` | Oldest first, starting with `LIMIT_SET` | The same kinds in the same order as `select kind from ledger_entry … order by id` |
| QA-55 | Ledger across tenants | `bank-b` token | `404` | |

## G. Treasury input over Kafka (`treasury.capacity.v1`)

Treasury owns the credit limit; the API can only reserve and release against it.

| ID | Case | Steps | Expected | Check also |
| --- | --- | --- | --- | --- |
| QA-60 | Limit cut below reserved | Reserve 800.00, then `simulate limit-cut --new-limit 500.00` | Capacity `limit` 500.00, `overLimitBy` 300.00, `available` 0.00; a new reserve gets `422 program-over-limit` | `ledger_entry` `LIMIT_SET` with `delta_limit_minor`. One `inbox_message` per message id. Existing reservations are never cut. The worker gauge `programs_over_limit` counts programs in this state |
| QA-61 | Duplicate delivery | `simulate duplicate-delivery` (the same message twice) | One effect | `program.version` up by one; one `inbox_message` row |
| QA-62 | Out of order | `simulate out-of-order` (seq n+1 then n) | The late, older `seq` is skipped | `program.treasury_seq` keeps the highest; limit from the newest |
| QA-63 | Repayments | `simulate repayments --invoice <id> --amount 800.00` (two `RepaymentReceived`) | Reservation `RELEASED` with two releases | Releases carry the message's `releaseRef`; outbox `ReservationReleased` |
| QA-64 | Poison message | `simulate poison-message` (a broken record followed by a good one) | The good one is applied; the partition does not stall | Records on `treasury.capacity.v1.dlq` with `x-error-*` headers; `dlq_messages_total{reason="schema-invalid"}` up. Replay with `make dlq-replay TOPIC=treasury.capacity.v1.dlq` |
| QA-93 | Suspend and resume | `ProgramLimitSet` with `status: SUSPENDED`, then `ACTIVE` | While suspended: reserve `422 program-suspended`, release still `200`. After `ACTIVE`: reserve `201` | `program.status` |
| QA-94 | Key names another tenant | Record keyed `bank-b:<program>` whose body says `bank-a` | Rejected, no effect | DLQ with `reason="tenant-mismatch"`; bank-a's limit unchanged |
| QA-95 | Repayment for an unknown invoice | `RepaymentReceived` for `INV-NOPE` | Dead-lettered | `dlq_messages_total{reason="unknown-reservation"}` up |
| QA-96 | Same program id in two banks | `ProgramLimitSet` for `bank-b` with a `bank-a` program id | Two separate programs | `program` rows `(bank-a, USD)` and `(bank-b, EUR)`; each bank reads only its own |

## J. FX rates over Kafka (`treasury.fx-rates.v1`)

| ID | Case | Steps | Expected | Check also |
| --- | --- | --- | --- | --- |
| QA-90 | New rate | Publish EUR/USD 1.10, reserve EUR 100.00 on a USD program | `201`, `reservedAmount` 110.00, `fx.rate` 1.1000000000 | `fx_rate` row; the reservation keeps the rate it used even after the next rate arrives |
| QA-91 | Stale rate | Publish GBP/USD with `asOf` 30 h ago, reserve in GBP | `422 fx-rate-unavailable` | The rate is stored, but it is too old to use (24 h) |
| QA-92 | Malformed FX message | Record without a payload | Dead-lettered | `treasury.fx-rates.v1.dlq`; `dlq_messages_total{topic="treasury.fx-rates.v1",reason="schema-invalid"}` up |

## K. Reconciliation snapshots (`ProgramReconciled`)

A snapshot is treasury's full view of one program. Treasury wins where it has an opinion;
where it is silent about something it should know, the larger exposure is kept (mode `HOLD`,
the default). `platformWatermark` is the last platform event treasury had applied, so a
reservation newer than it is "not seen yet", not "missing".

Setup: program with limit 1000.00 and reservations R1 100.00, R2 200.00, R3 50.00; the
watermark covers R1 and R2 but not R3.

| ID | Case | Snapshot content | Expected | Check also |
| --- | --- | --- | --- | --- |
| QA-100 | Limit | `creditLimit` 1500.00 | Capacity `limit` 1500.00 | `ledger_entry` `LIMIT_SET` |
| QA-101 | Within tolerance | R1 at 100.01 | Ours kept (100.00) | Difference ≤ `RECON_TOLERANCE_MINOR` (1 cent) is logged as tolerated, not changed |
| QA-102 | Only treasury knows it | T1 50.00 | Adopted | `reservation` `origin=TREASURY`, `ACTIVE`, 5000 |
| QA-103 | Ours missing, covered by the watermark | R2 absent | Kept (`HOLD`) | Drift `HELD` in the event; in `RELEASE` mode it would be released |
| QA-104 | Ours newer than the watermark | R3 absent | Kept, no drift | Treasury simply has not seen it yet |
| QA-105 | Drift event | — | Outbox `ReconciliationDriftDetected` with `mode`, `drifts[]` (`ADOPTED`, `HELD`), `driftCount`, `truncated` | At most 100 drifts in one event; `driftCount` is the full number |
| QA-106 | Ledger and invariant | — | `RECON_ADJUST` entry for the change in reserved | `program.reserved_minor` = sum of open reservations |
| QA-107 | Real difference | Second snapshot: R1 at 90.00 | Treasury wins: R1 `PARTIALLY_RELEASED`, outstanding 90.00 | `amount_minor` stays 10000, `released_minor` becomes 1000; drift `ADJUSTED` |
| QA-108 | Old snapshot | Snapshot with a lower `seq` | Skipped | `program.version` and `treasury_seq` unchanged |
| QA-109 | Staging is cleaned | — | `reconcile_snapshot_row` has no rows for the program | Rows staged by a crashed run are swept after one hour |

## H. Outbound events (`capacity.events.v1`)

| ID | Case | Steps | Expected | Check also |
| --- | --- | --- | --- | --- |
| QA-70 | Events reach Kafka | Consume the topic, filter key `bank-a:<program>` | `ProgramCapacityChanged`, `ReservationCreated`, `ReservationReleased` | Key is `tenant:program`, so one program's events stay in order on one partition |
| QA-71 | No gaps, nothing stuck | `select program_seq, published_at from outbox_event where tenant_id=… and program_id=…` | `program_seq` 1, 2, 3 … with no gaps, every `published_at` set | Worker `outbox_lag` and `outbox_oldest_unpublished_age_seconds` near 0. Consumers drop duplicates by `messageId` and spot gaps with `programSeq` |
| QA-72 | Events match the published contract | `npm run contracts:events -- --key bank-a:<program>` for the main QA program and for the reconciliation program of section K (together: all four event types) | `violations=0`: every record validates against `contracts/json-schema/<type>.schema.json` and, strictly, has no field the contract leaves out; headers match the `CapacityEventHeaders` schema and the envelope; `seq` is gap-free from 1 | Without `--key` it checks the whole topic. The same check runs in `test/kafka/capacity-events.kafka.test.ts` |

## I. Invariants

| ID | Case | Steps | Expected | Check also |
| --- | --- | --- | --- | --- |
| QA-80 | Reserved adds up (I1, I5) | Compare `program.reserved_minor`, the sum of open reservations, and the sum of `ledger_entry.delta_reserved_minor` | All three equal | Query in [tools/qa/run.sh](../tools/qa/run.sh), section I |
| QA-81 | Ledger is append-only | `update ledger_entry set actor='x' where …` | `ERROR: ledger_entry is append-only` | A database trigger, not application code, refuses it |
| QA-82 | Invariant job | Worker metric | `invariant_mismatch_programs 0` | The job re-checks every program on a schedule |

## Not covered by `make qa`

These need a broken environment or concurrency, so they live in the automated suites
([testing.md](testing.md)):

- 50 concurrent reservations against room for 10 → exactly 10 (AC-01, integration).
- Two concurrent requests with one key → the second waits and gets the first's answer.
- PostgreSQL killed mid-transaction → rollback, `503`, key free (fault tests).
- Kafka down → the API keeps serving, the outbox grows and drains on recovery.
- Graceful shutdown: in-flight requests finish, the consumer commits, no message is lost.
- Load: `make load` (k6), latency numbers in the [README](../README.md).
