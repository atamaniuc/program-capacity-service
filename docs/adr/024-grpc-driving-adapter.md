# 024. Internal gRPC driving adapter for capacity

- Status: accepted (branch `microservices` only)
- Date: 2026-10-29
- Supersedes: ADR 022 on branch `microservices` (ADR 022 stays in force on `main`)

## Context

ADR 022 declined a gRPC adapter and listed when to revisit it. On this branch one of those
triggers fires, and the main reason against it no longer holds:

| ADR 022 revisit trigger | Fired here? |
| --- | --- |
| A platform service that makes many calls per second and wants generated typed clients in several languages | No. Volumes are unchanged |
| A server stream of capacity changes to a funding engine that cannot consume Kafka | No. No stream is needed |
| **A platform standard of gRPC with mesh mTLS between services** | **Yes, the gRPC half.** On this branch internal service-to-service calls use gRPC (the job description's "internal service communication (gRPC)"). The mesh mTLS half is not built; see "Transport security" |

ADR 022's reason 1, "nobody would call it", is gone: `funding-service` (ADR 023) needs a
synchronous, typed `Reserve` before it pays a supplier. Reason 2, "every rule would live in two
places", is the one this ADR has to answer, and it does so with one boundary module. Reasons 3
(speed) and 5 (no in-process hop) still hold: gRPC is not claimed to be faster, and it is used
only between deployables. Reason 6 (attack surface) is answered by an internal-only port and
negative auth tests.

REST stays the public API, described by `contracts/openapi.yaml`. Nothing in it changes.

## Decision

### Contract

- `contracts/proto/finverity/capacity/v1/capacity_service.proto`, package
  `finverity.capacity.v1`, service `CapacityService` with `Reserve`, `Release` and
  `GetAvailability` (`GetAvailability` returns the same capacity view as
  `GET /v1/programs/{id}/capacity`).
- Money is `Money { string value; string currency_code; }`: a decimal string with an ISO 4217
  code, exactly as in JSON (ADR 004). No `float` or `double` field anywhere in the package; a
  test fails on one. Amounts are never `int64` minor units on the wire, so there is one parser
  and one scale check for both transports.
- `buf` from the npm package `@bufbuild/buf` (pinned; no system install). `buf lint`
  (STANDARD) and `buf breaking` (FILE rules) run in `make verify` and CI. Within `v1` only
  additive changes; a breaking change is a new package `v2`.
- TypeScript stubs are generated with `ts-proto` for `@grpc/grpc-js`, committed, and checked
  for drift (`npm run proto:check`), the same rule as `contracts:check` (ADR 015).

### Placement

`src/capacity/adapters/in/grpc/` is one more driving adapter over the existing use cases
(`ReserveCapacity`, `ReleaseReservation`, `GetCapacity`). The `api` role starts it on
`GRPC_PORT` (default 50051); the `worker` role never does. The port is internal only: a
ClusterIP Service, never routed by an ingress, no server reflection outside development.

### One boundary for both transports

`src/capacity/adapters/in/boundary/` holds what both adapters must agree on, and imports no
transport library:

- the request schemas (zod), money parsing and the `Idempotency-Key` schema, moved out of
  `in/http/schemas.ts`; the OpenAPI document stays generated from the same schemas;
- the JWT verifier and the `Principal` (ADR 011), moved out of `in/http/auth.ts`;
- **one problem table**, `problem type → { http status, grpc code }`, typed as an exhaustive
  `Record` over every transport problem type, so a new problem type does not compile until it
  has both mappings.

Each adapter only maps its transport's input (path, headers, body; or message, metadata) into
the same plain object and calls the same `parse`. The dependency-cruiser rule
`adapters-do-not-import-each-other` gains one exception: a driving adapter may import
`adapters/in/boundary`.

### Status mapping

| Problem type | HTTP | gRPC code |
| --- | --- | --- |
| `validation-error` | 400 | `INVALID_ARGUMENT` |
| `unauthorized` | 401 | `UNAUTHENTICATED` |
| `forbidden` | 403 | `PERMISSION_DENIED` |
| `not-found` | 404 | `NOT_FOUND` |
| `reservation-conflict` | 409 | `ALREADY_EXISTS` |
| `insufficient-capacity`, `program-over-limit`, `program-suspended`, `fx-rate-unavailable` | 422 | `FAILED_PRECONDITION` |
| `idempotency-key-mismatch`, `release-ref-mismatch`, `release-exceeds-remaining` | 422 | `FAILED_PRECONDITION` |
| `payload-too-large` | 413 | `RESOURCE_EXHAUSTED` |
| `service-unavailable` (database down, JWKS outage, lock or statement timeout) | 503 | `UNAVAILABLE` |
| `internal-error` | 500 | `INTERNAL` |

**Rule: every outcome that is stored under an `Idempotency-Key` maps to a code that clients do
not retry.** `fx-rate-unavailable` is stored (ADR 006), so it is `FAILED_PRECONDITION`, never
`UNAVAILABLE`: a retry with the same key would only replay it. `RESOURCE_EXHAUSTED` is not used
for insufficient capacity because common retry policies treat it as retryable.

The problem travels as `google.rpc.Status` in `grpc-status-details-bin` with an `ErrorInfo`
(`reason` = the problem type, `domain` = `capacity.finverity`, `metadata.detail` = the detail
without internals), following Google AIP-193. Clients branch on `reason`, as REST clients
branch on `type`. A success carries what the REST body carries plus the status REST
expresses with its code: `ReserveResponse.result` is `CREATED` when the stored outcome is 201
(this call, or an earlier call under the same key, created the reservation) and `EXISTING` when
it is 200 (a natural-key replay: the invoice already had a reservation with the same terms,
made by another request). The funding saga must tell the two apart (ADR 025).

### Authentication and tenant

- `authorization: Bearer <jwt>` metadata, verified by the same verifier as REST: issuer, `aud`
  = `capacity-service`, RS256 or ES256, `exp`, `tenant_id`, `scope`. A server interceptor runs
  it before the request message is parsed, so no RPC answers anything but `UNAUTHENTICATED`
  without a valid token (S6). A JWKS outage is `UNAVAILABLE`, not `UNAUTHENTICATED` (ADR 011).
- Scopes per method: `capacity:write` for `Reserve` and `Release`, `capacity:read` for
  `GetAvailability`. A method missing from the scope table is denied (default-deny).
- The tenant comes from the token only. `funding-service` uses OAuth2 client credentials with
  **one client per tenant** (`funding-service.<tenant>`): its token for bank-a carries
  `tenant_id = bank-a` and `sub = funding-service`. There is no token that can act for every
  tenant, so a bug in funding cannot reach another tenant's program (confused deputy). ADR 011
  is unchanged.

### Idempotency, request id, deadlines

- `idempotency-key` metadata, validated by the same schema as the header. The fingerprint is
  computed by the use case from the route template and the body (ADR 006), not by the
  transport, so a key first used over REST and repeated over gRPC with the same request replays
  the stored answer (GR-06). `x-request-id` metadata as on REST.
- Every client call carries a deadline. The server checks the remaining time before it opens
  the transaction and answers `DEADLINE_EXCEEDED` without doing any work when it has already
  run out. Once open, the transaction is bounded by its own `lock_timeout` and
  `statement_timeout` (ADR 003) and is not abandoned halfway on a client cancel: either it
  commits or it rolls back as a whole. A commit after the client gave up is an unknown outcome
  for the client, resolved by a retry with the same key (ADR 025). Client deadlines are set
  above `lock_timeout + statement_timeout` so that, normally, the server answers first.

### Transport security, limits, shutdown, telemetry

- Plaintext HTTP/2 inside compose and the kind cluster, with the JWT still required on every
  call. Production needs TLS on the port or mesh mTLS; neither is built (the service-mesh row
  of ADR 017 is unchanged).
- Maximum message size equals the REST body limit.
- On SIGTERM the gRPC server stops accepting calls, drains in-flight calls within the NFR-07
  budget (`tryShutdown`), then forces shutdown.
- OpenTelemetry gRPC server spans; RED metrics by method and code; `traceparent` read from
  metadata.

## Consequences

- Two transports, one boundary: validation, auth and the problem mapping exist once, and the
  acceptance cases run over both transports (GR-03).
- `.proto` is a second contract to version next to OpenAPI. `buf breaking` checks it, and the
  consumer contract test checks what the consumer relies on (ADR 028).
- One more port to protect: internal only, JWT on every call, negative tests for missing,
  invalid and under-scoped tokens.

## Alternatives rejected

- **The NestJS microservices gRPC transport.** It loads the proto at runtime and maps errors
  through its own exception layer. Deadlines, metadata and status details need direct control
  here, the same reason ADR 001 gives for not using the Nest Kafka transport.
- **Connect or grpc-gateway, serving REST and gRPC from one definition.** ADR 022's reasoning
  holds: it moves the source of truth for the whole public API from zod to protobuf.
- **Validating with protovalidate annotations in the proto.** A second schema language at the
  same boundary; zod stays the only one (constraint 8).
- **`int64` minor units on the wire.** Faster to parse, but a second money format with its own
  scale rules at the boundary of a money service.
