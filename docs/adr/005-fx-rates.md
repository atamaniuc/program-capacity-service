# 005. FX rates: scaled integers, round up, fixed at reservation

- Status: accepted
- Date: 2026-10-28

## Context

An invoice in EUR consumes capacity of a USD program. The platform must never reserve less than
the risk it takes, and a later market move must not change what a reservation holds.

## Decision

Rates are `NUMERIC(20,10)` in `fx_rate` (base = invoice currency, quote = program currency),
read as strings and held as `bigint` scaled by 10^10. A reserve takes the newest row with
`as_of > now − FX_MAX_AGE` (default 24 h); none means 422 `fx-rate-unavailable`, stored under the
idempotency key like any business rejection. Conversion is one integer division:
ceil(invoice minor × rate × 10^programScale ÷ 10^(10 + invoiceScale)). The reservation stores
rate, source and `as_of`; releases never read the market. Same currency: rate 1, source
`identity`, no lookup.

## Consequences

- Rounding up can reserve up to one program minor unit more than the exact product.
- Rate ingestion (Kafka) arrives in lane 0003; tests seed rows directly.

## Alternatives rejected

Rounding to nearest (can under-reserve), reading the rate again on release (the release would
not match the reservation), floats.
