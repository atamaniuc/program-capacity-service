# 015. Contracts generated from zod

- Status: accepted; amended on branch `microservices` by [ADR 024](024-grpc-driving-adapter.md) (proto contract, `buf`) and [ADR 028](028-contracts-package-and-consumer-contracts.md) (contracts package, Pact)
- Date: 2026-10-28; amended 2026-10-29 (AsyncAPI covers the outbound events and is served)

## Context

Validation and documentation drift when written twice. The service has two published
languages: the REST API and Kafka (treasury input, `capacity.events.v1` output, DLQs).

## Decision

**REST.** zod 4 schemas in `src/capacity/adapters/in/http/schemas.ts` validate requests and
describe responses. `zod-openapi` builds OpenAPI 3.1 from them into `contracts/openapi.yaml`.
`test/e2e/contract.e2e.test.ts` validates real responses against the generated component
schemas with ajv. The document is served as `/docs` (Swagger UI) and `/docs/openapi.json` on
the ops port only. No `@nestjs/swagger`, no class-validator.

**Kafka.** zod schemas describe every message: `treasury-messages.ts` validates treasury input,
`capacity-events.ts` types the payloads the use cases write to the outbox (`OutboxEvent` is a
union of those types, so a payload with a missing or mistyped field does not compile; an extra
field is caught by the strict schemas below).
`src/platform/contracts/asyncapi.ts` (beside the wiring, like `openapi.ts` beside the HTTP
adapter: it holds servers and page copy, not business rules) builds one AsyncAPI 3.1 document
from them: both treasury
topics, both DLQs and `capacity.events.v1`, with Kafka keys, the event headers, the consumer
group and an example per message. It is committed as `contracts/asyncapi.yaml` plus one
self-contained JSON Schema per message in `contracts/json-schema/`, and served with the payloads
inlined as `/docs/asyncapi` (the AsyncAPI React viewer) and `/docs/asyncapi.json`, next to
Swagger UI.

- The published JSON Schemas are **draft-07**, the dialect AsyncAPI schema objects extend, so
  the files and the AsyncAPI document are one schema, not two. They are **open** (no
  `additionalProperties: false`): consumers ignore unknown fields and `v1` may grow additively.
- Tests also build a **strict** variant from the same zod schemas (`io: 'output'`, which adds
  `additionalProperties: false`): the producer may not send a field the contract leaves out.
- `test/kafka/capacity-events.kafka.test.ts` runs the whole service, drives all four event types
  through HTTP and treasury input, consumes `capacity.events.v1` and checks every record against
  the committed schemas (open and strict), the header schema, the key and the gap-free `seq`.
  `make qa` does the same on the compose stack (QA-72, `npm run contracts:events`).
- `test/contracts/asyncapi.test.ts` parses the document with the official `@asyncapi/parser`
  (no error or warning) and validates every example against the strict schemas.

**Drift.** `npm run contracts` writes every file under `contracts/`; `npm run contracts:check`
(in `make verify` and CI) regenerates them in memory and exits 1 when any file differs or a
schema file has no message any more.

**Compatibility (NFR-14).** Drift only proves the files match the code; it does not stop a
breaking edit of both. `npm run contracts:compat` (`make compat`, and CI against the pull
request's target or the pushed-over commit) compares `contracts/` with the base commit:

- On branch `microservices` the base follows the proto rule of [ADR 024](024-grpc-driving-adapter.md):
  the pull request's target on `pull_request`, the pushed-over commit on `push`, and `HEAD` when
  `--base` is not given (a local run catches an uncommitted breaking edit). The default is not
  `origin/main`: the branch is ahead of it, so that comparison would also flag branch work and,
  once merged, would pass for the wrong reason. The AsyncAPI `local` server host is generated from
  `HOST_PORT_KAFKA` (default 39092, [ADR 027](027-repository-layout-and-side-by-side-isolation.md)), never edited by hand.
- `openapi.yaml` with oasdiff (`tufin/oasdiff:v1.34.0`, `breaking --fail-on ERR`);
- every message schema and the header schemas with `tools/contracts/compare-schemas.ts`. Within
  `v1` the only allowed changes are a new optional field, a new value of the `event-type` header
  and documentation. A removed, newly required or retyped field, a changed pattern or bound, or a
  new value of any other enum fails. Enums are closed because consumers branch on them; event
  types are open because consumers skip types they do not know.

A new field is therefore optional even when the code always sends it: older records on the
topic lack it. `ProgramCapacityChanged.status` is the first such field (added 2026-10-29, so a
consumer learns about a suspension); the Kafka contract test checks the code always sends it.
A breaking change is a new version (`/v2`, `capacity.events.v2`), never an edit. The full table
of allowed changes, why a new enum value counts as breaking, how to open an enum when
consumers agree and how to version a change: [api.md §8](../api.md#8-changing-a-contract).

**Viewer in the image.** `@asyncapi/react-component` is a devDependency. The Dockerfile copies
only its prebuilt standalone bundle, stylesheet and licences into the runtime image (~3 MB). The
bundle runs in the browser, never in the server process; its dependencies are minified inside
it, so the image scan cannot see them, which is the cost of a self-hosted viewer. Without the
bundle the page still serves the document and says how to install the viewer (unit-tested).

## Consequences

- The committed YAML and JSON are reviewable in diffs; a contract change shows up as diff lines
  (NFR-14).
- The files are generated, so Prettier ignores `contracts/`.
- The same `v1` rules hold on both sides: additive changes only; a breaking change to an event
  gets `capacity.events.v2`.

## Alternatives rejected

Hand-written YAML (drift), decorators on classes (second schema language), Pact (settled), a
schema registry with Avro (extra infrastructure while there is one producer and no consumer to
check against; it arrives with the first split, PRD §7), JSON Schema 2020-12 files (AsyncAPI
would need a second, draft-07 copy), loading the viewer from a CDN (the docs must work offline,
like Swagger UI), shipping `@asyncapi/react-component` as a runtime dependency (its parser tree,
jsdom included, would sit in `node_modules` of a server that never runs it), `oasdiff`-style
tooling for JSON Schema from npm (none checks both directions the way this contract needs; the
rule above is one small, unit-tested module).
