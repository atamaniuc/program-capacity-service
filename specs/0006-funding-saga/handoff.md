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

### T15 – T16a (agent `k8s`, branch `ms-helm`, 2026-10-30)

Done: T15 ticked (commit `5206901`, `make helm-check`). T16: `deploy/kind/cluster.yaml`,
`kind-up`, `kind-seed`, `kind-smoke`, `kind-forward`, `kind-token`, `kind-down`, K8-04 tests in
`test/architecture/isolation.test.ts`. T16a: chart `deploy/helm/gateway`, `GW-05` static tests in
`test/architecture/gateway.test.ts`, `helm test gateway` (GW-01..05 live).

Checks (quoted from the logs; the machine was overloaded by parallel runs, so an earlier
`make test` / `make verify` hit the 5 s default timeout in `GR-01` (`buf generate`) and `NFR-14`
(AsyncAPI parser); both pass alone and the coordinator then ran `make test` serially):

- `make test` serial: `✔ all tests passed`, `MAKE_TEST_EXIT=0`, unit 31 files / 150 tests, int 27 files / 140 tests.
- `make verify`: `✔ verify passed`, `VERIFY_EXIT=0`.
- `npx harnessimo check`: `harnessimo: every check required at "watched" passes.`
- `make helm-check`: `✔ helm-check passed` (gateway chart: 12 resources found with the gateway kinds skipped by name).
- `make kind-up`: exit 0 (cluster `finverity-ms` reused; capacity and local-infra upgraded, Envoy Gateway `v1.9.3` as release `eg`, release `gateway`, 6 programs and 200 invoices seeded).
- `make kind-smoke`: `✔ kind smoke passed`; `helm test capacity`: `OK capacity: 401 without token, 404 with token, gRPC port open`; `helm test gateway`: `9 passed, 0 failed, 2 skipped`.

Found live and fixed: (1) Envoy Gateway creates the proxy Service `gateway-edge` in
`envoy-gateway-system`, not in `finverity-ms`: the smoke Pod addresses it by FQDN (`proxyNamespace`
value) and `kind-forward` forwards with `--namespace envoy-gateway-system`. (2) `helm --wait` does
not wait for the proxy: `kind-up` now waits for `gateway/edge` Programmed and the proxy Deployment.
(3) A token with the wrong `aud` is answered **403** by Envoy's JWT filter, not 401; GW-02 and
ADR 029 are amended (the request is still refused at the edge and never reaches the service).

NOT exercised by the live smoke (do not read the green run as covering these):
- funding: no `services/funding/Dockerfile` yet, so no `funding` or `payments-mock` release;
  skipped: GW-01 funding route (POST 202 + `Location`), GW-03 for funding, `helm test funding`
  and the K8-03 saga scenario (one funded request, one compensated); the mock OAuth2 config
  still issues only `aud=capacity-service`, so a funding-audience token does not exist yet.
- GW-02 with an expired token and CORS preflight at the edge; GW-04 only with tenants minted
  from the in-cluster issuer.
- GW-05 live: the gRPC path is shown not routed (404 or `UNIMPLEMENTED`), but "capacity records
  no gRPC call" is not checked.
- calls through `make kind-forward` (`Host: localhost:…`) and `make kind-token` from the host.
- K8-04 is checked statically only; `make kind-down` was not run (the cluster stays up by the
  coordinator's order).
- GW-02 bad signature and foreign `iss` ran on the capacity route only; GW-04 with a token lacking
  `tenant_id` is not limited (no header, so the `Distinct` selector does not match). The mock always
  sets `tenant_id` and the services answer 401 without it: accepted for kind, revisit with a real IdP.
- The funding half of GW-01 (POST 202 + `Location`) is written but has never run: it needs the
  funding release and the mock's `funding:` scope mapping (M2 b).
- `make test` was not re-run after the last Makefile/chart/doc edits (they touch no code under
  `src/`); `make verify` and `harnessimo check` were.

### Architect review of T16 + T16a (732e7a5, 39f15e4): APPROVE WITH FIXES

Rulings in DECISIONS.md (2026-10-30). T16 and T16a stay ticked; fix before the funding release
lands in kind (agent `k8s`, one commit, then `make verify`, `make helm-check`, `harnessimo check`).

- [x] **M1 — funding mints capacity tokens at the short Service name in kind.** `Makefile` kind-up
  (funding release, ~line 75) passes only `oauth.issuer`; `deploy/helm/funding/values.yaml:11`
  defaults `oauth.tokenUrl: http://oauth:8080/default/token`, so funding's per-tenant capacity
  tokens carry `iss=http://oauth:8080/default` and capacity answers every saga reserve
  `UNAUTHENTICATED` (ADR 029 "Every in-cluster token minter … calls the token endpoint at that same
  FQDN"). Fix: add `--set-string oauth.tokenUrl=$(KIND_OAUTH_ISSUER)/token` to the funding
  release; extend K8-04's static test (or a new GW-test) to assert the Makefile passes both
  `oauth.issuer` and `oauth.tokenUrl` from `KIND_OAUTH_ISSUER`.
- [ ] **M2 — the funding half (a) done in the review-fix commit: the smoke now mints a `funding:write funding:read` token and checks POST 202 + `Location`; (b) DONE after the merge of `microservices` (the `local-infra` copy is byte-equal to `deploy/oauth/config.json`; static test `K8-01` in `test/architecture/isolation.test.ts` fails on drift); (c) OPEN, runs in the live kind run after T14. Earlier text: (b) was to be synced after the merge, because funding already changed `deploy/oauth/config.json` on `microservices` (mapping by scope `.*funding:.*` → `aud=funding-service`) and this branch must not edit it; then the `local-infra` copy is synced (`make helm-check` compares them); (c) runs in the live kind run after T14.** Original text: the funding half of GW-01/GW-02 cannot turn green on its own.** (a)
  `deploy/helm/gateway/templates/tests/smoke.yaml:471-474` is a placeholder that `assert.fail`s
  once `fundingDeployed=true`, and its message points at T9, which is done. Write the check now:
  mint a token with `aud=funding-service` from `ISSUER/token`, `POST /v1/funding-requests` with an
  `Idempotency-Key` and a seeded program, expect 202 and `Location` matching
  `^/v1/funding-requests/`. (b) `deploy/oauth/config.json` (and its byte-equal copy
  `deploy/helm/local-infra/files/oauth-config.json`) issues only `aud=capacity-service`, so no
  funding-audience token exists: add a request mapping chosen by a token-request parameter (for
  example `audience=funding-service`) before the wildcard one, keep the wildcard's
  `aud=capacity-service` so compose and capacity tests are unchanged. (c) Once (b) exists, run the
  bad-signature and foreign-issuer GW-02 steps on the funding route too, and the GW-03 funding
  step with a foreign-issuer token as well as without a token (the capacity step already does both).
- [x] m1 — `test/architecture/gateway.test.ts` checks only GW-05. The edge-security properties are
  enforced only by the live smoke, which CI does not run. Add static assertions over the rendered
  chart: one `SecurityPolicy` per `HTTPRoute`, `audiences` equals that route's audience
  (`capacity-service` / `funding-service`), `issuer` equals the value passed, `claimToHeaders`
  `tenant_id → x-tenant-id`; the `ClientTrafficPolicy` targets `Gateway/edge` and removes
  `x-tenant-id` in `earlyRequestHeaders`; each `BackendTrafficPolicy` selects `x-tenant-id` with
  `type: Distinct`. Name them `GW-02`/`GW-04 (static)`; each must fail when its line is removed.
- [x] m2 — K8-04 does not assert the most dangerous kind call: `kind create cluster` without
  `--kubeconfig` writes `~/.kube/config` and switches the user's current context. Add: every
  recipe line matching `\bkind (create|export|delete)\b` contains `--kubeconfig $(KUBECONFIG_FILE)`.
- [x] m3 — `.dockerignore` does not list `.kind/`: `docker build .` in kind-up sends the cluster's
  admin kubeconfig into the build context. The current Dockerfile copies paths explicitly, so it
  does not reach the image, but add `.kind` (and keep the funding/payments Dockerfiles explicit).
- [x] m4 — `docs/adr/029-api-gateway.md` "Authentication at the edge" still says "A request without
  a valid token answers 401 and does not consume a rate-limit token"; say "is refused (401, or 403
  for a wrong audience)". `docs/api.md` (T17) lists the edge 403 next to the service's 401 for the
  same wrong-`aud` token, so a client sees which layer refused it.
- [x] m5 — note in the handoff's "NOT exercised" list: GW-02 bad signature and foreign `iss` ran on
  the capacity route only; GW-04 with a token lacking `tenant_id` is not limited (no header, the
  `Distinct` selector does not match). The mock always sets `tenant_id` and the services answer
  401 without it, so this is accepted for kind; revisit with a real IdP.

### T14 images for kind (agent `k8s`, branch `ms-helm`, 2026-10-30)

`services/funding/Dockerfile` and `services/payments-mock/Dockerfile` (build context = repository
root, multi-stage like the root Dockerfile; `@finverity/contracts` compiled and swapped in as in
T18; funding installs only its own production dependencies). `tsconfig.build.json` and the
`build` / `start` scripts in both packages (`node dist/main.js`; funding's `build` also copies the
SQL migrations). Both images built with `docker build` and smoke-run: contracts resolve, migrations
are in the image, the services stop on a missing configuration, payments-mock answers on 3200 (API)
and 9466 (ops `/health/live`). `kind-up` builds and loads all three images and installs
`local-infra` (payments-mock on), `capacity`, `funding` (`oauth.tokenUrl` from `KIND_OAUTH_ISSUER`)
and `gateway`, with no skip branches left. Chart fixes found while wiring: the funding worker
runs `node src/worker.js`, the migrate Job runs the real path, the configmap says
`PAYMENTS_BASE_URL` (what `worker-config.ts` reads), payments-mock gets `PAYMENTS_PORT`.

Open before the live run (K8-03, M2(c)); not exercised, nothing was installed in kind:
- funding's `api` and `worker` expose no ops port yet (`main.ts` serves only HTTP; no
  `/health/ready` or `/health/live` on 9464), while the chart's probes need them; until the funding
  agent adds the ops server (or the probes move), `helm upgrade --install funding --wait` times out.
- `deploy/compose.yaml`, the payments host port 13200 -> 3200 and ops 9466, alerts and the demo
  are the funding agent's T14 part; the `test.saga` flag of `helm test funding` is still off.

### Live kind run with funding (agent `k8s`, 2026-10-30, after merging T11–T14 `08760a5`)

`make kind-up`: exit 0, funding api/worker Ready (ops 9464 probes match T14), payments-mock up,
gateway Programmed. `make kind-smoke`: `SMOKE_EXIT=0`, `✔ kind smoke passed`:
`OK capacity: 401 without token, 404 with token, gRPC port open`;
`OK funding: ready, 401 without token`;
`OK saga: completed (+100.00), declined request compensated (reserved back)` (K8-03);
`helm test gateway`: `13 passed, 0 failed, 0 skipped`, including the funding half (M2 c): GW-01 POST
202 + `Location`, GW-02 bad signature and foreign `iss` on the funding route, GW-03 funding with no
token and with a foreign `iss`.

Found live and fixed (chart, not funding code): the mock OAuth2 Deployment had no config checksum,
so after the mapping change the old Pod kept issuing `aud=capacity-service` for `funding:` scopes
and funding answered the saga submit 401; `checksum/config` on the Pod template now restarts it
(static test K8-01). The cluster `finverity-ms` is left up.

Still NOT exercised (do not read the green run as covering these):
- `make kind-forward` / `make kind-token` from the host through the gateway (`Host: localhost:…`):
  the one attempt was blocked by the tool permission layer (a broad process kill) and not retried.
- GW-02 with an expired token and the CORS preflight at the edge; GW-05 live "capacity records no
  gRPC call".
- K8-03 runs the saga directly against the funding Service, not through the gateway; compensation
  after a capacity-side failure and the `FAULT-TIMEOUT` / `FAULT-5XX` markers are not driven in kind.
- `make test` was not re-run in this worktree after the merge; `make kind-down` was not run.

### T23 CI (agent `k8s`, 2026-10-31)

`.github/workflows/ci.yml`: job `charts` (`azure/setup-helm@v5.0.1`, helm `v3.22.1`, which passes
`make helm-check` locally; `make helm-check` downloads kubeconform at its pinned version and checks
the archive's SHA-256); `image` builds `services/funding` and `services/payments-mock`; job `kind`
(`helm/kind-action@v1.15.1` with `install_only: true`, kind `v0.33.0`, kubectl `v1.35.8`,
`actions/upload-artifact@v7.0.2`; `timeout-minutes: 30`) runs `make kind-up` and `make kind-smoke`
only. Versions checked with `gh api` on 2026-10-31. Static proof: `test/architecture/ci.test.ts`
(T23): exact make targets, microservices-only condition, no cluster/kubeconfig/port inputs on the
action, artifact on failure; each assertion was mutation-checked.

NOT verified: the workflow has never run on GitHub (the branch is pushed by the coordinator only at
the very end), so the `kind` job's first real run may still need fixes (runner resources, `nc` for
`kind-seed`, image pulls, Envoy Gateway OCI install from `docker.io`, the 30-minute budget).
`actionlint` is not installed here and was not run; the YAML parses and the static test reads it.

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
   runbook: `make down` once (it deletes the volumes) for volumes created before 9b89069.
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
funding -d funding`, runbook entry "first boot after the database split" (`make down` once).
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

## T11 built (2026-10-30, agent `funding`) — awaits the batched review after T13

Files (`services/funding`): `src/funding/application/{saga-ports,saga-driver}.ts`;
`adapters/out/postgres/saga-store.ts` (claim `FOR UPDATE SKIP LOCKED` + lease + version bump in one
short transaction; record = `UPDATE … WHERE id AND version = claimed`, attempt row, outbox row when
the transition has an event, one transaction; zero rows = lease lost, result dropped);
`adapters/out/grpc/capacity-gateway.ts` (token per tenant, step key and `x-request-id` in
metadata, deadline, one token refresh on `UNAUTHENTICATED`, `ErrorInfo.reason` decoded, body a pure
function of the persisted request); `adapters/out/http/payment-rail.ts` (lookup first after an
unknown attempt; 404 on lookup -> POST again with the same key; 409/400/unparseable stay unknown);
`adapters/out/oauth/token-provider.ts` (m4: sends `tenant_id`; uses `node:http` because `fetch`
ignores a custom `Host`, which the mock issuer's `iss` depends on); `src/worker.ts` and
`src/worker-config.ts` (boot validation: resolution limit < 24 h and >= reserve deadline, lease >
one call, gRPC deadline > capacity's 20 s lock+statement budget; durations `2m`/`12h`; risk limits
`FUNDING_RISK_LIMITS`). Tests: unit (config, token provider incl. m4, payment rail, capacity gateway
against a fake capacity gRPC server generated from the same proto), integration `saga.int.test.ts`
(FS-04, FS-05, a fake-backed FS-03 path, FS-07 retry bytes) and `driver.int.test.ts` (claim and
lease, FS-12 part), system `saga.system.test.ts` (FS-03 on the real capacity image behind
Toxiproxy with PostgreSQL, mock OAuth2 and the payments mock as a child process; also the live
M1 and m4 token checks). Harness: `test/support/{system-stack,saga-world,fake-capacity}.ts`.
`services/funding/package.json`: two devDependencies (`@testcontainers/toxiproxy`, `testcontainers`).

Decisions for the reviewer: outbox rows exist only for event-carrying transitions (Received,
Completed, Rejected, Failed, NeedsAttention); FS-03's "one outbox row per transition" is stated that
way in spec.md. The ledger actor for funding is `funding-service.<tenant>` (the per-tenant client).
First system run builds the capacity image (~7 min); later runs reuse the layer cache (~45 s).
The worker has no health endpoint or metrics yet (T14). Payments-mock fault markers are in spec.md.

Checks: `make verify`: `✔ verify passed`. `make test` (one serial run):

```
root unit:        Test Files 30 passed (30)   Tests 144 passed (144)
funding unit:     Test Files 11 passed (11)   Tests  54 passed (54)
payments-mock:    Test Files  2 passed (2)    Tests   8 passed (8)
contracts:        Test Files  1 passed (1)    Tests   9 passed (9)
root int:         Test Files 27 passed (27)   Tests 140 passed (140)
funding int/sys:  Test Files  5 passed (5)    Tests  33 passed (33)
✔ all tests passed
```

## T12 built (2026-10-30, agent `funding`) — awaits the batched review after T13

No new production code: T11's domain table and driver already implement the paths; T12 proves
them. Integration (`saga.int.test.ts`, fake capacity from the proto, real PostgreSQL): FS-09
(unknown Reserve past the deadline -> same-key repeat -> `CREATED` is released -> FAILED; repeat is
a definite failure -> FAILED with no release; still unknown past the resolution limit ->
NEEDS_ATTENTION with alert), FS-10 (unknown disbursement retried with lookup first and the same
key, completes when the rail answers; after the deadline NEEDS_ATTENTION with the reservation held,
no release, alert, and no step due), FS-06 and FS-11 at the driver level (declined payment ->
Release with `funding:<id>:compensation`; release retried 7 times without a deadline under the same
key; `release-exceeds-remaining` counts as compensated; `NOT_FOUND` -> NEEDS_ATTENTION). System
(`saga.system.test.ts`, real capacity image behind Toxiproxy): FS-06 (decline -> `RESERVE` then
`RELEASE` by `funding-service.bank-a`, `reserved` back to its value, reservation RELEASED, release
ref and `CANCELLED` stored) and FS-11 (proxy disabled during the compensation -> stays
COMPENSATING and reserved unchanged; proxy enabled -> one `RELEASE`; a reservation released in full
by someone else: capacity answers `FAILED_PRECONDITION` / `release-exceeds-remaining` to a final
release — proven with a raw call — and the saga ends FAILED with no second release).
Harness addition: `rawRelease` in `test/support/system-stack.ts`.
FS-10's "visible in metrics" is proven by the alert hook, the NEEDS_ATTENTION row and its outbox
event until T14 adds metrics (spec.md says so).

Checks: `make verify`: `✔ verify passed`. `make test`: root unit 156/156 (31 files), funding unit
54/54, payments-mock 8/8, contracts 9/9, then root int stopped at one file:
`test/e2e/auth.e2e.test.ts` timed out starting PostgreSQL ("Timed out after 30000ms while waiting
for container ports to be bound", host load 10-13, other agents' stacks running); `make test`
stops at the first failing step, so funding int did not run in that pass. Reruns on their own,
same code: `auth.e2e.test.ts` 8/8, `npm run test:int -w @finverity/funding`:
`Test Files 5 passed (5)  Tests 45 passed (45)`. The other 26 root integration files passed in the
`make test` pass (133 passed | 7 skipped, the skips being the failed file's).

## T13 built (2026-10-30, agent `funding`) — the batched review T11–T13 comes next

Tests only (the driver and store from T11 already carry the mechanism).
`saga.int.test.ts` FS-08: Reserve called, recording fails (`LosingStore`), lease expires, the driver
repeats the call under the same key and records exactly one result; the same for Disburse (rail
fake deduplicates by key). `driver.int.test.ts` FS-12: driver A stalls inside its Reserve call,
its 250 ms lease expires, driver B takes the step over and finishes the request; A's late answer
is dropped (`onDropped: lease-lost`, attempt log unchanged), two calls reached the receiver under
one key and it did one thing. FS-13: a trigger makes the outbox insert (and in the second case the
attempt-log insert) fail inside `record`; state, version, lease, attempt log, outbox and
idempotency row equal the snapshot taken after the claim; healed, the step goes through once.
`saga.system.test.ts` FS-07: Toxiproxy `timeout` toxic (downstream, 0) holds capacity's answers
while requests still arrive: capacity commits the reservation, the call hits the 3 s deadline
(unknown), the toxic is removed, the retry sends the same key and gets the same reservation id:
one reservation, one `RESERVE` ledger entry, `reserved` counted once, attempts `unknown` then
`success`. The stack takes `grpcDeadlineMs` (3 s in this file; 21 s is the production default).

Mutation probes (each reverted, `git diff src` empty afterwards):
- Version check removed from the `UPDATE` in `saga-store.ts` (`AND version = …`): two FS-12 tests
  red (`expected true to be false`; `expected [] to deeply equal [ 'lease-lost' ]`), 5 others green.
- `stepKey` made non-deterministic (random suffix): FS-07 system (timed out waiting for the retry:
  the second Reserve meets the natural key and is REJECTED as EXISTING), FS-07 int retry-bytes,
  both FS-08 tests red.

Checks: `make verify`: `✔ verify passed`.

`make test` (one serial run): root unit 159/159 (31 files), funding unit 54/54, payments-mock 8/8,
contracts 9/9, root int 140/140 (27 files), funding int/system `Test Files 6 passed (6)  Tests
54 passed (54)`, `✔ all tests passed`. (The tree already held T14 work in progress; T13 is
committed by path.)

## Architect review of T11–T13 (d3dcd9b, 94cee19, 932e71a), 2026-10-30: APPROVE WITH FIXES

No BLOCKER, no second review; rulings in `.harness/4-state/DECISIONS.md`. T11–T13 stay ticked.
Land these with T14 (the `funding` agent commits this section and the DECISIONS entry with them).
Reviewer ran `make verify` (`✔ verify passed`; funding unit 59/59 on the tree with T14 WIP) and
`npx harnessimo check` (all pass); no Docker-backed run.

- [x] **M1 — key-retention bound.** `services/funding/src/funding/domain/config.ts:40` checks only
  `reserveResolutionLimitMs < CAPACITY_KEY_RETENTION_MS`. Add error
  `reserve-window-reaches-key-retention` when `reserveDeadlineMs + reserveResolutionLimitMs +
  60 * 60 * 1000 >= CAPACITY_KEY_RETENTION_MS` (the hour covers the backoff cap and a lease).
  Unit test (FS-09 id) with 13 h + 13 h refused and the defaults accepted; `worker-config` test
  that boot stops. ADR 025 timeouts table, `FUNDING_RESERVE_RESOLUTION_LIMIT` row: "reserve
  deadline + resolution limit + 1 h must stay below 24 h".
- [x] **M2 — `PERMISSION_DENIED` on Reserve is unknown.** `outcome.ts:55` shares one definite set
  for Reserve and Release. Split it: Reserve definite = `FAILED_PRECONDITION`, `NOT_FOUND`,
  `ALREADY_EXISTS`, `INVALID_ARGUMENT`; Release keeps `PERMISSION_DENIED` definite. Tests:
  classifier unit test; int FS-09 "a repeat answered PERMISSION_DENIED never ends FAILED: still
  unknown past the resolution limit → NEEDS_ATTENTION, alert, no release"; move `PERMISSION_DENIED`
  out of the definite list in `src/funding/domain/outcome.test.ts:28`. Amend ADR 025's outcome
  table (Reserve definite-failure cell; `PERMISSION_DENIED` moves to unknown with the reason).
- [x] **m1 — lease bound.** `services/funding/src/worker-config.ts:114` compares the lease with one
  call; a Reserve can take token (5 s) + 21 s + token + 21 s after `UNAUTHENTICATED` = 52 s > the
  30 s default, a lookup-first disburse 2 × 5 s. Safety holds (key + version), but the comment at
  :91–93 claims more. Bound: lease > 2 × (token timeout + gRPC deadline) and > 2 × payment
  timeout; make the token timeout a config value passed to the provider; raise the default lease
  to 60 s (ADR 025 table too).
- [x] **m2 — vacuous assertion.** `services/funding/test/integration/saga.int.test.ts:400`
  `expect(effects.size).toBeGreaterThanOrEqual(1)` → `toBe(1)` (the map is local to the test).
- [x] **m3 — FS-12 receiver half.** `driver.int.test.ts:96–99, 146`: the fake's own map makes "one
  effect" true by construction. Reword FS-12 in spec.md to "both calls carry one key; one result
  recorded (version check); the receiver's deduplication of concurrent same-key calls is
  capacity's AC-02" and drop the `effects` assertion, or add a system variant on the real image.
- [x] **m4 — FS-09 on the real image.** The only path where the saga releases a reservation it
  learned by replay. Add `saga.system.test.ts#FS-09`: the FS-07 `timeout` toxic plus a driver with
  `reserveDeadlineMs: 1` (and the `beforeRecord` sleep) → COMPENSATING → toxic removed → repeat
  answers `CREATED` with the committed id → `RELEASE`; `reserved` back to its start, ledger
  `RESERVE`, `RELEASE`, state FAILED. Point FS-09's proof marker at it (keep the int cases).
- [x] **m5 — schema backs the states.** New migration `0003`: `CHECK (state NOT IN ('DISBURSING',
  'COMPLETED') OR reservation_id IS NOT NULL)` and `CHECK (state <> 'COMPLETED' OR payment_id IS
  NOT NULL)`; an int test (FS-13 id) that a raw `UPDATE` violating each is refused.

Then `make verify` and one serial `make test`, quoted here.

## T14 built (2026-10-30, agent `funding`)

Funding `api` and `worker` expose an ops server on 9464 (`/health/live`, `/health/ready`,
`/metrics`; `src/ops/{ops-server,metrics}.ts`), like capacity's: readiness checks the database and
that the newest migration is recorded, the worker also that its driver loop ticked within twice the
step lease; draining flips it to 503. Metrics (worker): `funding_requests{state}`,
`funding_oldest_request_age_seconds{state}`, `funding_unresolved_reserve_oldest_age_seconds` (read
from the database on each scrape), `funding_step_attempts_total{step,class}`,
`funding_requests_final_total{state}`. `deploy/compose.yaml`: `payments`, `funding-migrate`,
`funding-api` (13100, ops 19466), `funding-worker` (ops 19467); Prometheus scrapes both and
`alerts.yaml` has `FundingNeedsAttention`, `FundingCompensationStuck`, `FundingReserveUnresolved`;
`docs/runbook.md` has an entry per alert and the manual release with the saga's `releaseRef`.
Helm: `helm test funding` runs the saga smoke when `test.saga` is true (now the default): one
completed request (+100.00 held) and one declined request (`FAULT-DECLINE-…`, reserved back),
against `prg_grand_usd` seeded by `make kind-seed` — `make helm-check` passes, **not run in kind**.
`make demo-funding` (`tools/demo/funding.ts`; recreates the worker with a 15 s disbursement deadline,
then restores it): six scenarios, all PASS on the live compose stack: completed (reserved
0.00 -> 1000.00), risk-declined (unchanged, no capacity call), insufficient-capacity (unchanged),
payment-declined (FAILED, reserved back), rail-unavailable (`FAULT-5XX-999`: NEEDS_ATTENTION,
+3000.00 held, never released), lost payment answer (`FAULT-TIMEOUT`: COMPLETED, found by key).
A payment timeout alone does not park a request, because the retry's lookup by key finds the
committed payment; needs-attention is shown with a rail that stays down (spec DM-01 says so).
AC id for the ops port is FS-18 (FS-15..FS-17 belong to later P1/P2 items).
Checks: `make verify`: `✔ verify passed`; `npm run test:int -w @finverity/funding`:
`Test Files 6 passed (6)  Tests 54 passed (54)`; `make demo-funding` as above. One serial
`make test` follows on the final tree after the review fixes (two earlier attempts fell over on
Docker contention: the compose stack was up next to the tests; the capacity Kafka test
`AC-10` failed with the stack up and passes alone: `Tests 4 passed (4)`). `FS-12` was made
deterministic (gate keyed on its own invoice, batch 100).


### Review fixes applied (2026-10-31, agent `funding`)

M1 `config.ts`: `reserve-window-reaches-key-retention` when deadline + resolution limit + 1 h >= 24 h
(unit tests: 13 h + 13 h refused, 11 h + 12 h refused, 10 h + 12 h and the defaults accepted;
`worker-config` boot test). M2 `outcome.ts`: Reserve's definite set no longer holds
`PERMISSION_DENIED` (Release keeps it); classifier unit test, int FS-09 "a repeat answered
PERMISSION_DENIED never ends FAILED"; ADR 025 outcome table amended. m1 `worker-config.ts`: lease
must exceed 2 x (token timeout + gRPC deadline) and 2 x payment timeout (52 s with the defaults),
`FUNDING_TOKEN_TIMEOUT_MS` added and handed to the token provider, default lease 60 s (ADR table and
the Helm `stepLease` too: the old 30 s would now stop the worker at boot). m2 `toBe(1)`. m3 FS-12
reworded in spec.md and the test-side dedup assertion dropped (both calls carry one key, one result
recorded; the receiver half is capacity's AC-02 and FS-07 here). m4 `saga.system.test.ts#FS-09`
(timeout toxic + `reserveDeadlineMs: 1`: COMPENSATING, toxic removed, repeat replays `CREATED`,
`RELEASE`, reserved back, ledger `RESERVE`,`RELEASE`, FAILED); FS-09's proof markers now name it.
m5 migration `0003_state_backed_columns.sql` (two CHECKs) with an int test (FS-13 id) that raw
UPDATEs violating each are refused. FS-12's two-driver test was made deterministic (gate keyed on its
own invoice, batch 100).

Checks: `make verify`: `✔ verify passed`; funding unit `Test Files 12 passed (12)  Tests 61 passed
(61)`; `make helm-check`: `✔ helm-check passed`. **`make test` was NOT green in one run** (Docker VM
6 CPU / 6 GB, kind control plane at ~110 % CPU, other stacks up, six testcontainers leaked by hooks
that timed out): root unit 159/159, funding unit 61/61, payments-mock 8/8, contracts 9/9; root int
stopped at four capacity files (`outage.fault`, `shutdown-worker.fault`, `role-all.kafka`,
`treasury-consumer.kafka`: hook timeouts, "Topic creation errors") — code this commit does not touch;
the same files passed in earlier serial runs of this lane. `npm run test:int -w @finverity/funding`:
`Test Files 1 failed | 5 passed (6)  Tests 50 passed | 8 skipped (58)`: the five integration/e2e
files pass (saga.int incl. the new FS-09 PERMISSION_DENIED case, driver.int incl. FS-12 and the m5
CHECK test — so migration 0003 applies and holds on real PostgreSQL —, database, api e2e, ops);
`test/system/saga.system.test.ts` did not start (mock-oauth2 container not reachable within 60 s in
`beforeAll`, twice). The system suite passed in full before these fixes (FS-03, FS-06, FS-07, FS-11
and the token checks); the new system `FS-09` has not run yet. **Owed:** one serial `make test` on a
quiet Docker host.

### Final serial `make test` on the merged branch (coordinator, 2026-10-31, HEAD 7bda740 + 352503b)

Leaked Testcontainers removed first; only the main stack and kind ran beside it.
`MAKE_TEST_EXIT=0`, `✔ all tests passed`: capacity unit 32 files / 167, funding unit 12 / 61,
payments-mock 2 / 8, contracts 1 / 9, capacity int+e2e 27 / 140, funding int+e2e+system 6 / 58
(system suite on the real capacity image behind Toxiproxy). This closes the "serial make test on a
quiet host" owed by 062bc13.
