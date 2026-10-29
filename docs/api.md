# API tour

A hands-on walk through the REST API against the local stack. Every command below can be
pasted into a terminal after `make install` (or `make up && make seed`). Responses are shortened.

The full contract is [`contracts/openapi.yaml`](../contracts/openapi.yaml), generated from the
zod schemas in `src/capacity/adapters/in/http/`. The Kafka side (treasury input, DLQs and the
events the service publishes) is [`contracts/asyncapi.yaml`](../contracts/asyncapi.yaml); see
[section 7](#7-events-on-kafka).

## Easiest: Swagger UI

Open <http://localhost:19464/docs> (ops port, local only). Click **Authorize**, choose
`localOAuth`, keep client id `bank-a` (the client id becomes the tenant; `bank-b` and `bank-c`
also exist) and log in. Then open an endpoint, press **Try it out**: request bodies and the
`Idempotency-Key` are prefilled from the schema examples, and the request goes to the API on
port 13000. That works because the compose stack sets `CORS_ORIGINS` for the docs page and
`OAUTH_TOKEN_URL` for the login; both are unset by default, so production has neither.

The rest of this page does the same with curl.

## Endpoints

All business endpoints live under `/v1`, need a JWT, and are scoped to the token's tenant.

| Method and path | Scope | What it does |
| --- | --- | --- |
| `GET /v1/programs/{programId}/capacity` | `capacity:read` | Limit, reserved, available, over-limit amount |
| `POST /v1/programs/{programId}/reservations` | `capacity:write` | Reserve capacity for one invoice |
| `GET /v1/programs/{programId}/reservations/{reservationId}` | `capacity:read` | One reservation |
| `POST /v1/programs/{programId}/reservations/{reservationId}/releases` | `capacity:write` | Release all or part of a reservation |
| `GET /v1/programs/{programId}/reservations` | `capacity:read` | List reservations, cursor pagination |
| `GET /v1/programs/{programId}/ledger` | `capacity:read` | Ledger entries of the program, cursor pagination |

There is no endpoint to create a program or change a limit. Treasury owns limits and sends
them over Kafka (`ProgramLimitSet`); `make seed` does that for six demo programs.

Ops port (19464, never exposed through an ingress, no token): `/health/live`, `/health/ready`,
`/metrics`, `/docs` (Swagger UI), `/docs/asyncapi` (Kafka contract).

## 1. Get a token

The local identity provider is [mock-oauth2-server](https://github.com/navikt/mock-oauth2-server).
`make token` asks it for a client-credentials token. The client id becomes the tenant.

```bash
TOKEN=$(make -s token TENANT=bank-a)
```

## 2. Read capacity

```bash
curl -s localhost:13000/v1/programs/prg_grand_usd/capacity -H "authorization: Bearer $TOKEN"
```

```json
{
  "programId": "prg_grand_usd",
  "currency": "USD",
  "limit": "10000000.00",
  "reserved": "2410500.00",
  "available": "7589500.00",
  "overLimitBy": "0.00",
  "utilization": "0.2411",
  "version": 41,
  "treasurySeq": 1
}
```

Amounts are **decimal strings** at the currency's scale ("10000000.00" for USD, three
decimals for KWD), never JSON numbers, so no client loses precision.

## 3. Reserve

```bash
curl -s -X POST localhost:13000/v1/programs/prg_grand_usd/reservations \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -H "idempotency-key: $(uuidgen)" \
  -d '{"invoiceId":"INV-TOUR-1","amount":{"value":"125000.00","currency":"EUR"}}'
```

`201 Created`:

```json
{
  "reservationId": "0193…",
  "invoiceId": "INV-TOUR-1",
  "status": "ACTIVE",
  "invoiceAmount": { "value": "125000.00", "currency": "EUR" },
  "reservedAmount": { "value": "135000.00", "currency": "USD" },
  "fx": { "rate": "1.0800000000", "source": "treasury", "asOf": "…" },
  "capacity": { "limit": "10000000.00", "reserved": "2545500.00", "available": "7454500.00", "version": 42 }
}
```

The invoice is in EUR and the program in USD, so the amount is converted with the latest
treasury rate and **rounded up**. The rate is stored on the reservation.

## 4. Retry safely with `Idempotency-Key`

Send the same request again with the **same** key: you get the same `201` and the same
`reservationId`, and nothing is reserved twice. The key is optional but recommended for every
write; the stored answer is kept for at least 24 hours. Using the same key with a different
body returns `422 idempotency-key-mismatch`.

Without a key, the natural key (one reservation per invoice and program) still protects you.
A second request for the same `invoiceId` with the **same** amount returns `200` with the
existing reservation, so a retry that lost its key is still harmless. A different amount, or an
invoice whose reservation is already fully released, returns `409 reservation-conflict`.

## 5. Release

```bash
curl -s -X POST localhost:13000/v1/programs/prg_grand_usd/reservations/<reservationId>/releases \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -H "idempotency-key: $(uuidgen)" \
  -d '{"releaseRef":"repayment-1","amount":{"value":"50000.00","currency":"EUR"},"reason":"REPAID"}'
```

Omit `amount` to release the whole remainder. `releaseRef` identifies the repayment: the same
`releaseRef` with the same amount is a no-op that returns the original result; with a
different amount or reason it is `422 release-ref-mismatch`.

## 6. Errors

Every error is `application/problem+json` (RFC 9457) with a stable `type`:

```json
{
  "type": "https://errors.capacity.example/insufficient-capacity",
  "title": "Insufficient capacity",
  "status": 422,
  "detail": "…"
}
```

| Status | `type` (suffix) | When |
| --- | --- | --- |
| 400 | `validation-error` | Body, path or header fails the schema |
| 401 | `unauthorized` | Missing, expired or wrong-audience token |
| 403 | `forbidden` | Token lacks the scope |
| 404 | `not-found` | Program or reservation does not exist **for this tenant** |
| 409 | `reservation-conflict` | The invoice already has a reservation on other terms, or it is fully released |
| 413 | `payload-too-large` | Body over the size limit |
| 422 | `insufficient-capacity`, `program-over-limit`, `program-suspended`, `release-exceeds-remaining`, `fx-rate-unavailable`, `idempotency-key-mismatch`, `release-ref-mismatch` | Business rule refused the request, or a key/`releaseRef` was reused with another body |
| 503 | `service-unavailable` | Database or identity provider unreachable; safe to retry with the same key |

Another tenant's program answers `404`, not `403`, so a caller cannot even learn that it
exists.

## 7. Events on Kafka

Every committed change is published to `capacity.events.v1`. Downstream systems (treasury,
risk, notifications) build on these events instead of polling the API.

**Browse the contract:** <http://localhost:19464/docs/asyncapi> (`make docs-events`) is the
AsyncAPI 3.1 document rendered in the browser: every topic, message, header and Kafka key, with
an example of each message. It is served from the ops port with no network access, like Swagger
UI, and `/docs/asyncapi.json` is the raw document. The committed files are
[`contracts/asyncapi.yaml`](../contracts/asyncapi.yaml) and one JSON Schema (draft-07) per
message in [`contracts/json-schema/`](../contracts/json-schema/). All of it is generated from the
zod schemas the code uses (`src/capacity/application/shared/capacity-events.ts` and
`treasury-messages.ts`), so `make verify` fails when code and contract disagree.

**Watch them live:** `make events` follows the topic from the beginning and prints
`headers | key | value`. Kafka UI at <http://localhost:18080> (`make up-all`, then `make kafka-ui`) shows the same
records in a browser, with filters by key and the consumer lag ([checks](qa.md#kafka-in-the-browser-kafka-ui)).

| Event | When | Payload, besides `tenantId`, `programId`, `programSeq` |
| --- | --- | --- |
| `ReservationCreated` | `POST …/reservations` created a reservation (a natural-key replay does not) | The reservation as the API returns it: amounts, FX rate, `capacity` snapshot |
| `ReservationReleased` | A release through the API, or a treasury `RepaymentReceived` | `releaseRef`, `reason`, released and remaining amounts, `capacity` snapshot |
| `ProgramCapacityChanged` | Every applied treasury `ProgramLimitSet` (`cause: limit-set`; also a suspend, a resume or the same limit again), or a snapshot that changed the limit or reservations (`cause: reconciliation`, with `snapshotSeq`) | Program `status` (`ACTIVE`, `SUSPENDED`) and the full `capacity` view: limit, reserved, available, over-limit amount, utilization |
| `ReconciliationDriftDetected` | A snapshot disagreed beyond tolerance | `mode`, `driftCount`, up to 100 `drifts` (`truncated` says whether more were cut) |

One record looks like this (`make events`, wrapped):

```text
event-id:0193…,event-type:ReservationCreated,schema-version:1,tenant-id:bank-a,
program-id:prg_grand_usd,program-seq:42,content-type:application/json
| bank-a:prg_grand_usd
| {"messageId":"0193…","type":"ReservationCreated","schemaVersion":1,"tenantId":"bank-a",
   "programId":"prg_grand_usd","seq":42,"occurredAt":"…","payload":{…}}
```

What a consumer can rely on:

- **Key and order.** The key is `tenantId:programId`, so one program's events stay on one
  partition, in commit order.
- **Sequence.** `seq` (also the `program-seq` header and `payload.programSeq`) is gap-free per
  program: 1, 2, 3 … A jump means a missed event, a repeat means a duplicate. Treasury echoes the
  highest contiguous `seq` it applied back as `platformWatermark` in its snapshots.
- **At least once.** The relay publishes after commit and may resend after a crash or a lease
  takeover, so deduplicate by `messageId`. An event exists exactly when its change committed:
  outbox row and change are one transaction.
- **Money** is a decimal string with its currency, as in the API. Drift amounts are the
  exception: integer minor units (`invoiceMinor`, `programMinor`), as the ledger stores them.
- **Not a full reservation log.** Reconciliation can adjust, adopt or release reservations, and
  reports that per program (`ProgramCapacityChanged` with `cause: reconciliation`, plus up to
  100 drifts), not as `ReservationCreated`/`ReservationReleased`. A read model of reservations
  re-reads them from the API after such an event.
- **Evolution.** Within `v1` the only changes are a new optional field and a new event type:
  ignore fields and event types you do not know. Enums (`status`, `reason`, `cause`, `kind`,
  `mode`) are closed; a new value, like any breaking change, gets a new topic,
  `capacity.events.v2`. `make compat` (in CI on every push and pull request) fails on anything
  else, and runs oasdiff on the REST contract the same way.

A treasury message that fails validation goes to `<topic>.dlq` unchanged, with `x-error-code`,
`x-error-message` and `x-original-topic/partition/offset` headers; both DLQs are in the AsyncAPI
document too. `make dlq-replay` sends a fixed message back.

## 8. Changing a contract

Both contracts are generated from zod, so a change starts in the schema, then
`make contracts` regenerates `contracts/`. Two checks then decide whether the change may ship:
`make verify` (the files match the code) and `make compat` (the change is compatible with the
base commit; CI runs it on every push and pull request). This section explains the second one,
because it is deliberately strict.

### What `make compat` allows within `v1`

Kafka messages (every schema in `contracts/json-schema/` and the header schemas in
`contracts/asyncapi.yaml`), checked by `tools/contracts/compare-schemas.ts`:

| Change | Allowed in `v1`? | Why |
| --- | --- | --- |
| New **optional** field | Yes | Old consumers ignore it. It must be optional even when the code always sends it, because older records on the topic lack it (`ProgramCapacityChanged.status` is the example) |
| New **event type** on `capacity.events.v1` | Yes | The contract tells consumers to skip event types they do not know |
| `description`, `title`, `examples` | Yes | Documentation only |
| New **required** field | No | Older records on the topic, and treasury messages built for the old schema, fail the new one |
| Field removed or renamed | No | A consumer that reads it breaks |
| Type, `pattern`, `format`, length or number bounds changed | No | One side may now reject what the other still sends |
| **New enum value** (`status`, `reason`, `cause`, `kind`, `mode`) | No | See below |
| Enum value removed | No | A consumer may still send or expect it |

REST (`contracts/openapi.yaml`) is checked by [oasdiff](https://github.com/oasdiff/oasdiff)
(`breaking --fail-on ERR`): its error-level rules fail the build, such as a removed response
property or a new required request field; warning-level findings are printed and do not fail.

### Why a new enum value counts as breaking

Consumers branch on these values. A risk or treasury service that handles `REPAID` and
`CANCELLED` and then receives a new reason, say `WRITTEN_OFF`, either rejects the event (a
strict validator or an exhaustive `switch`) or, worse, silently treats it as one of the known
cases and books capacity wrongly. With no real consumer yet, nobody can confirm they tolerate
unknown values, so the safe default is closed. The choice is cheap to undo in one direction
only: opening an enum later is a one-line, reviewed change, while closing an enum that
consumers were told is open breaks them.

Event types are the exception on purpose: every consumer already has to skip types it does not
handle, and the AsyncAPI description says so.

### Opening an enum, when consumers agree

If the teams consuming the events agree to tolerate unknown values of an enum:

1. Add its property name to `OPEN_ENUMS` in `tools/contracts/compare-schemas.ts` (today only
   `event-type`). New values then pass; removing a value still fails.
2. Say so in the **Evolution** paragraph of the AsyncAPI description
   (`src/platform/contracts/asyncapi.ts`) and in [ADR 015](adr/015-contracts.md).
3. Regenerate (`make contracts`) and get the change reviewed like any contract change.

### Making a breaking change

A breaking change is a new version next to the old one, never an edit of `v1`:

- **REST:** new paths under `/v2`; `/v1` keeps working until its clients move.
- **Events:** a new topic `capacity.events.v2` with `schemaVersion: 2` and its own schemas. The
  relay publishes both topics during the migration and `v1` is retired once every consumer has
  moved. This is the procedure; the service has needed no `v2` yet, so the dual publishing is
  not built.

### When `make compat` fails

The output names every breaking path, for example
`json-schema/ReservationReleased.schema.json: $.payload.remainingAmount: removed`. The fixes,
in order of preference: keep the old field and add the new one beside it; make a new field
optional; or, if the change really is breaking, version it as above. `make compat
BASE=<ref>` compares with another commit. The check compares only files that exist at the base,
so a brand-new message is free to change until it is merged.
