# 011. Authentication and tenant isolation

- Status: accepted
- Date: 2026-10-28

## Context

Banks are tenants of one deployment. A token must never reach another tenant's data (FR-10).

## Decision

A Nest guard verifies the bearer JWT with `jose`: `createRemoteJWKSet(OAUTH_JWKS_URL)` (cached,
key rotation), issuer, audience `capacity-service`, RS256 or ES256 only, `exp` required, 30 s
clock tolerance. Claims: `tenant_id`, `scope` (space separated), `sub` or `client_id` as actor.
Missing or invalid token or claim: 401 with `WWW-Authenticate: Bearer`. Missing scope
(`capacity:read` for GET, `capacity:write` for POST): 403. The tenant comes from the token only;
every query filters by it and another tenant's program answers 404, so existence does not leak.
Program ids are unique per tenant, the key is `(tenant_id, id)`.

## Consequences

- No request field can select a tenant.
- JWKS outage with a cold cache fails closed with 401.

## Alternatives rejected

Tenant in a header or path (spoofable), opaque tokens with introspection (a network call per
request), HS256 shared secrets.
