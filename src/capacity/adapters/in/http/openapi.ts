import { createDocument } from 'zod-openapi';
import * as z from 'zod';
import {
  LedgerPageResponse,
  LedgerQuery,
  ListReservationsQuery,
  ReservationPageResponse,
} from './query-schemas.js';
import {
  CapacityResponse,
  IdempotencyKeyHeader,
  ProblemResponse,
  ProgramIdParam,
  ReleaseRequest,
  ReleaseResponse,
  ReservationDetailResponse,
  ReservationParams,
  ReservationResponse,
  ReserveRequest,
} from './schemas.js';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemResponse } },
});

const json = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
});

const authErrors = {
  '401': problem('Missing, invalid or expired bearer token.'),
  '403': problem('The token lacks the required scope.'),
};

const idempotencyNote =
  ' Send an optional `Idempotency-Key`: the first outcome, including a business rejection such as 404, 409 or 422, is stored and replayed for that key; keys are kept at least 24 hours.';

/** The REST contract of `/v1`, generated from the same zod schemas that validate requests. */
export function buildOpenApiDocument() {
  return createDocument({
    openapi: '3.1.0',
    info: {
      title: 'Program Capacity Service',
      version: '1.0.0',
      description:
        'Real-time credit capacity of supply chain finance programs. Errors are RFC 9457 `application/problem+json`; clients branch on `type`. Amounts are decimal strings at the ISO 4217 scale.',
    },
    servers: [{ url: 'http://localhost:3000' }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/v1/programs/{programId}/capacity': {
        get: {
          operationId: 'getCapacity',
          summary: 'Current availability of a program',
          description:
            'Scope `capacity:read`. `ETag` is the program version; `If-None-Match` answers 304.',
          requestParams: { path: ProgramIdParam },
          responses: {
            '200': {
              ...json('Capacity', CapacityResponse),
              headers: z.object({
                etag: z.string().meta({ description: 'Program version, quoted.' }),
              }),
            },
            '304': { description: 'Not modified.' },
            ...authErrors,
            '404': problem('Unknown program, or a program of another tenant.'),
          },
        },
      },
      '/v1/programs/{programId}/reservations': {
        get: {
          operationId: 'listReservations',
          summary: 'List the reservations of a program',
          description:
            "Scope `capacity:read`. Filter by `invoiceId` and `status`; pages are ordered by creation and carry an opaque `nextCursor` (null on the last page). Tenant-scoped: another tenant's program is 404.",
          requestParams: { path: ProgramIdParam, query: ListReservationsQuery },
          responses: {
            '200': json('A page of reservations.', ReservationPageResponse),
            '400': problem('`validation-error`: bad filter, page size or cursor.'),
            ...authErrors,
            '404': problem('`not-found`.'),
          },
        },
        post: {
          operationId: 'reserveCapacity',
          summary: 'Reserve capacity for an invoice',
          description: `Scope \`capacity:write\`. One reservation per invoice.${idempotencyNote}`,
          requestParams: { path: ProgramIdParam, header: IdempotencyKeyHeader },
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ReserveRequest } },
          },
          responses: {
            '201': json('Reserved.', ReservationResponse),
            '200': json('The invoice already has this reservation (replay).', ReservationResponse),
            '400': problem('`validation-error`.'),
            ...authErrors,
            '404': problem('`not-found`.'),
            '409': problem(
              '`reservation-conflict`: different terms for the invoice, or the invoice is fully released.',
            ),
            '422': problem(
              '`insufficient-capacity`, `program-over-limit`, `program-suspended`, `fx-rate-unavailable` or `idempotency-key-mismatch`.',
            ),
          },
        },
      },
      '/v1/programs/{programId}/ledger': {
        get: {
          operationId: 'getLedger',
          summary: 'Audit trail of a program',
          description:
            'Scope `capacity:read`. Append-only ledger entries, oldest first, with cause, actor and the balance after each change; keyset-paged with an opaque `nextCursor`.',
          requestParams: { path: ProgramIdParam, query: LedgerQuery },
          responses: {
            '200': json('A page of ledger entries.', LedgerPageResponse),
            '400': problem('`validation-error`: bad page size or cursor.'),
            ...authErrors,
            '404': problem('`not-found`.'),
          },
        },
      },
      '/v1/programs/{programId}/reservations/{reservationId}': {
        get: {
          operationId: 'getReservation',
          summary: 'One reservation with its releases',
          description: 'Scope `capacity:read`.',
          requestParams: { path: ReservationParams },
          responses: {
            '200': json('Reservation', ReservationDetailResponse),
            ...authErrors,
            '404': problem('`not-found`.'),
          },
        },
      },
      '/v1/programs/{programId}/reservations/{reservationId}/releases': {
        post: {
          operationId: 'releaseReservation',
          summary: 'Release a reservation fully or partially',
          description: `Scope \`capacity:write\`. A partial release frees floor(reserved x repaid / invoice amount); the release that completes the invoice takes the exact remainder. The same \`releaseRef\` with the same body replays the result.${idempotencyNote}`,
          requestParams: { path: ReservationParams, header: IdempotencyKeyHeader },
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ReleaseRequest } },
          },
          responses: {
            '200': json('Released (or replayed).', ReleaseResponse),
            '400': problem('`validation-error`.'),
            ...authErrors,
            '404': problem('`not-found`.'),
            '422': problem(
              '`release-exceeds-remaining`, `release-ref-mismatch` or `idempotency-key-mismatch`.',
            ),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
  });
}
