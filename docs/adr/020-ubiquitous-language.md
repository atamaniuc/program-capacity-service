# 020. Ubiquitous language and naming rules

- Status: accepted
- Date: 2026-10-28

## Context

Humans and agents write code, API fields, events and docs for the same domain. Synonyms for
the same concept cause bugs in money code and in reviews.

## Decision

`docs/glossary.md` is the vocabulary. Code, API, events, logs and docs use those words and
those identifiers (`creditLimit`, `reserved`, `available`, `reservationId`, `releaseRef`).
*Allocation*, *booking* and *balance* are not used. A new term is added to the glossary in the
same change that introduces it.

## Consequences

Review can reject a pull request for a synonym; agent instructions point to the glossary.

## Alternatives rejected

Free naming per author; a generated glossary from code identifiers.
