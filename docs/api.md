# API tour

A hands-on walk through the REST API against the local stack. Every command below can be
pasted into a terminal after `make up && make seed`. Responses are shortened.

The full contract is [`contracts/openapi.yaml`](../contracts/openapi.yaml), generated from the
zod schemas in `src/capacity/adapters/in/http/`.

## Easiest: Swagger UI

Open <http://localhost:9464/docs> (ops port, local only). Click **Authorize**, choose
`localOAuth`, keep client id `bank-a` (the client id becomes the tenant; `bank-b` and `bank-c`
also exist) and log in. Then open an endpoint, press **Try it out**: request bodies and the
`Idempotency-Key` are prefilled from the schema examples, and the request goes to the API on
port 3000. That works because the compose stack sets `CORS_ORIGINS` for the docs page and
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

Ops port (9464, never exposed through an ingress, no token): `/health/live`, `/health/ready`,
`/metrics`, `/docs`.

## 1. Get a token

The local identity provider is [mock-oauth2-server](https://github.com/navikt/mock-oauth2-server).
`make token` asks it for a client-credentials token. The client id becomes the tenant.

```bash
TOKEN=$(make -s token TENANT=bank-a)
```

## 2. Read capacity

```bash
curl -s localhost:3000/v1/programs/prg_grand_usd/capacity -H "authorization: Bearer $TOKEN"
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
curl -s -X POST localhost:3000/v1/programs/prg_grand_usd/reservations \
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

Without a key, the natural key still protects you: a second reservation for the same
`invoiceId` in the same program returns `409 reservation-conflict`.

## 5. Release

```bash
curl -s -X POST localhost:3000/v1/programs/prg_grand_usd/reservations/<reservationId>/releases \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -H "idempotency-key: $(uuidgen)" \
  -d '{"releaseRef":"repayment-1","amount":{"value":"50000.00","currency":"EUR"},"reason":"REPAID"}'
```

Omit `amount` to release the whole remainder. `releaseRef` identifies the repayment: the same
`releaseRef` with the same amount is a no-op; with a different amount it is
`409 release-ref-mismatch`.

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
| 401 | — | Missing, expired or wrong-audience token |
| 403 | — | Token lacks the scope |
| 404 | `not-found` | Program or reservation does not exist **for this tenant** |
| 409 | `reservation-conflict`, `release-ref-mismatch` | Natural-key conflicts |
| 413 | `payload-too-large` | Body over the size limit |
| 422 | `insufficient-capacity`, `program-over-limit`, `program-suspended`, `release-exceeds-remaining`, `fx-rate-unavailable`, `idempotency-key-mismatch` | Business rule refused the request |
| 503 | `service-unavailable` | Database or identity provider unreachable; safe to retry with the same key |

Another tenant's program answers `404`, not `403`, so a caller cannot even learn that it
exists.

## 7. Watch the events

Every change is published to Kafka `capacity.events.v1`. To see them:

```bash
docker compose -f deploy/compose.yaml exec kafka \
  /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 \
  --topic capacity.events.v1 --from-beginning --property print.key=true
```

The event contract is [`contracts/asyncapi.yaml`](../contracts/asyncapi.yaml).
