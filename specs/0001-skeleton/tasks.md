# Tasks — 0001 Skeleton (M0)

A ticked box carries a resolving proof marker (an HTML comment starting with `proof:`). Until
the evidence exists the target is plain text after `proof (planned):`; turn it into a marker
when you tick.

## P0

- [ ] T1 — Tooling: `package.json` scripts (`build`, `start`, `lint`, `typecheck`,
  `depcruise`, `test`, `test:unit`, `test:int`, `seed`, `token`, `demo`, `contracts`,
  `dlq-replay`, `load`), TypeScript 6 strict ESM (`module: nodenext`), ESLint flat config
  with type-aware rules incl. `no-floating-promises` and a money rule banning
  `parseFloat`/`Number(` in `src/capacity/domain`, Prettier, Vitest (unit and int projects,
  coverage thresholds 90% lines on domain and application). proof (planned): `make verify` (SK-01)
- [ ] T2 — Folder skeleton per PRD §13 and dependency-cruiser rules: domain imports only
  domain; application imports no adapter; adapters do not import each other; slices do not
  import each other. Architecture test runs depcruise on a fixture that violates the domain
  rule. proof (planned): `test/architecture/layers.test.ts#SK-02`
- [ ] T3 — Config: zod schema for env (APP_ROLE api|worker|all, HTTP_PORT, OPS_PORT,
  DATABASE_URL, KAFKA_BROKERS, OAUTH_ISSUER, OAUTH_AUDIENCE, OAUTH_JWKS_URL, FX_MAX_AGE,
  RECON_TOLERANCE_MINOR, RECON_MAX_RESERVATIONS, RECON_MODE, LOG_LEVEL), validated at boot,
  errors never echo values. `.env.example`. proof (planned): `src/platform/config/config.test.ts#SK-03`
- [ ] T4 — Bootstrap: `src/main.ts` selects role by `APP_ROLE`; Nest app on HTTP_PORT; a
  separate ops HTTP server on OPS_PORT with `/health/live`, `/health/ready` (DB ping;
  consumer state is added by 0003) and `/metrics` (`prom-client`); pino JSON logs;
  SIGTERM closes intake then the pool. proof (planned): `test/e2e/ops.e2e.test.ts#SK-04`
- [ ] T5 — Persistence base: Kysely + `pg` pool, SQL migrations under
  `src/capacity/adapters/out/postgres/migrations/`, a migrate entry point used by the compose
  `migrate` job, a Testcontainers PostgreSQL 18 helper in `test/support/`.
  proof (planned): `test/integration/migrations.int.test.ts#SK-05`
- [ ] T6 — Delivery: multi-stage non-root Dockerfile (Debian slim, Node 24);
  `deploy/compose.yaml` with postgres 18, Kafka 4 KRaft, `kafka-init` creating
  `treasury.capacity.v1`, `treasury.fx-rates.v1`, `capacity.events.v1` and their `.dlq`
  topics, mock OAuth2 server with JWKS and client credentials, one-shot `migrate`, `api`,
  `worker`, healthchecks; `tools/token` behind `make token`. proof (planned): `make up` (SK-06)
- [ ] T7 — CI: `.github/workflows/ci.yml` (harnessimo check, lint, typecheck, depcruise,
  unit, integration, image build, Trivy image + lockfile, gitleaks), `codeql.yml`,
  `dependabot.yml` weekly grouped. proof (planned): `.github/workflows/ci.yml` (SK-07)

## P1

- [ ] T8 — `docs/glossary.md` from PRD §7 ubiquitous language; ADRs 012, 016, 018, 020 in
  `docs/adr/` (MADR, short). proof (planned): `docs/glossary.md`
