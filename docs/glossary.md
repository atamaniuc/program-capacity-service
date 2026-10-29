# Glossary

Code, API, events, logs and docs use exactly these words (PRD section 7, ADR 020). Do not
invent synonyms.

| Term | Meaning | In code |
| --- | --- | --- |
| Program | A funder's facility for one buyer's suppliers, with one credit limit in one currency | `Program`, `programId` |
| Credit limit | Maximum exposure the program may hold at once | `creditLimit` |
| Reserved | Sum of open reservations, in program currency | `reserved` |
| Available | Credit limit minus reserved, never below zero | `available` |
| Over limit | Reserved exceeds the credit limit after a limit cut | `overLimitBy`, `ProgramOverLimit` |
| Reservation | Capacity held for one invoice approved for early payment | `Reservation`, `reservationId` |
| Release | Returning reserved capacity after repayment or cancellation | `Release`, `releaseRef` |
| Repayment | The buyer pays the invoice to the funder; treasury reports it | `RepaymentReceived` |
| Invoice amount, reserved amount | The amount in invoice currency, and its conversion into program currency | `invoiceAmount`, `reservedAmount` |
| FX rate | Rate from invoice currency to program currency, fixed at reservation | `FxRate` |
| Treasury | The bank's system of record for limits and settled state | `treasury` adapter namespace |
| Snapshot | Treasury's full state of one program at a sequence number | `ProgramReconciled` |
| Watermark | Highest platform event sequence treasury had applied when it took a snapshot | `platformWatermark` |
| Drift | A difference between a snapshot and the platform's state | `ReconciliationDriftDetected` |
| Tenant | A bank using the platform | `tenantId` |
| Ledger entry | Immutable record of one change to the limit or to reserved | `LedgerEntry` |

### Funding context (branch `microservices`, ADR 023 and ADR 025)

| Term | Meaning | In code |
| --- | --- | --- |
| Funding request | A request to pay one supplier invoice early; owned by `funding-service` | `FundingRequest`, `fundingRequestId` |
| Risk check | The local policy that approves or declines a funding request before any capacity is reserved | `RiskCheck` |
| Disbursement | The payment of the funded amount to the supplier through the payment rail | `Disbursement`, `paymentId` |
| Payment rail | The external system that moves the money (a mock on this branch) | `payments` adapter namespace |
| Saga | The persisted, orchestrated sequence of steps that turns a funding request into a disbursement | `FundingSaga` |
| Saga step | One step of the saga with its own deterministic idempotency key: risk check, reserve, disburse, compensate | `SagaStep` (`RISK_CHECK`, `RESERVE`, `DISBURSE`, `COMPENSATE`) |
| Compensation | The forward action that undoes an earlier step after a definite failure: a release of the saga's own reservation | `compensation`, `releaseRef = funding:<id>:compensation` |
| Pivot step | The step after which the saga only moves forward: the disbursement | `DISBURSE` |
| Needs attention | A funding request the saga cannot finish on its own (unknown disbursement, unexpected compensation answer); waits for an operator | `NEEDS_ATTENTION` |

## Words not to use

*Allocation*, *booking* and *balance* are not terms of this context. Use *reservation*,
*reserved* and *available* instead.
