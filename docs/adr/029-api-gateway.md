# 029. API gateway: Envoy Gateway on the Gateway API, in kind only

- Status: accepted (branch `microservices` only)
- Date: 2026-10-29
- Amends: ADR 017 row "API gateway in this repo" (the trigger fires on this branch) and ADR 026
  ("ingress" leaves its "out of scope, still" list; the kind install gains two releases)

## Context

ADR 017 declined a gateway because "the platform owns routing; the service validates the JWT
itself", and named the condition that changes the answer: **a second public service needing
shared policies**. On this branch that condition is true. `funding-service` exposes
`POST /v1/funding-requests` and `GET /v1/funding-requests/{id}` (task T9 of the funding-saga work plan) next to
capacity's `/v1/programs…`. Both are public REST APIs with the same issuer, the same CORS
origins and the same need for a per-tenant request limit. Without a gateway each service
repeats those policies and a client needs two base URLs. In kind this branch plays the platform
(ADR 026), so the platform's piece is built here too.

Three constraints shape the design:

- **ADR 011 stays whole.** Each service verifies the JWT itself (JWKS, issuer, audience,
  scopes, tenant from the token). The gateway must not become the only check.
- **ADR 027's issuer trap.** mock-oauth2-server derives `iss` from the `Host` of the token
  request. A token minted through one address carries an issuer the other components do not
  expect, and every check that compares `iss` answers 401.
- **No Redis (owner ruling, DECISIONS 2026-10-29).** Envoy Gateway's global rate limit needs a
  Redis backend, so it is not available.

## Decision

### Product and placement

- **Envoy Gateway** (the Envoy project's Kubernetes controller) on the **Kubernetes Gateway
  API**: `GatewayClass`, `Gateway`, `HTTPRoute`, plus Envoy Gateway's `SecurityPolicy`,
  `BackendTrafficPolicy`, `ClientTrafficPolicy` and `EnvoyProxy` resources.
- **kind only.** Compose has no gateway: it is the fast loop and keeps calling the services
  directly. The gateway is part of the "it deploys" check.
- **One chart `deploy/helm/gateway`** holds the edge policy and the routes: `Gateway` (one HTTP
  listener), two `HTTPRoute`s, one `SecurityPolicy` per route, one `BackendTrafficPolicy`, one
  `ClientTrafficPolicy`, an `EnvoyProxy` with one replica and a `ClusterIP` Service, and the
  `helm test` Pod. The service charts stay free of Gateway API kinds, so they install and
  render without Envoy Gateway's CRDs. Shared policy in one place is the reason the trigger
  fired.
- **AWS analogue:** Amazon API Gateway (HTTP API with a JWT authorizer and throttling) or an ALB
  in front of the cluster; on EKS, Envoy Gateway itself behind an NLB. TLS terminates there. In
  kind the listener is plain HTTP.

### Routes

| Path prefix | Backend | Audience checked at the edge |
| --- | --- | --- |
| `/v1/programs` | capacity `api` Service, HTTP port | `capacity-service` |
| `/v1/funding-requests` | funding `api` Service, HTTP port | `funding-service` |

- `PathPrefix` matches; any other path answers 404 from the gateway and reaches no service.
- **No `hostnames`** on the routes, so calls through `make kind-forward` (`Host: localhost:…`)
  and calls from inside the cluster both match.
- **gRPC is never exposed.** No `GRPCRoute`, `TCPRoute` or `TLSRoute`; every `backendRef`
  names the HTTP port, never capacity's gRPC port 50051 or an ops port. A gRPC path
  (`/finverity.capacity.v1.CapacityService/…`) matches no route. A static test over the rendered
  chart enforces this (acceptance criterion GW-05 in the [funding-saga spec](../../specs/0006-funding-saga/spec.md); the GW-01 to
  GW-05 criteria below are listed there).

### Authentication at the edge, and again in the service

- Each route's `SecurityPolicy` has a `jwt` provider: `issuer` = the cluster issuer (below),
  `audiences` = the route's audience, `remoteJWKS` with `backendRefs` to the mock OAuth2
  Service. Plain HTTP JWKS is accepted through `backendRefs`; Envoy Gateway requires `https`
  only for OIDC discovery, which is not used. `cacheDuration: 30s`, so a restarted mock OAuth2
  Pod (new keys) is picked up quickly.
- Envoy Gateway's JWT filter runs before the local rate limit filter (its fixed filter order:
  CORS, then JWT, then local rate limit). A request without a valid token is refused (401, or 403
  for a wrong audience) and does not consume a rate-limit token. CORS preflights are answered before the JWT check, as browsers
  expect.
- The gateway forwards the original `Authorization` header (Envoy Gateway sets the JWT filter's
  `forward`), so **each service verifies the same token again** with its own issuer, audience
  and scope rules (ADR 011). Scopes stay a service concern; the gateway checks signature,
  `exp`, `iss` and `aud` only.
- **Defence in depth.** Pods are reachable by ClusterIP without the gateway: kind's default CNI
  does not enforce NetworkPolicies (ADR 026), and a production mesh or policy can be
  misconfigured. A direct call without a token gets 401 `application/problem+json` from the
  service (GW-03). Trusting gateway-injected identity headers instead was rejected: any Pod that
  reaches a service could forge them.
- The two 401s are distinguishable: the gateway's carries `WWW-Authenticate: Bearer` and an
  Envoy body; the service's is an RFC 9457 problem (ADR 014). GW-02 uses that to prove the
  request never reached the service. One exception, found in the live run (2026-10-30): a token
  whose `aud` is not the route's is answered **403** ("Audiences in Jwt are not allowed"), not
  401, by Envoy's JWT filter; bad signature, expiry and foreign `iss` are 401. The edge still
  refuses the call and the service never sees it.

### The issuer, resolved

There is exactly **one issuer string per deployment**, and in kind it is the in-cluster FQDN of
the mock OAuth2 Service: `http://<oauth-service>.finverity-ms.svc.cluster.local:<port>/default`
(the Service name and port are fixed when `local-infra` is written, task T15).

- It is one Makefile constant, `KIND_OAUTH_ISSUER`, passed with `--set` to the `capacity`,
  `funding` and `gateway` releases. Services get it as `OAUTH_ISSUER`; the gateway as each
  provider's `issuer`. No chart carries its own default issuer for kind.
- Every in-cluster token minter (funding's per-tenant capacity clients, the `helm test` Pods)
  calls the token endpoint at that same FQDN and port, never the short Service name: a token
  minted at `http://oauth:8080` would carry `iss=http://oauth:8080/default` and fail at both
  the gateway and the services.
- A token minted from the host through `make kind-forward` sends `Host: <issuer authority>`, the
  ADR 027 trick, so its `iss` is the cluster issuer too (`make kind-token` does this). A token
  from the compose stack (`http://localhost:18081/default`) is refused in kind, by design.
- GW-02 includes a token with a foreign `iss` and expects 401 at the gateway; GW-03 expects the
  same at the service.

### Rate limit: local, per tenant, no Redis

- `BackendTrafficPolicy` with `rateLimit.local`: one rule whose client selector is the header
  `x-tenant-id` with `type: Distinct`, so each tenant gets its own token bucket per route. The
  limit is a chart value; kind uses a small per-minute value so the test is not timing-sensitive.
  Past it the gateway answers 429.
- `x-tenant-id` comes from the verified token: the JWT provider's `claimToHeaders` copies
  `tenant_id` into it. The `ClientTrafficPolicy` removes any client-sent `x-tenant-id` in
  `earlyRequestHeaders`, before any filter runs, so a caller cannot pick another tenant's bucket.
  No service reads this header; the tenant still comes from the token only (ADR 011).
- **Local, not global.** The counter lives in each Envoy replica. With N replicas a tenant's
  effective limit is N × the configured value. In kind there is one replica, so the limit is
  exact. This is a protection limit (keep one tenant from starving the others), not a billing
  quota.
- **Why no Redis:** Envoy Gateway's global rate limit runs the Envoy rate-limit service with
  Redis as its store. The owner ruled Redis out on the branch (DECISIONS 2026-10-29), and a
  shared counter buys nothing with one replica. **Revisit trigger:** several gateway replicas
  plus a contractual per-tenant quota. In AWS, API Gateway usage plans give a managed global
  limit without running Redis.

### CORS has one owner per deployment

The gateway's `SecurityPolicy` holds the allowed origins in kind; the service charts leave
`CORS_ORIGINS` empty (CORS off, its default), so a response never carries two
`Access-Control-Allow-Origin` headers. In compose the services keep their own CORS, as now.

### Install in kind

- Envoy Gateway's official OCI chart, pinned: `oci://docker.io/envoyproxy/gateway-helm`
  **`v1.9.3`** (chart and app version). Checked 2026-10-29: GitHub releases of
  `envoyproxy/gateway` (v1.9.3 published 2026-10-26, the latest stable; v1.8.6 the same day) and
  `helm show chart oci://docker.io/envoyproxy/gateway-helm --version v1.9.3` (digest
  `sha256:be1b8f163a338f94e7d6532336c08d6856fc70a0b790ac14a2826a54d23e0dd3`). The release
  matrix lists for v1.9: Envoy Proxy 1.39, Gateway API v1.6.1, Kubernetes 1.33–1.36, end of
  life 2027-02-14. v1.8 reaches end of life on 2026-11-08, so it is not used.
- The version is a Makefile constant `ENVOY_GATEWAY_VERSION`, re-checked with the other dated
  facts at task T17 (the docs). The chart ships the Gateway API and Envoy Gateway CRDs; nothing else installs
  CRDs. No Bitnami or other third-party chart (ADR 026).
- `make kind-up` installs, after `local-infra`, `capacity` and `funding`: release `eg` in
  namespace `envoy-gateway-system` (`--wait`), then release `gateway` from
  `deploy/helm/gateway` in `finverity-ms` (`--wait`). Both calls pass `--kubeconfig
  .kind/kubeconfig --kube-context kind-finverity-ms`, like every other kind target (MS-01).
- No `extraPortMappings` and no LoadBalancer: the `EnvoyProxy` resource makes the proxy Service
  `ClusterIP`. `make kind-forward` adds one port-forward to it inside 23000–23099 (ADR 027).
- `make helm-check` renders the `gateway` chart too. kubeconform has no schema for the Gateway
  API and Envoy Gateway kinds in its default catalogue, so those kinds are skipped by name
  there; `make kind-up` validates them against the real CRDs on install, and GW-05 checks the
  rendered routes statically.

### What `helm test gateway` proves, and what it does not

`make kind-smoke` runs `helm test funding` and then `helm test gateway`. The gateway test Pod
runs inside the cluster and proves GW-01 to GW-05: each prefix reaches the right service, the
edge refuses a missing, foreign-issuer or wrong-audience token, a direct ClusterIP call without
a token is refused by the service, the local limit answers 429 past its value and keeps tenants
apart, and a gRPC path is not routed.

It does not prove: TLS, a cloud load balancer, multi-replica rate limiting, gateway
availability under failure, or behaviour under load. Those belong to a real cluster, which stays
out (ADR 026).

## Consequences

- Clients have one entry point in kind; compose keeps two direct base URLs.
- Two JWT checks per request through the gateway. Both are local signature checks against a
  cached JWKS; the cost is small and buys the bypass protection.
- The gateway's own answers (401, 404, 429) are Envoy bodies, not RFC 9457 problems. `docs/api.md`
  lists them (task T17). Replacing them with problem bodies through a response override is possible
  later.
- A JWKS outage answers 401 at the gateway, while the services answer 503 with `Retry-After`
  (ADR 011). In kind the JWKS lives next to the gateway; with a real IdP this divergence matters
  and is the first thing to revisit.
- One more controller and one more chart in kind; `make kind-up` gets slower.

## Alternatives rejected

- **A hand-written NestJS gateway** (a proxy service). It re-implements routing, JWT checks,
  CORS and rate limiting in application code, adds a third deployable that every request
  crosses, and is the kind of platform component a bank buys or runs as standard software.
- **Kong.** Capable, but its rate-limit plugin needs Redis or a database to be shared, its
  Kubernetes mode adds its own CRDs on top of the Gateway API, and Envoy Gateway is the Envoy
  project's own Gateway API implementation with every policy needed here as a typed resource.
- **ingress-nginx with an `Ingress`.** The `Ingress` API has no standard JWT or rate-limit
  model (annotations per controller), and the Kubernetes project retired ingress-nginx (best-effort
  maintenance ended in March 2026). The Gateway API is its successor.
- **Global rate limit with Redis.** Exact across replicas, but it brings back the Redis the
  owner ruled out, for a limit that is already exact with the one replica kind runs.
- **The gateway as the only JWT check** (services trust a header). Rejected above: without
  enforced NetworkPolicies any Pod could reach a service directly.
- **A gateway in compose too.** It would duplicate the kind setup in a second form and slow the
  fast loop, for no check that kind does not already run.
