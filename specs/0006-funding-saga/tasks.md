# Tasks — 0006 Funding saga (branch `microservices`)

Planned proofs are plain text; a ticked box carries a resolving proof marker (an HTML comment
starting with `proof:`). One task at a time, in order. Each task ends with `make verify` (and
`make test` when it touches anything Docker-backed) green, output quoted in the handoff.
Tasks marked **[review]** go to a fresh-context `architect` review before the next task starts.

## P0 — minimum viable: isolation, workspaces, gRPC, funding saga, Helm/kind

- [x] T1 — **Side-by-side isolation from `main`** (ADR 027). Compose project
  `program-capacity-ms`; every host port from an env var with the +10000 default (table in
  ADR 027), Kafka `EXTERNAL` listener and advertised address on 39092; `OAUTH_ISSUER`,
  `OAUTH_TOKEN_URL` and `CORS_ORIGINS` follow the shifted ports; images tagged `:ms-local`;
  Makefile, `.env.example`, `tools/` (token, demo, simulator, dlq-replay, qa, load incl. the k6
  `Host` header), `db/seeds`, `tools/doctor.sh` read the same variables; `make isolation-live`
  checks both projects healthy together; README and runbook ports updated. Reserve the kind
  names now (`KIND_CLUSTER := finverity-ms`, `.kind/` gitignored).
  <!-- proof: test/architecture/isolation.test.ts#MS-01 --> <!-- proof: test/architecture/isolation.test.ts#MS-03 --> <!-- proof: make isolation-live -->
  (MS-02 evidence: both `docker compose -p … ps` outputs quoted in the handoff.)
- [x] T2 — **npm workspaces skeleton** (ADR 027). Root `workspaces`; `services/funding` and
  `services/payments-mock` with `package.json`, `tsconfig.json`, Vitest projects,
  dependency-cruiser config and one trivial unit test each; `make verify` and `make test` run
  every workspace; architecture test for cross-service imports; `harnessimo.config.json`
  scans `services/` and `packages/`; CI runs the same make targets.
  <!-- proof: test/architecture/workspaces.test.ts#WS-01 -->
- [x] T3 — **Proto contract and buf** (ADR 024). `contracts/proto/finverity/capacity/v1/`
  with `CapacityService` (`Reserve`, `Release`, `GetAvailability`), `Money` as decimal string
  plus `currency_code`, `ReserveResponse.result` (`CREATED`/`EXISTING`); `@bufbuild/buf`,
  `ts-proto` and `@grpc/grpc-js` pinned (check dated facts); `npm run proto:lint`,
  `proto:breaking` (against `PROTO_BASE`, CI sets the PR base), `proto:generate`,
  `proto:check`; all in `make verify`; committed stubs for capacity (server) and funding
  (client). <!-- proof: test/architecture/proto.test.ts#GR-01 -->
- [x] T4 — **One driving-adapter boundary** (ADR 024) **[review]**. Move request schemas,
  money parsing, the `Idempotency-Key` schema, the JWT verifier and `Principal` into
  `src/capacity/adapters/in/boundary/`; add the exhaustive problem table
  `{ http, grpc }`; amend the dependency-cruiser rule with the boundary exception. No
  behaviour change: every existing test green, `contracts:check` shows no diff.
  <!-- proof: src/capacity/adapters/in/boundary/problem-map.test.ts#GR-02 -->
- [x] T5 — **gRPC server adapter in the `api` role** (ADR 024) **[review]**. Auth interceptor
  before parsing, scope table with default-deny, `idempotency-key` and `x-request-id`
  metadata, `ErrorInfo` details, deadline check before the transaction, `GRPC_PORT` in config
  (validated at boot), readiness reports the gRPC server, OpenTelemetry spans and RED metrics,
  graceful shutdown inside NFR-07.
  <!-- proof: test/e2e/grpc.e2e.test.ts#GR-04 --> <!-- proof: test/e2e/grpc.e2e.test.ts#GR-05 --> <!-- proof: test/e2e/grpc.e2e.test.ts#GR-06 --> <!-- proof: test/fault/grpc-shutdown.fault.test.ts#GR-07 -->
- [x] T6 — **Acceptance cases over both transports**. A transport-neutral `CapacityClient`
  (HTTP via Supertest, gRPC via the generated client) in `test/support/`; AC-01, AC-02, AC-03,
  AC-04, AC-05, AC-06, AC-13, AC-16, AC-17 and FR-01 parametrised by transport, titles
  `AC-xx (http|grpc) …`. Existing test files are left as they are (their markers keep
  resolving). <!-- proof: test/e2e/transports.e2e.test.ts#AC-01 --> <!-- proof: test/e2e/transports.e2e.test.ts#AC-02 --> <!-- proof: test/e2e/transports.e2e.test.ts#AC-03 --> <!-- proof: test/e2e/transports.e2e.test.ts#AC-04 --> <!-- proof: test/e2e/transports.e2e.test.ts#AC-05 --> <!-- proof: test/e2e/transports.e2e.test.ts#AC-06 --> <!-- proof: test/e2e/transports.e2e.test.ts#AC-13 --> <!-- proof: test/e2e/transports.e2e.test.ts#AC-16 --> <!-- proof: test/e2e/transports.e2e.test.ts#AC-17 --> <!-- proof: test/e2e/transports.e2e.test.ts#FR-01 -->
- [ ] T7 — **Funding domain: state machine and money** (ADR 025) **[review]**.
  `services/funding/src/funding/domain`: `FundingRequest`, the transition table as pure code,
  outcome classes, deterministic step keys, minor-unit money with the no-`number` lint rule,
  risk policy.
  <!-- proof: services/funding/test/property/saga.property.test.ts#FS-01 -->
- [ ] T8 — **Funding database** (ADR 023). `funding` database and role (compose init script
  and Testcontainers helper), Kysely SQL migrations: `funding_request` (saga columns, unique
  per tenant/program/invoice, version, lease, deadlines), append-only `saga_step_attempt`,
  `idempotency_key`, `outbox_event`; capacity's role refused on `funding` and vice versa.
  proof (planned): `services/funding/test/integration/database.int.test.ts#FS-14`
- [ ] T9 — **Funding API**. `POST /v1/funding-requests`, `GET /v1/funding-requests/{id}`;
  JWT (`aud` = `funding-service`, scopes `funding:write`/`funding:read`), tenant from the token,
  `Idempotency-Key` per ADR 006, natural key, RFC 9457 problems, OpenAPI generated from zod with
  a drift check; mock OAuth2 mappings for the funding audience and the per-tenant
  `funding-service.<tenant>` capacity clients.
  proof (planned): `services/funding/test/e2e/api.e2e.test.ts#FS-02`
- [x] T10 — **Payments mock**. `services/payments-mock`: `POST /v1/payments` with
  `Idempotency-Key` (stored result), `GET /v1/payments/{key}`, fault markers by invoice id
  (decline, timeout after commit, 5xx n times), ops port with liveness; no database.
  <!-- proof: services/payments-mock/test/payments.test.ts#PM-01 -->
- [ ] T11 — **Saga driver, happy and rejection paths** (ADR 025) **[review]**. Worker loop:
  claim with `FOR UPDATE SKIP LOCKED` and lease, step executors (risk, reserve via gRPC with a
  per-tenant token cache and deadline, disburse), record with the version check, attempt log and
  outbox in one transaction, backoff with jitter, config validated at boot (resolution limit
  below 24 h). System-test harness: capacity image, PostgreSQL, mock OAuth2, payments mock and
  Toxiproxy through Testcontainers.
  proof (planned): `services/funding/test/system/saga.system.test.ts#FS-03`, `services/funding/test/integration/saga.int.test.ts#FS-04`, `services/funding/test/integration/saga.int.test.ts#FS-05`
- [ ] T12 — **Compensation and unknown outcomes** (ADR 025) **[review]**. Payment declined →
  release; unknown reserve → resolve with the same key, then release; unknown disbursement →
  `NEEDS_ATTENTION`, never release; compensation retried without deadline; already-released
  counts as compensated (prove capacity's answer first).
  proof (planned): `services/funding/test/system/saga.system.test.ts#FS-06`, `services/funding/test/integration/saga.int.test.ts#FS-09`, `services/funding/test/integration/saga.int.test.ts#FS-10`, `services/funding/test/system/saga.system.test.ts#FS-11`
- [ ] T13 — **Exactly-once effect and atomicity** (ADR 025) **[review]**. Lost reserve
  answer via Toxiproxy; crash between call and record; two drivers with an expired lease;
  injected failure inside a transition. Mutation probes: remove the version check, then the
  deterministic key, and expect red.
  proof (planned): `services/funding/test/system/saga.system.test.ts#FS-07`, `services/funding/test/integration/saga.int.test.ts#FS-08`, `services/funding/test/integration/driver.int.test.ts#FS-12`, `services/funding/test/integration/driver.int.test.ts#FS-13`
- [ ] T14 — **Compose stack, demo and alerts**. Funding `api` and `worker`, payments mock,
  capacity gRPC port in `deploy/compose.yaml`; `make demo-funding` with the five scenarios;
  funding metrics, Prometheus alert rules `FundingNeedsAttention`, `FundingCompensationStuck`,
  `FundingReserveUnresolved`; runbook entries for each alert and for a manual release with the
  saga's `releaseRef`. proof (planned): `make demo-funding`
- [ ] T15 — **Helm charts** (ADR 026). `deploy/helm/capacity` (derived from `deploy/k8s/`, gRPC
  port on the Service), `deploy/helm/funding`, `deploy/helm/local-infra`; migrate Jobs as hooks;
  `make helm-check` with kubeconform. proof (planned): `make helm-check`
- [ ] T16 — **kind cluster and smoke** (ADR 026). `deploy/kind/cluster.yaml` (no host port
  mappings), `make kind-up`, `make kind-smoke` (`helm test funding`), `make kind-forward`
  (23000–23099), `make kind-down`; kubeconfig only in `.kind/kubeconfig`; doctor warnings.
  proof (planned): `make kind-up`, `make kind-smoke`, `test/architecture/isolation.test.ts#K8-04`
- [ ] T16a — **API gateway in kind** (ADR 029) **[review]**. Envoy Gateway `v1.9.3` from
  `oci://docker.io/envoyproxy/gateway-helm` (constant `ENVOY_GATEWAY_VERSION`, release `eg` in
  `envoy-gateway-system`); chart `deploy/helm/gateway`: `Gateway` with one HTTP listener,
  `EnvoyProxy` (one replica, `ClusterIP`), `HTTPRoute`s `/v1/programs` → capacity and
  `/v1/funding-requests` → funding (HTTP ports only, no `hostnames`), one `SecurityPolicy` per
  route (JWT with the route's audience, `remoteJWKS` via `backendRefs`, `cacheDuration: 30s`,
  `claimToHeaders` `tenant_id` → `x-tenant-id`, CORS), a `ClientTrafficPolicy` removing a
  client-sent `x-tenant-id`, a `BackendTrafficPolicy` with a local per-tenant limit
  (`Distinct`); one `KIND_OAUTH_ISSUER` constant passed to capacity, funding and gateway;
  services' `CORS_ORIGINS` empty in kind; `make kind-token` sends the issuer's `Host`;
  `make kind-forward` adds the gateway port; `make helm-check` renders the chart (kubeconform
  skips the Gateway API and Envoy Gateway kinds by name); `make kind-smoke` also runs
  `helm test gateway`. proof (planned): `make kind-smoke`,
  `test/architecture/gateway.test.ts#GW-05`
- [ ] T17 — **Docs for the delivered MVP** (architect with implementer). `docs/architecture.md`
  C4 context and container views for the branch, `docs/api.md` funding endpoints and the gRPC
  status table, README sections beyond "Why this branch exists", PRD branch note re-checked,
  dated facts re-checked (`npm view`, kind node image). Russian owner docs for the branch are
  new files with the `micro-srv-` prefix (`docs/micro-srv-guide.ru.md`,
  `docs/micro-srv-deffend.ru.md`); `main`'s `*.ru.md` are not edited. They stay local like every
  `docs/*.ru.md` (`.git/info/exclude`), so they carry no proof marker.
  proof (planned): `docs/architecture.md`

---

**Cut line.** Everything above is the minimum viable branch: isolation, workspaces, gRPC,
funding saga, Helm and kind with its API gateway. The P0 gate is T1–T17 (T16a included)
green plus the architect review. The
lane closes only after T18 (owner decision, 2026-10-29): every ADR 021 precondition must hold.
T19–T24 can follow in the same lane or a successor lane.

---

## P1 — after the cut

- [ ] T18 — **Contracts package** (ADR 028). `packages/contracts` (`@finverity/contracts`):
  proto moved from `contracts/proto`, generated stubs, JSON Schemas of `capacity.events.v1`
  and `funding.events.v1`; both services import it; `proto:*` scripts move. Closes the ADR 021
  precondition left open by ADR 023. Also the build-time substitute for a schema registry (ADR
  028): a JSON Schema backward-compatibility check of every event schema against the merge base,
  run in `make verify`; removing or renaming a field, adding a required one, or narrowing a type
  fails (CT-04). proof (planned): `test/architecture/workspaces.test.ts#CT-01`,
  `packages/contracts/test/schema-compat.test.ts#CT-04`
- [ ] T19 — **Pact consumer tests in funding** (ADR 028). Six interactions, protobuf plugin,
  pact file committed to `contracts/pacts/`; fallback recorded in ADR 028 if the plugin fails
  on CI. proof (planned): `services/funding/test/pact/capacity.consumer.pact.test.ts#CT-02`
- [ ] T20 — **Pact provider verification in capacity**. Provider states seed PostgreSQL;
  runs in `make test`. proof (planned): `test/pact/capacity.provider.pact.test.ts#CT-03`
- [ ] T21 — **Funding outbox relay** to `funding.events.v1` with lease and epoch fencing
  (ADR 009 pattern), AsyncAPI entry.
  proof (planned): `services/funding/test/kafka/outbox-relay.kafka.test.ts#FS-15`
- [ ] T22 — **Operator resolution of `NEEDS_ATTENTION`** (`make funding-resolve ID=…
  OUTCOME=paid|not-paid`), recorded with actor and reason.
  proof (planned): `services/funding/test/integration/resolve.int.test.ts#FS-16`

## P2

- [ ] T23 — kind job in CI (`helm/kind-action`) running `make kind-up kind-smoke` on pull
  requests to `microservices`. proof (planned): `.github/workflows/kind.yml`
- [ ] T24 — Funding consumes `capacity.events.v1` (inbox, ADR 007 semantics) to mark a
  `COMPLETED` request repaid on the final `ReservationReleased` with reason `REPAID`; message
  pact on that event. proof (planned): `services/funding/test/kafka/capacity-events.kafka.test.ts#FS-17`
