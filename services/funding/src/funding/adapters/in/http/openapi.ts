import { createDocument } from 'zod-openapi';
import * as z from 'zod';
import {
  CreateFundingRequestBody,
  FundingRequestParams,
  FundingRequestResponse,
  IdempotencyKeyHeader,
  ProblemResponse,
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

/** The REST contract of funding `/v1`, generated from the same zod schemas that validate requests. */
export function buildOpenApiDocument(options: { localApiHost?: string } = {}) {
  return createDocument({
    openapi: '3.1.0',
    info: {
      title: 'Funding Service',
      version: '1.0.0',
      description:
        'Early payment of supplier invoices. A request completes eventually: poll `GET /v1/funding-requests/{id}`. Errors are RFC 9457 `application/problem+json`; clients branch on `type`. Amounts are decimal strings at the ISO 4217 scale.',
    },
    servers: [{ url: `http://${options.localApiHost ?? 'localhost:13100'}` }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/v1/funding-requests': {
        post: {
          operationId: 'createFundingRequest',
          summary: 'Ask to pay one invoice early',
          description:
            'Scope `funding:write`, audience `funding-service`. 202 with `Location` when recorded; 200 with the existing request when one exists for the same tenant, program and invoice with the same terms; 409 with other terms.',
          requestParams: { header: IdempotencyKeyHeader },
          requestBody: { content: { 'application/json': { schema: CreateFundingRequestBody } } },
          responses: {
            '202': {
              ...json('Recorded in state RECEIVED.', FundingRequestResponse),
              headers: { Location: { schema: { type: 'string' } } },
            },
            '200': json(
              'The existing funding request with the same terms.',
              FundingRequestResponse,
            ),
            '400': problem('Validation error.'),
            '409': problem('A funding request for this invoice exists with other terms.'),
            '413': problem('Payload too large.'),
            '422': problem('The Idempotency-Key was used with a different request.'),
            ...authErrors,
          },
        },
      },
      '/v1/funding-requests/{id}': {
        get: {
          operationId: 'getFundingRequest',
          summary: 'Current state of a funding request',
          description: "Scope `funding:read`. Another tenant's request answers 404.",
          requestParams: { path: FundingRequestParams },
          responses: {
            '200': json('The funding request.', FundingRequestResponse),
            '404': problem('No such funding request.'),
            ...authErrors,
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
