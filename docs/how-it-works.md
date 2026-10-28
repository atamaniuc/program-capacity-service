# How it works — the business in plain words

Read this first if supply chain finance is new to you. It takes about 10 minutes.

## The business in one paragraph

A big **buyer** (say, a retailer) owes money to many small **suppliers**, payable in 90 days.
Suppliers cannot wait 90 days, so a **bank (funder)** pays them early, at a small discount, and
the buyer repays the bank on the due date. The bank does not lend without a cap: it opens a
**program** for that buyer with a **credit limit**, for example USD 10,000,000. Every invoice
the bank pays early uses part of that limit until the buyer repays it.

This service answers one question in real time and never gets it wrong:
**"How much of this program's limit is still available?"**

## The words

The full glossary is in [glossary.md](glossary.md). The ones you need now:

| Word | Meaning |
| --- | --- |
| **Program** | One bank facility for one buyer, with one credit limit in one currency |
| **Reservation** | Capacity held for one invoice approved for early payment |
| **Reserved** | Sum of all open reservations |
| **Available** | `credit limit − reserved` (never shown below zero) |
| **Release** | Giving capacity back when the buyer repays (or the deal is cancelled) |
| **Treasury** | The bank's own system. It owns the limits and sees the repayments |
| **Tenant** | One bank using the platform. Banks never see each other's data |

## A worked example

Program `prg_grand_usd`, owned by `bank-a`, limit **USD 10,000,000.00**.

| Step | What happens | Reserved | Available |
| --- | --- | ---: | ---: |
| 1 | Treasury sends `ProgramLimitSet` (limit 10,000,000.00) over Kafka | 0.00 | 10,000,000.00 |
| 2 | Platform reserves invoice `INV-1` for USD 4,000,000.00 | 4,000,000.00 | 6,000,000.00 |
| 3 | Platform reserves invoice `INV-2` for EUR 1,000,000.00 at 1.0800 → USD 1,080,000.00 | 5,080,000.00 | 4,920,000.00 |
| 4 | Platform tries `INV-3` for USD 5,000,000.00 → **422 insufficient-capacity**, nothing changes | 5,080,000.00 | 4,920,000.00 |
| 5 | Buyer repays half of `INV-1`; treasury sends `RepaymentReceived` (USD 2,000,000.00) | 3,080,000.00 | 6,920,000.00 |
| 6 | Treasury cuts the limit to USD 3,000,000.00 | 3,080,000.00 | 0.00, **over limit by 80,000.00** |

Step 6 shows a rule worth knowing: a limit cut **never cancels** existing reservations (PRD
assumption A10). The program is simply "over limit" and refuses new reservations until
repayments bring it back under.

## The rules the service must never break

These are the invariants from PRD §6, in plain words. Tests exist for each one.

1. **Never over-reserve.** A new reservation is accepted only if `reserved + amount ≤ limit`,
   even when a hundred requests arrive at the same millisecond.
2. **Money is exact.** Amounts are integers in the currency's smallest unit (cents for USD,
   fils for KWD, which has 3 decimals). No floating point anywhere.
3. **Reserved always equals the sum of open reservations**, and also equals the sum of the
   ledger. A job re-checks this every 5 minutes.
4. **The ledger is append-only.** Every change (reserve, release, limit change, reconciliation
   fix) adds a row; nothing is updated or deleted. That is the audit trail.
5. **Retries are safe.** Sending the same request twice with the same `Idempotency-Key`, or
   Kafka delivering the same message twice, changes the state once.
6. **Tenants are isolated.** Bank A can never read or change Bank B's programs, even if both
   use the same program id.

## Currencies and rounding

An invoice can be in a different currency from its program (EUR invoice, USD program).

- The rate comes from treasury (`FxRatePublished` on Kafka) and is valid for 24 hours. With no
  fresh rate the reserve is refused (`fx-rate-unavailable`) rather than guessed.
- The rate is **fixed at reservation time** and stored on the reservation, so later rate moves
  do not change what was reserved.
- Conversion **rounds up**, so the program never holds less than the real exposure.
- A partial repayment releases a proportional share, rounded **down**; the last repayment
  releases exactly what is left. Over many partial repayments nothing is lost or created.

## Who can change capacity, and how

| Source | How it arrives | What it can do |
| --- | --- | --- |
| Platform (invoice workflow) | REST `POST /v1/programs/{id}/reservations` and `…/releases` | Reserve; release on cancellation or repayment |
| Treasury | Kafka `treasury.capacity.v1` | Set limits, report repayments, send full snapshots |
| Treasury | Kafka `treasury.fx-rates.v1` | Publish FX rates |

Everything the service changes is announced on Kafka `capacity.events.v1`
(`ReservationCreated`, `ReservationReleased`, `ProgramCapacityChanged`,
`ReconciliationDriftDetected`), so treasury and other systems can follow along.

## Reconciliation

Two systems keep books on the same program, so they can drift apart (a lost message, a manual
fix at the bank). Periodically treasury sends a **snapshot**: its full view of one program.

The snapshot also carries a **watermark**: "I have applied all of your events up to number
N". That lets the service tell *"treasury hasn't seen this yet"* apart from *"treasury lost
this"*:

| What the service finds | What it does |
| --- | --- |
| Snapshot is older than what was already applied | Ignore it |
| Limit differs | Take treasury's limit |
| Same reservation, tiny difference in converted amount (≤ 1 minor unit) | Keep ours (rounding noise) |
| Same reservation, real difference | Take treasury's amount, record a drift |
| Treasury has a reservation the service doesn't | Adopt it, record a drift |
| The service has a reservation newer than the watermark | Keep it: treasury hasn't seen it yet |
| The service has a reservation treasury should know but doesn't | **HOLD** and raise a drift alert (releasing money automatically on a guess is the riskier mistake) |

`RECON_MODE=RELEASE` switches the last row to automatic release if a bank wants that.

## What happens when things break

| Failure | Behaviour |
| --- | --- |
| Kafka is down | The REST API keeps working. Events wait in the outbox table and go out when Kafka is back |
| PostgreSQL is down | Readiness turns red, requests fail fast with 503, Kafka consumption pauses and resumes later |
| A broken Kafka message | Copied to `<topic>.dlq` with the error in headers; the consumer moves on. `make dlq-replay` re-sends fixed messages |
| The identity provider is down | 503 (not 401), so clients know it is not their token |
| The pod is stopped (SIGTERM) | Readiness turns red, in-flight requests and messages finish, offsets are committed, then it exits |

Next: [architecture.md](architecture.md) shows how this is built.
