# Position fit

This page lines up two documents with what the repository shows:

- the technical assignment, [Backend-Developer-Test-Assignment.md](Backend-Developer-Test-Assignment.md);
- the job description, [senior-node-js-engineer.md](senior-node-js-engineer.md).

Every row says **Yes**, **Partly** or **No**, names a proof you can open or run (a file, a test
id, a `make` target), and says in plain words what is missing. A test id is the prefix of a test
name: `grep -rn "AC-01" test src` finds it. AC ids are the acceptance criteria of the
[PRD](PRD.md); ids starting with FS, GR, GW or CT are the branch's acceptance criteria in
[specs/0006-funding-saga/spec.md](../specs/0006-funding-saga/spec.md). Nothing here is a claim without a proof, and a "No"
means no.

Two layers exist, so the page tags them:

- **`main`** is the submitted take-home: one NestJS service that holds a credit limit with one
  PostgreSQL transaction.
- **branch `microservices`** (this branch) is an evolution demo built on top of it:
  `funding-service`, a payment-rail mock, internal gRPC, a saga, Helm, a local kind cluster and
  an API gateway. Rows that exist only on the branch say **(branch)**. See the
  [branch technical overview](branch-technical-overview.md#what-the-branch-adds).

Commands that check most rows: `make verify` (no Docker), `make test` (Docker),
`make up && make seed && make demo-funding` (the live stack), `make helm-check`, and for the
cluster `make kind-up && make kind-smoke`.

## 1. The technical assignment, point by point

| Asked | Status | What the repository shows | Not covered, or limited |
| --- | --- | --- | --- |
| Track the capacity of a program in real time | Yes | State lives in PostgreSQL and every change is one transaction. `GET /v1/programs/{id}/capacity` reads the primary, so a client reads its own writes. Proof: `test/e2e/capacity.e2e.test.ts` (FR-01) | "Real time" means a synchronous API. There is no push or streaming of capacity to clients; they poll or read `capacity.events.v1` |
| Accept reservations | Yes | `POST /v1/programs/{id}/reservations` locks the program row, checks, writes, commits. 50 parallel reserves on a limit that fits 10: exactly 10 succeed. Proof: `test/integration/reserve-concurrency.int.test.ts` (AC-01) | The hot program is a ceiling: all writes to one program queue on one row lock. The load test shows it ([testing.md](testing.md#load-test)); the fix (capacity buckets) is designed in PRD §8 and not built |
| Process releases | Yes | Full and partial releases, REST and Kafka share one code path; the last release takes the exact remainder. Proof: `test/integration/release.int.test.ts` (AC-05, AC-06), `test/property/release.property.test.ts` | None known |
| Expose current availability to clients | Yes | Capacity view, reservation list with filters and cursor pagination, ledger. Proof: `test/e2e/queries.e2e.test.ts` (FR-12) | Reads always hit the primary; a read replica is a next step (ADR 002), not built |
| Capacity data flows in from treasury through Kafka | Yes | The `worker` role consumes `treasury.capacity.v1` and `treasury.fx-rates.v1`: inbox table, DLQ, offsets committed after the database. Proof: `test/kafka/treasury-consumer.kafka.test.ts` (AC-07, AC-09, AC-10, AC-11) | The assignment gives no message format, so the format is mine (assumption A2, `contracts/asyncapi.yaml`). No real treasury system was involved; `make demo` and the simulator play it |
| Periodic bulk reconciliation messages | Yes | A snapshot is compared with the platform's state by a documented case table; in-flight reservations survive; drift is reported, not silently released. Proof: `test/integration/reconcile.int.test.ts` (AC-08, AC-14, AC-15) | Snapshots above `RECON_MAX_RESERVATIONS` (50,000) go to the dead-letter topic instead of being applied |
| Programs and invoices in different currencies | Yes | FX rates come from treasury, are fixed per reservation, converted in integers, rounded up on reserve and down on partial release. Proof: `test/integration/fx.int.test.ts` (AC-12), `test/property/release.property.test.ts` | No revaluation of existing reservations when rates move (a non-goal in PRD §2). Rates older than 24 h are refused, so a demo needs a fresh `make seed` |
| All endpoints must be authenticated | Yes | JWT from the OAuth2 identity provider (JWKS), scopes, tenant isolation (another tenant's program is a 404). Proof: `test/e2e/auth.e2e.test.ts` (AC-13, AC-16). **(branch)** the funding API (`services/funding/test/e2e/api.e2e.test.ts`, FS-02) and every gRPC call (`test/e2e/grpc.e2e.test.ts`, GR-04) need a token too | Health and metrics are on a separate internal port with no token (assumption A8). The payment-rail mock **(branch)** has no authentication at all; it stands in for an external system |
| Runnable locally | Yes | `make install` (check the machine, `npm ci`, start the stack, seed). `make up` starts PostgreSQL, Kafka, the OAuth2 server and the services. Proof: `Makefile`, `deploy/compose.yaml`, [local-stack.md](local-stack.md) | Needs Docker with at least 4 GB of memory |
| Treat it as production code | Partly | Idempotency keys, inbox and outbox, DLQs, graceful shutdown (`test/fault/shutdown.fault.test.ts`), health checks, metrics, traces, a runbook, CI with scans. Proof: [runbook.md](runbook.md), `.github/workflows/ci.yml` | Nothing has run in production. Load numbers are from one laptop. No deployment pipeline exists |
| Document assumptions and trade-offs briefly | Yes | [assumptions-and-trade-offs.md](assumptions-and-trade-offs.md) lists each assumption and trade-off with a link to its decision record; the records are [adr/](adr/) 001-022 on `main` and 023-029 on the branch | "Briefly" is not true of the whole repository: it is large. The reading path in [README.md](README.md) is the short way in |

The job description says the home task takes a couple of hours. This repository is far larger
than that, on purpose: it was built with AI coding agents under a written process
([development-process.md](development-process.md)). Read `main` for the take-home itself.

## 2. The job description: responsibilities

| Asked | Status | What the repository shows | Not covered, or limited |
| --- | --- | --- | --- |
| Design and implement scalable backend services with Node.js (NestJS) and TypeScript | Yes for capacity, Partly for the rest | Capacity is NestJS 12 and strict TypeScript, in a hexagonal layout whose layer rules fail the build (`npm run depcruise`, `test/architecture/layers.test.ts`). The `api` role is stateless; the funding worker claims work with `FOR UPDATE SKIP LOCKED`, so several workers can run (`services/funding/test/integration/driver.int.test.ts`, FS-12) | **(branch)** `funding-service` and the payments mock are plain `node:http` servers with zod, **not NestJS**, and no decision record explains the choice. "Scalable" is argued and tested for correctness, not measured beyond one laptop |
| Own critical business capabilities (invoices, payments, supplier lifecycle, funding decisions, audit trails) | Partly | Credit capacity and its audit ledger (`ledger_entry`, FR-11). **(branch)** funding decisions and disbursement as a service of its own (`services/funding`), with an append-only attempt log per step (`saga_step_attempt`, migration `0002_funding_schema.sql`) | Invoices are only ids here; there is no invoice or supplier lifecycle. The payment rail is a mock. The risk check is a per-currency maximum amount (`services/funding/src/funding/domain/risk.ts`), not a real risk model. "From discovery to production support" cannot be shown: nothing is in production |
| Public APIs (REST/GraphQL) and internal gRPC, with versioning and backward compatibility | Partly | REST under `/v1` with OpenAPI generated from zod (`contracts/openapi.yaml`, `services/funding/contracts/openapi.yaml`). **(branch)** internal gRPC `CapacityService` (ADR 024); the same acceptance cases pass over REST and gRPC (`test/e2e/transports.e2e.test.ts`). Compatibility is enforced: `make compat` (oasdiff and event-schema checks, [api.md §8](api.md#8-changing-a-contract)), `buf breaking`, `packages/contracts/test/schema-compat.test.ts` (CT-04) | **GraphQL: No** (declined in ADR 017, revisit triggers listed). No `/v2` has ever been needed, so the dual-version procedure is written down and not built. Consumer-driven contracts (Pact, ADR 028) are planned and not built |
| Drive architecture: service boundaries, event-driven workflows, data consistency, resiliency | Yes, as a demonstration | When to split and when not: ADR 021. The split that fired (a new bounded context): ADR 023, with one database per service and a test that each role is refused by the other's database (`services/funding/test/integration/database.int.test.ts`, FS-14). Events: transactional outbox (ADR 009). Consistency: idempotency (ADR 006) and the saga (ADR 025) | One person, with AI reviewers, on a demo system. No team, no production traffic, no real disagreement to resolve |
| Security and compliance: secure coding, dependency hygiene, secrets handling, auditability | Partly | The JWT is checked by each service itself, also behind the gateway (ADR 011, ADR 029; `test/e2e/auth.e2e.test.ts`). Input validated by zod at the boundary. CodeQL, gitleaks, Trivy and Dependabot are configured (`.github/workflows/`, `.github/dependabot.yml`). Containers run as non-root. Every capacity change has a ledger entry | Secrets in compose and in the Helm values are local development passwords; a Kubernetes `Secret` from a chart is not a secrets manager. Trivy scans only the capacity image, not the funding or payments images. The ZAP scan is a baseline scan of the capacity API. No SOC 2 or ISO work |
| Lead code reviews, enforce standards, improve quality (testing, observability, CI/CD) | Partly | Standards are enforced by machines: ESLint, Prettier, layer rules, a coverage gate of 90% on domain and application code, contract drift checks, the `.githooks/pre-commit` hook, and `make verify` in CI. Independent review passes (an architect agent with a fresh context) are recorded with their findings in `.harness/4-state/DECISIONS.md` | No human code review exists in this repository, so leading reviewers or teaching a team is not shown. The review passes are by AI agents |
| On-call, incident response, post-mortems, reliability | Partly | [runbook.md](runbook.md): an entry per alert, SQL to look inside, a manual release with the saga's `releaseRef`. Alert rules in `deploy/observability/alerts.yaml` (`DlqGrowing`, `OutboxLagHigh`, **(branch)** `FundingNeedsAttention`, `FundingCompensationStuck`, `FundingReserveUnresolved`) | No real incident happened, no post-mortem was written, nobody was on call. There is no Alertmanager: alerts are visible in Prometheus and sent nowhere |

## 3. The job description: main requirements

| Asked | Status | What the repository shows | Not covered, or limited |
| --- | --- | --- | --- |
| 5+ years of professional backend experience in Node.js and TypeScript | Not provable here | A repository shows how the work is done, not for how long | Years of experience are a matter for the CV and the interview |
| NestJS (or similar) and backend design patterns | Yes for capacity | NestJS modules and controllers in `src/capacity/capacity.module.ts` and `src/capacity/adapters/in/http/`. Patterns, each with a record: hexagonal ports and adapters (ADR 018), aggregate root (ADR 019), unit of work, inbox and outbox (ADR 007, 009), idempotency (ADR 006), saga **(branch)** (ADR 025) | The funding service does not use NestJS (see section 2) |
| API design: REST practice, pagination and filtering, JWT/OAuth, error modelling, idempotency | Yes | Cursor pagination and filters on reservations and the ledger (`test/e2e/queries.e2e.test.ts`); OAuth2 client-credentials tokens checked through JWKS, scopes, tenants; errors as RFC 9457 `application/problem+json` with a stable `type` ([api.md §6](api.md#6-errors), ADR 014); idempotency keys that replay even a stored 422 (`test/integration/idempotency.int.test.ts`, AC-02, AC-03, AC-17). **(branch)** the same for funding (FS-02) and gRPC errors as `google.rpc.Status` with `ErrorInfo` | The funding API has two endpoints and no list endpoint, so no pagination there. Idempotency rows in funding are not cleaned up yet (capacity has a 24 h retention job) |
| Microservices and distributed concerns: latency, consistency, retries, observability | Partly **(branch)** | Two services and a rail mock. Latency: a deadline on every gRPC call, validated at boot against capacity's own lock and statement timeouts (`services/funding/test/unit/worker-config.test.ts`). Consistency: exactly-once effect across the gRPC hop (FS-07, FS-08, FS-12, FS-13 in `services/funding/test/`). Retries: deterministic keys, capped exponential backoff with jitter. Observability: funding metrics and three alerts; capacity metrics, traces and a Grafana dashboard | **Funding has no OpenTelemetry tracing**, so a trace does not cross the gRPC hop, although ADR 025 describes it. No Grafana panel for funding. gRPC is plaintext HTTP/2 with a JWT on every call; TLS or mesh mTLS is not built. Two services is a small system |
| SQL and PostgreSQL: schema design, query optimisation, migrations | Yes, with a limit | Plain SQL migrations (ADR 012) with `CHECK` constraints that back the states (`services/funding/src/funding/adapters/out/postgres/migrations/`), partial indexes, an append-only trigger, a lock order written down (ADR 003), reconciliation as set-based SQL over a staging table, `test/integration/migrations.int.test.ts` | Query tuning is shown by design and by the load test only; no query-plan (`EXPLAIN`) analysis is recorded |
| Docker, CI/CD pipelines, Git workflows | Partly | Multi-stage Dockerfiles for all three images, running as a non-root user; health checks in Compose; GitHub Actions: `ci.yml` (lint, types, layer rules, contract checks, tests, image build and scan of all three images, secret scan, `make helm-check`, and a `kind` job that runs `make kind-up` and `make kind-smoke`), `codeql.yml`, `zap.yml`. Git: one commit per task after the gates are green, a pre-commit hook, worktrees for parallel streams | CI only (continuous integration): nothing deploys anywhere. The kind cluster lives only for the CI run. No pull-request review history |
| Strong English for international teams | Partly | All repository documents, decision records and commit messages are English | Only written English can be shown. Spoken English cannot |

## 4. The job description: nice to have

| Asked | Status | What the repository shows | Not covered, or limited |
| --- | --- | --- | --- |
| Fintech: payments, ledger and reconciliation, risk checks, audit trail, limits | Yes | Credit limits, an append-only ledger, reconciliation with a case table (ADR 008), an exact-money model (`bigint` minor units, ISO 4217), **(branch)** a risk check and a payment step with compensation | The risk check is a toy. No KYC, AML or sanctions screening. The payment rail is a mock |
| Kafka and patterns: outbox, CQRS, saga | Partly | Kafka: consumer with inbox and DLQ, outbox relay with lease and epoch fencing (`test/kafka/`). Outbox: ADR 009. **(branch)** orchestrated saga with compensation (ADR 025; FS-01 to FS-14, `make demo-funding`) | **CQRS: No** (no separate read store, ADR 017). The funding service writes outbox rows but its relay to `funding.events.v1` is not built (task T21, FS-15), and it does not use Kafka yet. The saga is hand-written, no workflow engine (Temporal rejected, ADR 025) |
| Caching and tuning with Redis | No | Redis is left out on purpose: PostgreSQL is the single source of truth (ADR 002) and the owner ruled it out on the branch | Nothing uses Redis. As a consequence the gateway's rate limit is local to each Envoy replica (ADR 029) |
| AWS in production (ECS/EKS, Lambda, SQS/SNS, S3, RDS, CloudWatch) | No | Only a mapping table of what each local piece would become on AWS ([infrastructure-choices.md](infrastructure-choices.md#running-in-production-not-built-here)) and the AWS analogue named in ADR 029 | No Terraform, CDK, CloudWatch or any AWS resource. Metrics are Prometheus |
| Kubernetes and platform operations | Partly **(branch)** | Helm charts for capacity, funding, local infrastructure and the gateway (`deploy/helm/`); a kind cluster `finverity-ms` that never touches the default kubeconfig; Envoy Gateway doing JWT, CORS and a per-tenant rate limit at the edge while each service still checks the token; migrations as hooks; probes on the ops port. Proof: `make helm-check`, `make kind-up`, `make kind-smoke`, `test/architecture/gateway.test.ts` (GW-05) | Only a local kind cluster, never a real one. No NetworkPolicy, autoscaling or service mesh. The live kind runs recorded in `specs/0006-funding-saga/handoff.md` (locally and in CI) cover capacity, the funding saga (one completed and one compensated request) and the gateway; the timeout and 5xx faults, a capacity-side compensation and the saga through the gateway are not driven in the cluster |
| Security tooling and practice: dependency scanning, SAST/DAST, SOC 2/ISO readiness | Partly | Trivy (lockfile and capacity image), gitleaks, CodeQL, ZAP baseline, Dependabot, all in `.github/` | No SOC 2 or ISO readiness work. Scanning does not cover the funding and payments images |

## 5. The job description: tech stack

| Item | Status | Where |
| --- | --- | --- |
| Node.js, TypeScript | Yes | Node 24, strict TypeScript, all services |
| NestJS | Capacity only | `src/`; funding and payments mock use `node:http` |
| Microservices | Partly **(branch)** | `services/funding`, `services/payments-mock` next to capacity |
| REST | Yes | `contracts/openapi.yaml`, `services/funding/contracts/openapi.yaml` |
| GraphQL | No | ADR 017 |
| gRPC | Yes **(branch)**, internal only | `packages/contracts/proto/`, ADR 024 |
| PostgreSQL | Yes | Both services, one database each |
| Redis | No | ADR 002 |
| Kafka | Yes | Capacity; not yet used by funding |
| Docker | Yes | `Dockerfile`, `services/*/Dockerfile`, `deploy/compose.yaml` |
| Kubernetes | Partly **(branch)** | kind only, `deploy/helm/` |
| GitHub Actions | Yes | `.github/workflows/` |
| GitLab CI | No | Not used |
| CloudWatch | No | Not used |
| Prometheus | Yes | `deploy/observability/prometheus.yml`, `alerts.yaml`; capacity and funding are scraped |
| Grafana | Partly | One dashboard, for capacity (`deploy/observability/grafana/dashboards/capacity.json`); none for funding |

## 6. What is not covered, in one list

- Experience, people leadership, mentoring, working with Product, Security and Support: a
  repository cannot show these.
- GraphQL, Redis, CQRS, AWS and any real cloud: not built; for GraphQL, Redis and CQRS there is a
  written decision, for AWS only a mapping table.
- NestJS in the funding service and the payments mock: they use plain `node:http`.
- Distributed tracing across the gRPC hop, and a Grafana dashboard for funding.
- TLS or mTLS between services, NetworkPolicy, autoscaling, a real cluster, a deployment pipeline.
- The funding event relay to Kafka (`funding.events.v1`), the operator command that resolves a
  `NEEDS_ATTENTION` request, and Pact contract tests: planned in
  [specs/0006-funding-saga/tasks.md](../specs/0006-funding-saga/tasks.md) (T19 to T22), not built.
  Until the operator command exists, an operator closes such a request with SQL from the
  [runbook](runbook.md#funding-a-request-needs-attention-fundingneedsattention).
- Starting a refused or failed funding request again for the same invoice: the natural key makes
  a second `POST` return the existing request, and no resubmission rule exists
  ([known limits](assumptions-and-trade-offs.md#known-limits-1)).
- Production experience of any kind: no real traffic, no real incident, no human reviewer.
