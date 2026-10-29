# Handoff — 0006 Funding saga (branch `microservices`)

## Context

Branch `microservices` is a documented evolution demo, not the submission (`main` is). It
covers the job description's microservices, gRPC, Saga and Kubernetes asks by firing the revisit
triggers `main` wrote down: T3 new bounded context (ADR 023), gRPC adapter (ADR 024, supersedes
ADR 022 here), saga (ADR 025), Helm and kind (ADR 026), layout and side-by-side isolation
(ADR 027), contracts package and Pact after the cut (ADR 028), and an API gateway in kind
(ADR 029). Specs: `spec.md`, `tasks.md`.
After this lane is written, the branch moves to the worktree `../finverity-microservices`.

## What to load

1. `specs/0006-funding-saga/tasks.md`, then the ACs of the current task in `spec.md`.
2. The ADR the task names. For T1–T2: ADR 027. T3–T6: ADR 024, then ADR 006 (idempotency) and
   ADR 011 (auth). T7–T13: ADR 025 and ADR 023; ADR 006 for the receiver side. T15–T16: ADR 026.
   T16a: ADR 029, then ADR 026 (kind targets), ADR 011 (what the services still check) and the
   issuer paragraph of ADR 027.
3. Code for T4–T6: `src/capacity/adapters/in/http/{capacity.controller,schemas,problem,auth}.ts`,
   `src/capacity/application/shared/{problem,idempotent,fingerprint}.ts`,
   `.dependency-cruiser.cjs`, `test/support/app.ts`. For T1: `deploy/compose.yaml`, `Makefile`,
   `tools/doctor.sh`, the files listed in T1. For T16a: `deploy/helm/{capacity,funding,local-infra}`
   values (issuer, CORS, Service ports), the kind targets in `Makefile`,
   `test/architecture/isolation.test.ts`.

**What NOT to load:** PRD §8 reconciliation and treasury consumer, ADRs 007, 008, 010 and
013, the reconcile and treasury slices, `docs/*.ru.md`, the PDFs and HTML files in `docs/`,
the closed lanes' specs. None of them change here. Load PRD §6 (invariants) and §9 (REST, auth)
only if a task touches them.

## Owns

- deploy/compose.yaml
- deploy/oauth/**
- deploy/observability/**
- deploy/postgres/**
- deploy/helm/**
- deploy/helm/gateway/**
- deploy/kind/**
- Makefile
- .env.example
- .gitignore
- package.json
- package-lock.json
- harnessimo.config.json
- .dependency-cruiser.cjs
- vitest.config.ts
- eslint.config.js
- tsconfig.json
- Dockerfile
- .github/workflows/**
- tools/**
- db/seeds/**
- contracts/proto/**
- contracts/pacts/**
- src/capacity/adapters/in/boundary/**
- src/capacity/adapters/in/grpc/**
- src/capacity/adapters/in/http/**
- src/platform/**
- test/architecture/**
- test/architecture/gateway.test.ts
- test/support/**
- test/e2e/transports.e2e.test.ts
- test/e2e/grpc.e2e.test.ts
- test/fault/grpc-shutdown.fault.test.ts
- test/pact/**
- services/**
- packages/**
- README.md
- docs/architecture.md
- docs/api.md
- docs/runbook.md

## Depends on


## State

T1 done (2026-10-29): side-by-side isolation. `deploy/compose.yaml` has `name:
program-capacity-ms`, every host port from `HOST_PORT_*` (main's +10000), Kafka `EXTERNAL`
listener and advertisement on 39092, issuer, token URL and CORS on the shifted ports, image
`program-capacity-service:ms-local`. The Makefile exports the variables (and reserves
`KIND_CLUSTER := finverity-ms`, `KUBECONFIG_FILE := .kind/kubeconfig`; `.kind/` is gitignored);
`tools/`, `db/seeds`, `.env.example`, k6 (`Host` header), `tools/doctor.sh` (branch ports, warns on
missing kind/helm/kubectl) and `tools/isolation-live.sh` read the same variables. README and
runbook ports updated; `contracts/asyncapi.yaml` regenerated host (drift test).
Proof: `test/architecture/isolation.test.ts` (MS-01, MS-03 — 11 tests), `make isolation-live`
(MS-02). Live run with `main`'s stack up: `make up`, `make seed`, token and capacity read on
:13000 -> 200, main's :3000 still 200 with a main token, `make down` removed only
`program-capacity-ms` (main's five containers and `program-capacity-service:local` untouched).

`docker compose -p program-capacity ps` (main): api, kafka, oauth, postgres, worker all running
and healthy. `docker compose -p program-capacity-ms ps` (branch): api, kafka, oauth, postgres,
worker all running and healthy (migrate and kafka-init exited 0).

Not done in T1: the Funding/gRPC/payments-mock ports (60051, 13100, 19466, 19467, 13200) are in
ADR 027 but have no service yet; they come with T14. k6 `make load` was not run (the
scenario reads `HOST_PORT_API` and `HOST_PORT_OAUTH`). `docs/architecture.md` keeps container
ports (3000, 9464) because those are inside the containers.

`make test` after T1 (lead, 2026-10-29): green on the second run, 23/23 integration files,
100/100 tests. The first run lost two integration files in `beforeAll`: `startPostgres()`
(`test/support/capacity-world.ts:37`) did not come up, so `world.close()` threw in `afterAll`;
the same file alone passed 7/7. Not caused by T1, which touched no test support. Suspected Docker
load with `main`'s stack running alongside; unproven. If it recurs, capture the full log before
re-running and treat it as a flake to fix (container start timeout or int-project concurrency),
not as a regression.

T2 done (2026-10-29): root `workspaces: ["services/*", "packages/*"]`; `services/funding` and
`services/payments-mock` each with `package.json` (scripts lint, typecheck, depcruise, test:unit,
test:int), `tsconfig.json` (extends the root), `vitest.config.ts` (projects `unit`, `int`),
`.dependency-cruiser.cjs` (rule `no-cross-service-imports`; the hexagonal rules arrive with
funding's code) and one unit test. `make verify`, `make test` and `.github/workflows/ci.yml`
run `npm run <script> --workspaces --if-present` after the root step; `harnessimo.config.json`
scans `services/` and `packages/`. Root eslint still lints the services (no ignore: an ignore
at the root also hides files when a workspace runs eslint). `make test`: green on the first run,
23/23 integration files, 100/100 tests, 113 unit tests; the flake did not recur.
Proof: `test/architecture/workspaces.test.ts` (WS-01). No new dependencies; `package-lock.json`
gained only the workspace entries.

Next: T3 (proto contract and buf).

Facts checked on 2026-10-29 with `npm view` (re-check at T3): `@grpc/grpc-js` 1.14.6,
`ts-proto` 2.18.3, `@bufbuild/buf` 1.75.0, `@pact-foundation/pact` 17.1.4. `kind`, `helm` and
`kubectl` are installed in `/usr/local/bin`; `buf` and `kubeconform` are not (use the npm
`@bufbuild/buf`; kubeconform as in lane 0005). Ask the lead before adding any dependency.

## Decisions taken

- The split is T3 only; capacity is not cut; I1–I8, lock order and ADR 006 rules unchanged.
- Database per service: `funding` database and role; one PostgreSQL server locally, separate
  instances in production; no cross-database access (FS-14).
- Capacity stays at the repository root; new code under `services/`; no Nx, Turborepo or pnpm;
  moving capacity to `services/capacity` was rejected (it would move 67 closed-lane proof
  markers).
- gRPC: `@grpc/grpc-js` plus `ts-proto` stubs committed with a drift check; not the Nest
  microservices transport; zod stays the only validator; money as decimal strings on the wire;
  AIP-193 `ErrorInfo`; one client per tenant for funding's capacity token (no all-tenant token).
- Saga: orchestrated, hand-rolled, state on the `funding_request` row, `SKIP LOCKED` claim plus
  lease plus version check, deterministic keys `funding:<id>:<step>`, no transaction across a
  network call. Unknown disbursement → `NEEDS_ATTENTION`, never compensation. `EXISTING` from
  `Reserve` → not ours → `REJECTED`. Reserve retries end inside capacity's 24 h key retention.
  Compensation retries forever (`release_ref` never expires).
- Rejected and staying rejected even here: Temporal, choreography, 2PC/XA, Redis, event
  sourcing, GraphQL, service mesh, a Pact Broker, a schema registry, Bitnami charts. The API gateway
  is no longer in this list (owner ruling 2026-10-29, ADR 029): Envoy Gateway in kind only, no
  NestJS gateway, no Kong, no Redis-backed global rate limit.
- kind: cluster `finverity-ms`, kubeconfig `.kind/kubeconfig`, no host port mappings, smoke runs
  in-cluster (`helm test`), port-forwards on 23000–23099.
- Known trap (T1, T9, T11): mock-oauth2-server derives `iss` from the request's host. Tokens
  minted from the host carry `http://localhost:18081/default`; a service minting tokens inside
  the network must send the configured issuer's `Host` header, or capacity answers 401.
- In kind (ADR 029) there is one issuer, the in-cluster FQDN of the mock OAuth2 Service, held in
  one Makefile constant `KIND_OAUTH_ISSUER` and passed to capacity, funding and the gateway.
  In-cluster minters call that FQDN, never the short Service name; `make kind-token` sends its
  `Host`. A compose token is refused in kind by design.

## Owner decisions (2026-10-29)

1. Constraint 9 is amended on this branch: the Saga, Pact and gRPC items are lifted, and on
   this branch the agent amends any rule that blocks showing the evolution, citing the ADR.
   The `CONSTRAINTS.md` change is committed by the owner, because `harnessimo locked`
   refuses agent commits on that file.
2. The lane closes after T18, not at the cut line.
3. `main`'s Russian docs stay as they are; the branch gets new `docs/micro-srv-*.ru.md` (T17).

## First step

T3. Read ADR 024, ADR 006 and ADR 011, re-check the dated facts with `npm view`, and write
`test/architecture/proto.test.ts` with `GR-01 …` first. Ask the lead before adding the
dependencies (`@bufbuild/buf`, `ts-proto`, `@grpc/grpc-js`). Run `make verify`.
