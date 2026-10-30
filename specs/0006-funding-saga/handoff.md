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
- test/e2e/ops.e2e.test.ts
- test/e2e/grpc.e2e.test.ts
- test/fault/grpc-shutdown.fault.test.ts
- test/fault/shutdown.fault.test.ts
- src/platform/config/config.test.ts
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

T3 done (2026-10-29): `contracts/proto/finverity/capacity/v1/capacity_service.proto`
(`CapacityService` Reserve/Release/GetAvailability, `Money` as decimal string plus
`currency_code`, `ReserveResult` CREATED/EXISTING, `Capacity` as the REST view), `buf.yaml`
(STANDARD lint, FILE breaking), `buf.gen.{capacity,funding}.yaml`. Scripts `proto:lint`,
`proto:breaking`, `proto:generate`, `proto:check` (`tools/proto/{generate.ts,breaking.sh}`), all in
`make verify` and `.github/workflows/ci.yml` (the verify job now checks out with `fetch-depth: 0`).
Stubs (ts-proto, `outputServices=grpc-js`) are committed in
`src/capacity/adapters/in/grpc/generated/` (server) and
`services/funding/src/clients/capacity/generated/` (client); eslint and prettier ignore `**/generated`.
Baseline (T3 fix): `proto:breaking` compares the working tree with `HEAD` locally and, in CI, with
the PR base (`pull_request`) or `github.event.before` (`push`, skipped for the all-zero SHA); a base
without `contracts/proto` prints that and passes (buf cannot use an empty module as `--against`).
Rule recorded in ADR 024. GR-01 proves the check on a fixture that removes a field. Dependencies: `@grpc/grpc-js` 1.14.6 (runtime), `ts-proto` 2.18.3 and `@bufbuild/buf`
1.75.0 (dev), all re-checked with `npm view` on 2026-10-29. The generated code imports
`@bufbuild/protobuf/wire`: declared as a runtime dependency (2.16.0, what ts-proto 2.18.3 resolves)
in the root `package.json`, and with `@grpc/grpc-js` in `services/funding/package.json`; GR-01 fails
when a package imported under a `generated/` directory is not in the owning workspace's
`dependencies`. The two stub copies stay duplicated; ADR 028 / T18 moves them to `packages/contracts`.
Proof: `test/architecture/proto.test.ts` (GR-01, 8 tests).

T4 built (2026-10-29), **awaits architect review; the box in tasks.md is NOT ticked** (the proof
marker is still `proof (planned)`). Files to review: `src/capacity/adapters/in/boundary/{problem,
parse,auth,schemas}.ts`, `.../boundary/problem-map.test.ts` (GR-02, 4 tests), `.dependency-cruiser.cjs`
(exception in `adapters-do-not-import-each-other`, new `boundary-is-for-driving-adapters` and
`boundary-imports-no-transport`), and the HTTP side: `in/http/{problem,problem.filter,auth,
capacity.controller,queries.controller,query-schemas,openapi}.ts`, `src/platform/bootstrap/start.ts`
(import path only). Moves: `in/http/schemas.ts` -> `boundary/schemas.ts` (git rename); the verifier
and `Principal` -> `boundary/auth.ts`; `parse`, `money`, request-id check -> `boundary/parse.ts`.
The boundary throws a transport-neutral `BoundaryProblem(type, detail)`; the HTTP filter maps it
through `fromBoundary` (status and title from `PROBLEM_MAP`, `WWW-Authenticate` on 401,
`Retry-After: 1` on 503). `PROBLEM_MAP` entries are `{ title, http, grpc }` (gRPC as numeric
`GRPC_STATUS`, so no gRPC import); `STORED_PROBLEM_TYPES` and `RETRYABLE_GRPC_CODES` back the
GR-02 non-retryable rule. Not built here (T5): `ErrorInfo`/`google.rpc.Status` encoding.
No existing test edited (only the import lines of `auth.test.ts`); no new dependency.
`make verify` green (125 unit tests incl. 4 GR-02), `contracts:check` no diff, `make test`
green first run (23 int files / 100 tests; log in the session scratchpad `t4-test.log`).
Also: GR-01 stub-drift test now runs `node_modules/.bin/tsx`, ignores `npm warn` stderr lines and
asserts on exit code and the `drifted` message; proven to fail on an edited stub.

T4 reviewed (architect, 2026-10-30, at merge 74acf32): **APPROVE**. REST unchanged (same
status, `type`, `title`, `WWW-Authenticate`, `Retry-After`; `contracts/openapi.yaml` identical to
`main`; only import lines of `auth.test.ts` changed); the merge kept main's `/docs/asyncapi` and
T4's boundary import in `start.ts`. Layer rules probed in a scratch copy: `out/postgres` and
`in/kafka` importing the boundary, the boundary importing `in/http`, `@nestjs/common`, `express`
and `@grpc/grpc-js` all fail depcruise. `make verify` green, `make test` green (24 int files /
102 tests). Ruling on `fx-rate-unavailable` recorded in ADR 025 and DECISIONS.md.
Carried into T5 (MINOR, fix there):
- `RETRYABLE_GRPC_CODES` (`boundary/problem.ts`) is narrower than ADR 025's "Unknown" class: it
  omits `INTERNAL`, `UNKNOWN` and `UNAUTHENTICATED`. Replace the GR-02 check with an allowlist:
  every `STORED_PROBLEM_TYPES` entry maps to one of ADR 025's definite-failure codes
  (`FAILED_PRECONDITION`, `NOT_FOUND`, `ALREADY_EXISTS`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`).
- `boundary-is-for-driving-adapters` (`.dependency-cruiser.cjs`) is a denylist
  (`out|in/(kafka|jobs)`); a new `in/<x>` adapter could import the boundary. Make it an allowlist:
  `from: { path: '^src/capacity/adapters/', pathNot: ['^src/capacity/adapters/in/(http|grpc|boundary)/', NOT_TEST] }`.
- NOTE: the grpc adapter test asserts `GRPC_STATUS` equals `@grpc/grpc-js` `status` for each code
  it names (the boundary hand-numbers them).

T4 carry-overs done (commit 0292242): GR-02 now asserts the ADR 025 definite-failure allowlist
(proved by mapping `fx-rate-unavailable` to `INTERNAL`; reverted), `RETRYABLE_GRPC_CODES` removed;
`boundary-is-for-driving-adapters` is an allowlist (proved with a probe `in/cli/probe.ts`:
`error boundary-is-for-driving-adapters`; removed); `buildOpenApiDocument({ localApiHost })`
and `tools/contracts/render.ts` take `HOST_PORT_API` (default 13000), `contracts/openapi.yaml`
regenerated (`servers` only); `contracts:compat`: "OpenAPI: no breaking change; breaking=0".

T5 built (2026-10-30), **awaits architect review; the box in tasks.md is NOT ticked** (proof
marker still `proof (planned)`). Files to review: `src/capacity/adapters/in/grpc/{server,mapping,
status-details,status.test}.ts`; `boundary/problem.ts` (`isTransient` moved here from
`http/problem.filter.ts`); `src/platform/bootstrap/start.ts` (gRPC wiring, drain, `grpc` readiness,
`RunningApp.grpcPort`); `src/platform/config/config.ts` (+test) `GRPC_PORT`; `deploy/compose.yaml`,
`Makefile`, `.env.example`, `tools/doctor.sh` (host port `HOST_PORT_API_GRPC` 60051 -> 50051, the
ADR 027 plan), `test/architecture/isolation.test.ts`; `test/support/{grpc-client,app,fault-app}.ts`;
`test/e2e/grpc.e2e.test.ts` (GR-04, GR-05, GR-06), `test/fault/grpc-shutdown.fault.test.ts` (GR-07);
README and `docs/api.md` (short gRPC notes). No new dependency.
Design notes for the reviewer:
- Auth is a `ServerInterceptor` (`authenticate` + scope table, default-deny). It holds the message
  and half-close back until authentication resolves, so no use case or zod parse runs for an
  unauthenticated call. grpc-js itself already protobuf-decodes the message before the interceptor
  sees it; that cannot be avoided with the public API. The principal reaches the handler through a
  `WeakMap<Metadata, Principal>` (the handler's `call.metadata` is the interceptor's object;
  proven by the tests).
- `google.rpc.Status` + `ErrorInfo` are encoded by hand with `BinaryWriter` from the already
  declared `@bufbuild/protobuf` (no googleapis stub dependency); the test decoder is in
  `test/support/grpc-client.ts`.
- Deadline: checked after authentication, before the use case; grpc-js answers the client
  `DEADLINE_EXCEEDED` itself and the handler is not cancelled once the use case runs (GR-05).
- Proto: Release data now travels in `ReleaseResponse.release` (review fix below); the `capacity`
  echo is the REST CapacitySnapshot only, as the proto comments say.
- `ops.e2e.test.ts` now passes a free `GRPC_PORT` (fixed in the review round).

T5 review fixes done (2026-10-30, architect verdict CHANGES REQUIRED, rulings in 1393fef),
**awaiting re-review; T5 still NOT ticked**. MAJOR 1: proto `ReleaseResponse.release = 3` (new
`Release` message), `reservation = 1` deprecated and never set, both stub copies regenerated,
GR-06 asserts the `release` fields of two partial releases against the REST view. MAJOR 2: GR-04
test on a server of its own (verifier rejects after 200 ms, empty and valid programId, execute never
called); mutant with hold-back and principal check removed fails it (`code 3` instead of 16).
MINOR 1 compose host port is `127.0.0.1:${HOST_PORT_API_GRPC:-60051}:50051` (isolation regex
accepts the prefix). MINOR 2 `in/grpc/server.test.ts` calls the handler with a fake past-deadline
call (handlers exposed on `GrpcServer`; the deadline check now runs before the principal lookup);
with the check disabled it fails (`code 16` instead of 4). MINOR 3 proto comments on both
`capacity` fields. MINOR 4 `ops.e2e.test.ts` passes a free `GRPC_PORT` (added to Owns). NOTE 1 a
span for interceptor auth failures.

T5 re-reviewed (architect, 2026-10-30, at 76d6020): **APPROVE**; T5 ticked with the four markers.
Probes re-run in a scratch copy: skipping JWT verify, dropping the `idempotency-key` mapping,
mapping a stored problem to UNAVAILABLE, skipping the scope check or default-deny, swapping
CREATED/EXISTING, reporting a JWKS outage as UNAUTHENTICATED, removing the deadline check (now
caught by `in/grpc/server.test.ts#GR-05`), the old release mapping, a constant release reason and a
blank `releaseRef` all fail a test; forwarding message and half-close synchronously (with or
without the handler's principal check) fails 12 / 14 tests. Correction to the first review: its
"P9b" mutant still waited for authentication before forwarding, so it was weaker than reported;
the late-rejection GR-04 test kills the strong one. Rulings in DECISIONS.md (2026-10-30, T5 re-review).
Carried (MINOR, fix in T6 unless noted):
- Swapping `repaid_amount` and `released_amount` in `mapping.ts` survives: GR-06 releases on a USD
  program with a USD invoice, where both are equal. T6's cross-transport release case must use a
  cross-currency reservation (EUR invoice on a USD program) and compare both amounts.
- Flake (a), port race, also on `main`: `freePort()` (`test/support/app.ts:10`) picks a port, closes
  it, and the app binds later on `0.0.0.0`. On macOS another process can take the port on
  `127.0.0.1` meanwhile, and the wildcard bind still succeeds, so the test's `127.0.0.1` request
  reaches that process ("Proxy key is incorrect", 503). Fix here before T6 adds more servers: the
  config accepts port `0` for `HTTP_PORT`, `OPS_PORT` and `GRPC_PORT`, `RunningApp` reports the
  bound HTTP, ops and gRPC ports, and `test/support/{app,fault-app}.ts` and `ops.e2e.test.ts`
  pass `0` and build URLs from `RunningApp`. `freePort()` stays only for "nothing listens here".
- Flake (b), backend teardown, also on `main`: `test/fault/shutdown.fault.test.ts:71` (and
  `grpc-shutdown.fault.test.ts:92`) reads `pg_stat_activity` once right after the pool closed; a
  PostgreSQL backend leaves the view shortly after its client disconnects. Fix: poll with
  `waitFor` until the count is 0 (deadline a few seconds) and keep the 25 s budget assertion.
- NOTE: `GrpcServer.handlers` is exposed for the unit test; keep it out of any non-test caller.

Flakes fixed (2026-10-30, after the T5 re-review). (a) Port race: `HTTP_PORT`, `OPS_PORT` and
`GRPC_PORT` accept `0` (config `min(0)`; production validation still takes any 0..65535, and 0 is
harmless there: the OS picks a port that nothing advertises, so the pod fails its probes instead
of binding something unsafe). `RunningApp.httpPort` is now the bound port (`getHttpServer().address()`),
`opsPort` and `grpcPort` already were. `test/support/{app,fault-app}.ts` and `ops.e2e.test.ts`
pass `0` and build URLs from `RunningApp`; `freePort()` stays for "nothing listens here" URLs
(`grpc.e2e.test.ts`, `outage-containers.ts`) and the Kafka support. Regression test
`ops.e2e.test.ts#SK-04 binds port 0 ...`: a stand-in holds 127.0.0.1:<p>; asking the app for <p>
either fails with EADDRINUSE (Linux) or binds and `127.0.0.1:<p>` answers as the stand-in
(macOS); port 0 returns a different real port that answers 401 problem+json as this service.
`config.test.ts#SK-03 accepts port 0` covers the config. (b) Backend teardown: both shutdown
fault tests `waitFor` the `pg_stat_activity` count to reach 0 (5 s deadline) and keep the 25 s
budget assertion. `make verify` green; `make test` three runs in a row, logs
`flake-run{1,2,3}.log` in the session scratchpad: see PROGRESS for the counts.

Patch note for `main` (do not apply here; main has no gRPC): port these unchanged:
`src/platform/config/config.ts` (the `port` schema `.min(0)`, drop the `GRPC_PORT` line),
`src/platform/config/config.test.ts` (the port-0 test, without `GRPC_PORT`),
`src/platform/bootstrap/start.ts` (the `HttpServer` import, `let httpPort`, the three lines after
`http.listen` that read the bound port, `httpPort` in the log and in the returned `RunningApp`;
drop the `grpc` parts), `test/support/app.ts` (`HTTP_PORT`/`OPS_PORT` `'0'`, `baseUrl` from
`app.httpPort`; drop `grpcTarget`), `test/support/fault-app.ts` (same, drop gRPC), `test/e2e/ops.e2e.test.ts`
(`'0'` ports, `app.httpPort`, the new regression test minus `GRPC_PORT: '0'`; its local `freePort`
goes), `test/fault/shutdown.fault.test.ts` (the `waitFor` hunk at the end of the first test).
`test/fault/grpc-shutdown.fault.test.ts` is branch-only.

T6 done (2026-10-30; not a [review] task, so ticked): `test/support/capacity-client.ts`
(`CapacityClient` over REST and gRPC; money, problem slug = `ErrorInfo.reason`, REST
`invoiceAmount` of a release normalised to `repaidAmount`) and `test/e2e/transports.e2e.test.ts`
(GR-03, 21 tests). Cases per transport, titles `AC-xx (http|grpc) ...`: AC-01 (50 concurrent),
AC-02 (5 concurrent + a later replay, one ledger entry), AC-03, AC-04, AC-05 (EUR invoice on a
USD program, three releases, sum exactly USD 1,100,000.00, `repaidAmount` EUR asserted per
step), AC-06, AC-13, AC-16, AC-17, FR-01. Plus `AC-05 REST and gRPC agree on repaid and released
amounts ...`: the same EUR 40.00 release on a program of each transport, whole release views
equal, repaid EUR 40.00 and released USD 44.00. Failure codes are asserted against a table in
the test (HTTP status and gRPC code per problem), independent of `PROBLEM_MAP`. No existing test
changed. Mutants (each reverted; logs `mut-*.log` in the session scratchpad): swapping
`repaidAmount`/`releasedAmount` in `mapping.ts` fails AC-05 (grpc), AC-06 (grpc) and the
cross-transport case; `insufficient-capacity` -> UNAVAILABLE fails AC-01, AC-17; `status === 201`
inverted fails AC-02, AC-04, AC-17; `idempotency-key-mismatch` -> ABORTED fails AC-03;
`reservation-conflict` -> FAILED_PRECONDITION fails AC-04; `release-exceeds-remaining` and
`release-ref-mismatch` remapped fail AC-06; `not-found` -> PERMISSION_DENIED fails AC-13, FR-01;
`forbidden` -> UNAUTHENTICATED fails AC-13; `reservedAmount` from `releasedAmount` fails AC-01,
AC-04, AC-05, AC-17; capacity `reserved` from `available` fails AC-01, AC-03, AC-04, AC-05,
AC-16, FR-01; `overLimitBy` from `available` fails FR-01. Only tenant isolation itself (AC-16,
AC-13 in the interceptor) is not a mapping concern and was not mutated here.
`make verify` green; `make test` green first run: unit 30 files / 143 tests, integration 27
files / 140 tests (log `t6-test.log` in the session scratchpad).

T7 built (2026-10-30), **awaits architect review; NOT ticked** (marker placed, box `[ ]`). Files:
`services/funding/src/funding/domain/{saga,outcome,funding-request,keys,money,risk,config,result,index}.ts`
with unit tests, `services/funding/test/property/saga.property.test.ts` (FS-01), the `unit` vitest
project now includes `test/property`, `eslint.config.js` (no-`number` block extended to the funding
domain), `services/funding/.dependency-cruiser.cjs` (`domain-imports-only-domain`). Design points for
the reviewer: `applyOutcome(request, StepOutcome, {now, config, random})` is the whole table and refuses
terminal / parked requests and an outcome of a step that is not due (`step-mismatch`, the stale
executor case); state change resets `attempts` and makes the next step due at once; the reserve
deadline check is `now >= reserveDeadlineAt` evaluated when an unknown outcome arrives; `existing`
while resolving a compensation is FAILED (nothing of ours held); a definite Release failure and a
resolution-limit timeout are NEEDS_ATTENTION with alert. The property test draws outcomes from a
world model (landed reservation, paid rail) so only consistent answers occur; mutant "disburse
deadline -> COMPENSATING" fails FS-01 and FS-10.

Facts checked on 2026-10-29 with `npm view` (re-check at T3): `@grpc/grpc-js` 1.14.6,
`ts-proto` 2.18.3, `@bufbuild/buf` 1.75.0, `@pact-foundation/pact` 17.1.4. `kind`, `helm` and
`kubectl` are installed in `/usr/local/bin`; `buf` and `kubeconform` are not (use the npm
`@bufbuild/buf`; kubeconform as in lane 0005). Ask the lead before adding any dependency (T3 added the three proto dependencies).

Merge of `main` (4 commits: AsyncAPI outbound events, Kafka UI, local-stack docs) into this branch,
2026-10-30: Kafka UI is `HOST_PORT_KAFKA_UI` (default 18080); `renderAsyncApiYaml` takes the host
from `HOST_PORT_KAFKA` (default 39092) via the `localKafkaHost` option of `buildAsyncApiDocument`,
so `contracts/asyncapi.yaml` stays generated; `tools/simulator/contracts.ts` (deleted on `main`)
is deleted; MS-01 now also covers 8080, Kafka UI, local-stack/qa/runbook docs and the AsyncAPI host.
`contracts:compat` and `make compat` default to base `HEAD` (CI: PR base / push before), not
`origin/main`, as in ADR 024 for proto. Docs from `main` carry the branch ports.

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

Start T7 (ADR 025, ADR 023): `services/funding/src/funding/domain`, the saga state machine as
pure code, property test `services/funding/test/property/saga.property.test.ts#FS-01`.

## T7 closed, T8 and T9 built (2026-10-30, agent `funding`)

T7: review findings closed. `deadlinePassed()` in `saga.ts` treats a missing deadline as passed
(reserve, resolution, disburse); tests FS-09 x3 and FS-10 added, incl. `EXISTING -> FAILED` while
resolving a compensation. FS-01 green, T7 ticked.
T8: `deploy/postgres/init-databases.sh` (roles `capacity`/`funding`, CONNECT revoked from PUBLIC),
migrations 0001/0002 (CHECKs: a step state always has its deadline; append-only `saga_step_attempt`
by trigger), Testcontainers helper `test/support/postgres.ts`. Proof FS-14.
T9: REST adapter, JWT (`aud` funding-service), idempotency per ADR 006, RFC 9457, OpenAPI from zod
with drift check, mock OAuth2 mappings. Proof FS-02.
Also: root `vitest.config.ts` unit project `testTimeout: 30_000` (buf and the AsyncAPI parser took
>5 s under parallel load and failed `make verify`).

Check results:
- `make verify` (verify3.log): `✔ verify passed`.
- `npx harnessimo check`: `harnessimo: every check required at "watched" passes.`
- funding `vitest run --project int`: `Test Files 2 passed (2)  Tests 15 passed (15)` (FS-14, FS-02).
- `make test`: **no single green run.** Full run: `Test Files 11 failed | 16 passed (27)`, all
  `beforeAll` Testcontainers startup timeouts (Docker host shared with other agents: 17 postgres + 7
  kafka containers, load 11-25; errors `address already in use`, `Kafka Server started not
  received`, `all broker connections are down`). No code changed between runs. Re-running the failed
  files alone: schema + migrations (1 SK-05 failure under load), then 9 files (3 passed), then the
  last 6: `Test Files 6 passed (6)  Tests 17 passed (17)`. So each of the 27 root files has passed
  with this code; a full serial `make test` on a quiet host is still owed (coordinator).

## Architect review of T7 fixes, T8, T9 (2026-10-30): APPROVE WITH FIXES

No BLOCKER, no second review. Rulings in `.harness/4-state/DECISIONS.md` (2026-10-30, T7
fixes, T8, T9). Fix in the `funding` lane before T11:

1. M1 `deploy/oauth/config.json`: `match` is a regex. Scope mapping `".*funding:.*"`, client
   mapping `"funding-service\\..+"`; a compose check mints a funding token and asserts `aud`.
2. m1 `services/funding/src/funding/adapters/in/http/server.ts`: authenticate every `/v1/`
   request before routing; 405 gets type `method-not-allowed`.
3. m2 `deploy/compose.yaml`: postgres healthcheck `pg_isready -h 127.0.0.1 -U funding -d funding`;
   runbook: `make down -v` once for volumes created before 9b89069.
4. m3 `services/funding/test/e2e/api.e2e.test.ts`: FS-02 cases for a 409 stored and replayed
   under a key, and JWKS outage → 503 with `Retry-After`.
5. m4 (T11): the capacity-client token request sends `tenant_id`; a test asserts the claim.

Checked by the reviewer: `make verify` → `✔ verify passed`; `npx harnessimo check` →
`every check required at "watched" passes`. `make test` not run by the reviewer (the
coordinator's serial run owns it).

### Serial `make test` on a quiet host (2026-10-30, owed above) — green

Docker held only the main stack and kind. Tail of the run:

```
root unit:        Test Files 30 passed (30)   Tests 143 passed (143)
funding unit:     Test Files  6 passed (6)    Tests  27 passed (27)
payments-mock:    Test Files  2 passed (2)    Tests   8 passed (8)
root int:         Test Files 27 passed (27)   Tests 140 passed (140)
funding int/e2e:  Test Files  2 passed (2)    Tests  15 passed (15)
✔ all tests passed
```

The earlier failures were Docker-host contention, not code.

### Review fixes M1, m1–m3 (2026-10-30, agent `funding`)

M1: `deploy/oauth/config.json` matches are `funding-service\\..+` and `.*funding:.*`; unit test
`test/unit/oauth-mapping.test.ts` replays mock-oauth2-server's first-match, whole-value regex rule
over the committed file and asserts `aud`. The live check (mint from the real mock container)
is not written yet: it needs Docker. m1: every `/v1/` request is authenticated before routing;
405 is `method-not-allowed` with `Allow`. m2: compose healthcheck `pg_isready -h 127.0.0.1 -U
funding -d funding`, runbook entry "first boot after the database split" (`make down -v` once).
m3: three new FS-02 e2e cases (409 stored and replayed under a key; JWKS outage -> 503 with
`Retry-After`; auth before routing). m4 is for T11.
`make verify`: `✔ verify passed` (funding unit 7 files / 30 tests). **The three new e2e cases in
`api.e2e.test.ts` and the live mock-token check have not been run:** Docker belongs to k8s until the
coordinator releases it; run `vitest run --project int` in `services/funding` first thing after.

T18 done (2026-10-30, branch `ms-contracts`): `packages/contracts` (`@finverity/contracts`) holds
the proto, the committed ts-proto stubs (`src/generated`), the JSON Schemas of `capacity.events.v1`
(8) and `funding.events.v1` (5), `compare-schemas` and the CT-04 check. Root `proto:*` and
`schema:compat` delegate to the package (`-w @finverity/contracts`); `make verify` and `make compat`
run `schema:compat` against `BASE` (CI passes the PR base or `github.event.before`). Capacity
imports `@finverity/contracts/capacity/v1`; the old `contracts/proto`, `contracts/json-schema`,
`tools/proto`, `src/capacity/adapters/in/grpc/generated` and funding's `src/clients` copy are gone.
The Dockerfile compiles the package with `tsc` and swaps it for the workspace link in the build
and runtime stages (image smoke: `import('@finverity/contracts/capacity/v1')` ok).
Proof: `test/architecture/workspaces.test.ts#CT-01`, `packages/contracts/test/schema-compat.test.ts#CT-04`.
`services/funding` files changed (for the merge with `microservices`): `package.json` (+dependency
`@finverity/contracts`), and the stub copy `src/clients/capacity/generated/finverity/capacity/v1/capacity_service.ts`
moved to `packages/contracts/src/generated/...` (deleted from funding; funding's own import paths
are not touched here because the branch has no client code yet).
Checks (serial, Docker free, 2026-10-30):
- `make verify`: green (30 unit files / 144 tests; `schema:compat: base d97709c; 8 base and 13 current event schema(s); breaking=0`). Two earlier runs failed on timeouts under machine load (AsyncAPI NFR-14 5 s parse, `generate.ts` spawn); both pass alone.
- `make test`: `Test Files 27 passed (27)`, `Tests 140 passed (140)`, exit 0. A run under three parallel Docker suites timed out (outage fault test, 120 s) and was stopped; not a regression.
- `docker build .`: exit 0; `docker run ... import('@finverity/contracts/capacity/v1')` -> `import ok 24`.
- `npx harnessimo check`: `harnessimo: every check required at "watched" passes.` (89 proof markers, task gate ok).

### `make test` on the merged tree (07f7256 + review fixes 4edf1c7), 2026-10-30 — green

```
root unit:        Test Files 30 passed (30)   Tests 144 passed (144)
funding unit:     Test Files  7 passed (7)    Tests  30 passed (30)
payments-mock:    Test Files  2 passed (2)    Tests   8 passed (8)
contracts:        Test Files  1 passed (1)    Tests   9 passed (9)
root int:         Test Files 27 passed (27)   Tests 140 passed (140)
funding int/e2e:  Test Files  2 passed (2)    Tests  18 passed (18)
✔ all tests passed
```

This also runs the three review-fix e2e cases (stored 409 replay, JWKS outage 503, auth before
routing) that were unrun at 4edf1c7.
