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

## Words not to use

*Allocation*, *booking* and *balance* are not terms of this context. Use *reservation*,
*reserved* and *available* instead.
