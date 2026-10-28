# 0002 — Core capacity (M1)

**Status:** proposed · **Owner:** implementer (sonnet); architect reviews every diff (money, concurrency, idempotency)

## Why

The money risk lives here: over-reserving pays out unapproved funds (PRD §1, G1). This lane
builds the schema, the Money/FX domain, reserve, release, read, idempotency, auth and the
ledger. Requirements: FR-01, FR-02, FR-03, FR-04, FR-10, FR-11, FR-14 (verbatim in PRD §4).
Gate (PRD §11 M1): AC-01 to AC-06, AC-13, AC-16 and AC-17 pass.

## User stories

**US-01** — As a platform service, I want to reserve capacity for an approved invoice and
get a definitive answer, so that funding never exceeds the program limit.
**US-02** — As a platform service, I want retries to have exactly one effect, so that
network failures never double-reserve.
**US-03** — As a bank operator, I want to read a program's capacity and trust it, so that
I can answer a supplier.

## Acceptance criteria

Copied verbatim from PRD §4. Test names start with the AC id.

**AC-01** (FR-02) — GIVEN USD program, limit 10,000,000, reserved 9,000,000 WHEN 50
concurrent reservations of 100,000 for distinct invoices THEN exactly 10 succeed, 40 get
insufficient capacity, reserved = 10,000,000.
proof (planned): `test/integration/reserve-concurrency.int.test.ts#AC-01`

**AC-02** (FR-04) — GIVEN reservation created with `Idempotency-Key` K WHEN the same body is
sent again with K, also concurrently while the first is still running THEN the stored 201
response is returned; the ledger holds one entry.
proof (planned): `test/integration/idempotency.int.test.ts#AC-02`

**AC-03** (FR-04) — GIVEN reservation created with key K WHEN a different body is sent with K
THEN 422; nothing changes.
proof (planned): `test/integration/idempotency.int.test.ts#AC-03`

**AC-04** (FR-02) — GIVEN INV-1 reserved for EUR 1,000,000 WHEN a reserve for INV-1 arrives
without a key: same amount, then a different amount THEN same amount: 200 with the existing
reservation. Different amount: 409.
proof (planned): `test/integration/reserve.int.test.ts#AC-04`

**AC-05** (FR-03) — GIVEN USD 1,100,000.00 reserved for EUR 1,000,000.00 WHEN releases of EUR
333,333.33, 333,333.33 and 333,333.34 THEN released program amounts sum to exactly USD
1,100,000.00; status `RELEASED`.
proof (planned): `test/integration/release.int.test.ts#AC-05` and
`test/property/release.property.test.ts#AC-05`

**AC-06** (FR-03) — GIVEN active reservation with remainder R and a release `X` already
applied WHEN a release above R; `X` again with the same body; `X` with a different amount
THEN above R: 422, no change. Same body: original result, no change. Different body: 422
`release-ref-mismatch`.
proof (planned): `test/integration/release.int.test.ts#AC-06`

**AC-13** (FR-10) — GIVEN token for tenant A with scope `capacity:read` WHEN it reads tenant
B's program; it reserves; a call has no token THEN 404; 403; 401.
proof (planned): `test/e2e/auth.e2e.test.ts#AC-13`

**AC-16** (FR-10) — GIVEN tenants A and B each have a program with id `grand-usd` WHEN tenant
A reserves on `grand-usd` THEN only tenant A's program changes.
proof (planned): `test/e2e/auth.e2e.test.ts#AC-16`

**AC-17** (FR-04) — GIVEN a reserve under key K was rejected with 422 insufficient capacity
WHEN the same body is sent with K after capacity was freed THEN the stored 422 is replayed;
a new key is needed for a new attempt.
proof (planned): `test/integration/idempotency.int.test.ts#AC-17`

## Invariants

I1–I8 (PRD §6) hold after every test; the property suite asserts I1–I5 on random sequences.
Lock order: dedup row → program row → reservation rows. No `SELECT … FOR UPDATE` on the
idempotency row (review D3 closed). Money rules 1–6 of PRD §6 are law: round **up** on
reserve, floor on partial release, exact remainder on the final release.

## Out of scope

Kafka input, FX ingestion (seed rates directly in tests; AC-12 is lane 0003), list
endpoints and ledger read (FR-12, lane 0004), outbox relay (rows are written here, published
in 0004), gRPC.

## Tasks

See `tasks.md`.
