# 011. Authentication and tenant isolation

- Status: accepted
- Date: 2026-10-28

## Context

Banks are tenants of one deployment. A token must never reach another tenant's data (FR-10).

## Decision

An Express middleware on `/v1` verifies the bearer JWT with `jose`, before the JSON body parser
runs, so malformed JSON, oversized bodies and unknown routes answer 401 without a token.
`createRemoteJWKSet(OAUTH_JWKS_URL)` (cached, key rotation), issuer, audience `capacity-service`,
RS256 or ES256 only, `exp` required, 30 s clock tolerance. Claims: `tenant_id`, `scope` (space
separated), `sub` or `client_id` as actor. Missing or invalid token or claim: 401 with
`WWW-Authenticate: Bearer`. A JWKS outage (timeout, fetch failure): 503 with `Retry-After`.
A Nest guard only checks scopes (`capacity:read` for GET, `capacity:write` for POST): 403, and a
handler that declares no scope is denied. The tenant comes from the token only; every query
filters by it and another tenant's program answers 404, so existence does not leak. Program ids
are unique per tenant, the key is `(tenant_id, id)`.

### Why a middleware and not a Nest guard

In Nest, Express middleware (including the JSON body parser) runs before guards. With the
token checked only in a guard, the review saw these answers to calls without a token:
malformed JSON → 400, a 200 KB body → 413, an unknown route → 404. That breaks S6 ("no business
endpoint answers without a valid token"). It also shows an anonymous caller which paths exist
and how the parser behaves. Mounting the verifier on `/v1` before the parser makes 401 the
first answer to anything without a valid token. The guard is left with the per-handler job
it is suited to: the scope.

### Why a JWKS outage is 503 and not 401

When the issuer's keys cannot be fetched (`JWKSTimeout`, `JWKSInvalid`, a non-200 answer, or
`fetch failed`), the token may be perfectly valid. 401 would tell every client "your
credentials are wrong", and clients do not retry that. 503 with `Retry-After` says "try again
later". Only real token errors (`JOSEError`: signature, `exp`, `iss`, `aud`, algorithm)
answer 401. Any other exception is a bug and answers 500, never 401: catching `TypeError` as
"invalid token" would hide defects.

### Why default-deny on scopes

A handler without `@RequireScope` would otherwise accept any valid token, including a
read-only one, for a write. The guard answers 403 to a handler that declares no scope, so
forgetting the decorator fails closed and shows up in the first test.

## Consequences

- No request field can select a tenant.
- A JWKS outage fails closed with 503, not 401: it is not the caller's fault.

## Alternatives rejected

Tenant in a header or path (spoofable), opaque tokens (a network call per request), HS256.
