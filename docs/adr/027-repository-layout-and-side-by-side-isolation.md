# 027. Repository layout: npm workspaces with capacity at the root; side-by-side with `main`

- Status: accepted (branch `microservices` only)
- Date: 2026-10-29
- Amends: ADR 018 and ADR 021 ("no monorepo tooling": still true; a second deployable now
  exists, so the repository gains npm workspaces and nothing more)

## Context

The branch adds two deployables (`funding-service`, a mock payment rail) next to the capacity
service. The layout must keep `make verify`, `make test` and `npx harnessimo check` working, keep
every proof marker of the closed lanes 0001–0005 resolving (67 markers point at `src/`, `test/`
and `deploy/k8s/` paths), and make it impossible for one service to import another's code.

The owner also keeps working on `main` with its compose stack running, while this branch lives
in its own worktree. The two must run at the same time without touching each other.

## Decision

### Layout

```
/                         capacity service, unchanged: src/, test/, tools/, db/, Dockerfile
contracts/proto/          finverity/capacity/v1/*.proto, buf.yaml, buf.gen.yaml   (ADR 024)
contracts/                openapi.yaml, asyncapi.yaml, json-schema/ (unchanged)
services/funding/         package.json, src/{funding,platform}/, test/, migrations, Dockerfile
services/payments-mock/   package.json, src/, Dockerfile (mock payment rail; no database)
packages/contracts/       after the MVP cut: proto, generated stubs, event schemas (ADR 028)
deploy/                   compose.yaml (all services), helm/, kind/                (ADR 026)
```

- The root `package.json` declares `"workspaces": ["services/*", "packages/*"]`; one
  `package-lock.json`; `npm ci` at the root installs everything.
- Each workspace has its own `tsconfig.json` (strict, ESM, `#src/*` imports, no path aliases),
  Vitest projects `unit` and `int`, dependency-cruiser rules (the hexagonal rules of ADR 018
  applied to `src/funding/`) and scripts `lint`, `typecheck`, `depcruise`, `test:unit`,
  `test:int`.
- `make verify` runs the root steps, then `proto:lint`, `proto:breaking` and `proto:check`, then
  the same steps in every workspace. `make test` runs the root levels, then every workspace's.
- **No service imports another service's code.** `services/*` may import only their own code,
  their dependencies and generated contract stubs; root `src/` imports nothing from
  `services/` or `packages/` except the contracts package once it exists. An architecture test
  (WS-01) fails on a crossing.
- `harnessimo.config.json`: `cleanExit.scan` and `cleanExit.codePrefixes` gain `services/` and
  `packages/`.

### Side-by-side isolation from `main`

| Concern | `main` | Branch `microservices` |
| --- | --- | --- |
| Worktree | `finverity/` | `../finverity-microservices` |
| Compose project | `program-capacity` | `program-capacity-ms` |
| Images | `program-capacity-service:local` | `*:ms-local` (`program-capacity-service`, `funding-service`, `payments-mock`) |
| PostgreSQL | 5432 | 15432 |
| Kafka (host listener) | 29092 | 39092 (advertised as `localhost:39092`) |
| Mock OAuth2 | 8081 | 18081 |
| Capacity API, api ops, worker ops | 3000, 9464, 9465 | 13000, 19464, 19465 |
| Capacity gRPC | none | 60051 |
| Funding API, api ops, worker ops | none | 13100, 19466, 19467 |
| Payments mock | none | 13200 |
| Prometheus, Grafana, Jaeger UI, OTLP | 9090, 3001, 16686, 4318 | 19090, 13001, 26686, 14318 |
| Kafka UI (`observability` profile) | 8080 | 18080 (`HOST_PORT_KAFKA_UI`) |
| Kubernetes | none | kind cluster `finverity-ms`, kubeconfig `.kind/kubeconfig`, port-forwards 23000–23099 |

- Every host port in `deploy/compose.yaml` comes from an environment variable with the branch
  default (`${HOST_PORT_API:-13000}` and so on). The Makefile, `tools/` (token, demo, seed,
  simulator, dlq-replay, qa, k6) and `db/seeds` read the same variables with the same defaults;
  no script hard-codes a `main` port.
- The OAuth2 issuer follows the port: tokens minted from the host carry
  `http://localhost:18081/default`, and `OAUTH_ISSUER` in the services matches it. A service
  that mints its own tokens inside the network (funding) sends the `Host` header of the
  configured issuer, so its tokens carry the same `iss` (the trick the k6 scenario already
  uses).
- `make doctor` checks the branch ports; `make down` removes only the branch project's
  containers and volumes (the project name is fixed in the compose file).
- Testcontainers keep random host ports, so test runs never collide with either stack.
- The isolation test (MS-01) fails when a published host port or a script default is one of
  `main`'s ports, when the project name or an image tag is `main`'s, or when a kind target names
  another cluster.

## Consequences

- No closed-lane proof marker moves; capacity's build, Dockerfile and CI paths stay as they are.
- The layout is asymmetric (capacity at the root, funding under `services/`). That is the price
  of not rewriting five closed lanes; it is stated here so nobody "fixes" it by accident.
- Workspaces duplicate a little tooling configuration; each service can still pick its own
  dependency versions.

## Alternatives rejected

- **Move capacity to `services/capacity` now.** Symmetric, but it rewrites every proof marker
  of lanes 0001–0005, the Dockerfile, CI, `deploy/k8s` and the harness config, and changes no
  behaviour. Possible later as a mechanical rename in its own commit.
- **Funding inside the same package (`src/funding/`) behind a dependency-cruiser wall.**
  Cheapest, but one `package.json`, one image and one release for two services: not independent
  deployables, and a database per service would sit next to shared code that invites imports.
- **Nx, Turborepo or pnpm workspaces.** A build graph and remote caching for three packages is
  not needed, and switching the package manager churns the lockfile and CI for nothing (the
  reasons of ADR 018 hold at this size).
