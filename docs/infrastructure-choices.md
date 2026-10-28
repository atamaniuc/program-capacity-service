# Infrastructure we considered and did not add

Reviewers often ask "why not X?". This page answers for the tools that come up most: a
connection pooler (PgBouncer / RDS Proxy), change data capture (Debezium), a local AWS
emulator (Floci / LocalStack), gRPC and Redis. For each: what it would give us, what it would
cost, what we did instead, and **what would change the answer**.

Short version:

| Tool | Verdict now | Add it when |
| --- | --- | --- |
| PgBouncer / RDS Proxy | Not in the local stack; the code is already compatible; use RDS Proxy in production | `replicas × pool size` gets close to the database's `max_connections` |
| Debezium (CDC) | No; the polling outbox relay is enough | Outbox lag breaks its target at peak, or the platform already runs Kafka Connect |
| Floci / LocalStack | No; the service calls no AWS API | The code starts using an AWS SDK (S3, SQS, Secrets Manager) or we test IaC in CI |
| gRPC | No ([ADR 022](adr/022-no-grpc-adapter.md)) | A real caller needs something REST and Kafka events do not give |
| Redis | No ([ADR 002](adr/002-postgres-source-of-truth.md)) | Measured read load on the primary that a read replica cannot absorb |

## PgBouncer (connection pooling)

**What it is.** A proxy between the application and PostgreSQL. PostgreSQL starts one OS
process per connection, and each costs memory, so the number of connections is limited
(`max_connections`, 100 by default; on RDS it depends on instance memory). A pooler lets
thousands of client connections share a few dozen real ones. In *transaction* mode a real
connection is lent to a client for one transaction only.

**Do we need it now? No.** Each `api` or `worker` process opens at most 10 connections
(`src/capacity/adapters/out/postgres/db.ts`). The local stack runs two processes, so 20
connections. Even 8 replicas need only 80.

**Is the code ready for it? Yes, on purpose.** Transaction pooling breaks code that keeps
state on a connection between transactions. This service keeps none:

| Feature that breaks under transaction pooling | In this code |
| --- | --- |
| `SET` of session settings | Not used. Timeouts are set with `set_config(…, true)`, which lasts only for the transaction (`unit-of-work.ts`) |
| Session advisory locks | Not used. Migrations use `pg_advisory_xact_lock`, released at commit |
| `LISTEN` / `NOTIFY` | Not used. The outbox relay polls |
| Named prepared statements | Not used. Kysely and `pg` send unnamed statements |
| Temporary tables across transactions | Not used |

Every use case is a single transaction (a project rule), which is exactly the unit a
transaction pooler hands out.

**In production.** On AWS use **RDS Proxy**: it is managed, it handles failover, it supports
IAM authentication and it does what PgBouncer does. On Kubernetes without RDS, run PgBouncer
in transaction mode. Two cautions:

- A pooler does not fix lock contention. Requests waiting for a hot program's row lock still
  wait, now in the pooler's queue. That problem is solved by the scale path in PRD §8 (capacity
  buckets), not by more connections.
- RDS Proxy "pins" a client to one connection after some statements (for example `SET`,
  temporary tables, advisory locks). Check its `DatabaseConnectionsCurrentlySessionPinned`
  metric under load before going live.

**What would change the answer.** `replicas × 10` approaching `max_connections`, many
short-lived processes (serverless, Lambda), or connection storms during deploys.

## Debezium / CDC (change data capture)

**What it is.** Debezium reads PostgreSQL's write-ahead log (WAL) through a logical
replication slot and turns committed row changes into Kafka messages. With its *outbox event
router* it does exactly what our outbox relay does: it publishes `outbox_event` rows to Kafka.

**What we do instead.** A small relay inside the `worker` (`src/capacity/adapters/out/kafka/outbox-relay.ts`)
polls unpublished rows in order, sends them, waits for the broker's acknowledgement and marks
them published. A lease with an epoch number makes sure only one relay publishes at a time
([ADR 009](adr/009-outbox-relay-lease.md)).

| | Polling relay (ours) | Debezium |
| --- | --- | --- |
| Moving parts | One loop in an existing process | Kafka Connect cluster, connector config, replication slot |
| Database settings | None | `wal_level=logical` (on RDS a parameter group change and a reboot) |
| Latency | Poll interval (sub-second) | Near real time |
| Load on the database | One indexed query per poll | Reading the WAL; no queries |
| Main operational risk | Lag if the relay stops (alerted on `outbox_lag`) | A stopped connector keeps its slot, so the WAL grows until the disk fills, unless `max_slot_wal_keep_size` and alerts are set |
| Delivery | At least once | At least once (consumers still deduplicate) |
| Local development | Nothing extra | Another JVM container and connector set-up |

For one service with modest event volume, the relay gives the same guarantees with far less to
run. **Switch when** outbox lag breaks its target at peak load, or when the platform already
operates Kafka Connect (for example MSK Connect) so the cost is shared. The switch is cheap: the
`outbox_event` table already has what the outbox router needs (event id, type, aggregate key
`tenantId:programId`, payload), so it means deploying a connector and turning the relay off;
the topic and the consumers stay the same.

## Floci / LocalStack (local AWS emulators)

**What they are.** Programs that pretend to be AWS on your laptop (S3, SQS, DynamoDB, Secrets
Manager and so on), so code using an AWS SDK can run without an AWS account.
[LocalStack](https://www.localstack.cloud/) is the best known; its free edition now requires an
account and an auth token. [Floci](https://floci.io/) is an MIT-licensed, no-account
alternative ([GitHub](https://github.com/floci-io/floci)).

**Do we need one? No.** The service makes no AWS API call. Every production dependency talks
a standard protocol, and locally we run the real thing:

| Production (AWS) | How the code talks to it | Locally |
| --- | --- | --- |
| RDS / Aurora PostgreSQL | PostgreSQL wire protocol | Real PostgreSQL 18 container |
| MSK | Kafka protocol | Real Kafka 4 container |
| Secrets Manager | Values arrive as environment variables, injected by ECS or Kubernetes | `.env` / compose |
| CloudWatch, X-Ray via ADOT | OTLP and Prometheus | Jaeger, Prometheus, Grafana (optional profile) |

An emulator here would test the emulator. Real PostgreSQL and Kafka in Testcontainers are more
faithful than any emulation.

**Add one when** the code starts calling an AWS SDK directly, for example archiving snapshots
to S3, reading secrets at runtime, or using SQS, or when we want to test infrastructure as
code (Terraform, CDK) in CI. Then prefer Floci: no account, no token in CI.

## gRPC

Not built. No client needs it, and a second transport would duplicate validation,
authentication, error mapping and idempotency handling at the boundary of a money service.
Full reasoning and the triggers for adding it: [ADR 022](adr/022-no-grpc-adapter.md).

## Redis and other caches

Not used. Reads are primary-key lookups that take milliseconds, and a cache in front of a
value that must never be stale needs invalidation inside the same transaction, which is the
hard part. The first step for read load is a PostgreSQL read replica. [ADR 002](adr/002-postgres-source-of-truth.md).

## Other items deliberately left out

GraphQL, event sourcing, sagas or Temporal, a separate read store, an API gateway in this
repository and Pact: see [ADR 017](adr/017-out-of-scope.md), one line each with the trigger
that would change the answer.
