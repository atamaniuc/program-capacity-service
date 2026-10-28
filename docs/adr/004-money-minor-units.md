# 004. Money as integer minor units

- Status: accepted
- Date: 2026-10-28

## Context

Binary floating point cannot represent cents; funding more than approved is the product's main
risk (I8).

## Decision

Money is `bigint` minor units plus an ISO 4217 code (`Money`). A table of minor-unit exponents
(USD, EUR, GBP, AED 2; JPY 0; KWD, BHD, OMR 3 and more) defines scale. JSON carries decimal
strings; parsing requires exactly the currency's number of fraction digits and refuses signs,
exponents, separators and spaces. PostgreSQL stores `BIGINT`; `pg` returns it as a string that
is converted with `BigInt`, never `Number`. ESLint forbids `Number` and `parseFloat` in the
domain. Release rule: a partial release frees floor(amount × repaid ÷ invoice amount) and the
completing release takes the exact remainder, so releases always sum to the reserved amount.

**Upper bound.** `parseMoney` refuses more than `MAX_MINOR` = 2^63 − 1 minor units, the largest
`BIGINT`, with 400 `validation-error`. `bigint` itself has no limit, so before this bound such
an amount crossed the domain and failed only at the `INSERT` (22003, out of range). The client
then got 500 "retry later" for a request that can never succeed, and would retry forever. The
review hit this case with a JPY amount of 20 digits and a tiny JPY→USD rate: the converted USD
amount fit under the limit, so the capacity check passed and the invoice amount itself
overflowed. The rule: a value that can never be stored is a validation error, decided at the
edge.

## Consequences

- Rounding is explicit and testable (property test AC-05); amounts above 2^53 are safe.
- Version and sequence counters are small integers and use `number`; they are not money.

## Alternatives rejected

Decimal libraries (extra dependency, hidden rounding), `NUMERIC` money columns (arithmetic would
move into SQL strings), floats (wrong by construction).
