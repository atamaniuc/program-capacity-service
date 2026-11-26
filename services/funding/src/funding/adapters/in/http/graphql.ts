import DataLoader from 'dataloader';
import { buildSchema, graphql, GraphQLError, type ExecutionResult } from 'graphql';
import * as z from 'zod';
import {
  toView,
  type CreateFundingRequest,
  type FundingRequestView,
} from '../../../application/funding-requests.js';
import type { FundingRequestReader } from '../../../application/ports.js';
import { stepKey } from '../../../domain/keys.js';
import type { Principal, Scope } from './auth.js';
import { HttpProblem } from './problem.js';
import { CreateFundingRequestBody, FUNDING_STATES, IdempotencyKeyHeader } from './schemas.js';

const MAX_BATCH = 50;
const schema = buildSchema(`
  type Query {
    recentFundingRequests(limit: Int = 20): [FundingRequest!]!
    fundingRequest(id: ID!): FundingRequest
    fundingRequests(ids: [ID!]!): [FundingRequest]!
  }

  type Mutation {
    createFundingRequest(input: CreateFundingRequestInput!, idempotencyKey: String): FundingRequest!
  }

  input CreateFundingRequestInput {
    programId: ID!
    invoiceId: ID!
    amount: AmountInput!
  }

  input AmountInput { value: String!, currency: String! }
  type Amount { value: String!, currency: String! }

  type FundingRequest {
    id: ID!
    programId: ID!
    invoiceId: ID!
    amount: Amount!
    state: FundingState!
    reason: String
    reservationId: ID
    paymentId: ID
    createdAt: String!
    invoice: Invoice
    buyer: Buyer
    payment: Payment
  }

  enum FundingState { ${FUNDING_STATES.join(' ')} }
  type Invoice { id: ID!, description: String!, dueInDays: Int! }
  type Buyer { id: ID!, name: String!, region: String! }
  type Payment { paymentId: ID!, status: PaymentStatus!, amountMinor: String!, currency: String! }
  enum PaymentStatus { PAID DECLINED }
`);

const envelope = z.object({
  query: z.string(),
  variables: z.record(z.string(), z.unknown()).nullish(),
  operationName: z.string().nullish(),
});
const id = z.uuid().transform((value) => value.toLowerCase());
const ids = z.array(id).max(MAX_BATCH);
const limit = z.int().min(1).max(MAX_BATCH);
const invoice = z.object({ id: z.string(), description: z.string(), dueInDays: z.int() });
const buyer = z.object({ id: z.string(), name: z.string(), region: z.string() });
const payment = z.object({
  paymentId: z.string(),
  status: z.enum(['PAID', 'DECLINED']),
  amountMinor: z.string(),
  currency: z.string(),
});

interface Dependencies {
  readonly create: Pick<CreateFundingRequest, 'execute'>;
  readonly reader: FundingRequestReader;
  readonly invoiceUrl: string;
  readonly buyerUrl: string;
  readonly paymentUrl: string;
  readonly onError: (error: unknown) => void;
}

export type FundingGraphql = (principal: Principal, payload: unknown) => Promise<ExecutionResult>;

function requireScope(principal: Principal, scope: Scope): void {
  if (!principal.scopes.has(scope)) {
    throw new GraphQLError(`The token lacks the ${scope} scope.`, {
      extensions: { code: 'FORBIDDEN' },
    });
  }
}

function validated<T>(validator: z.ZodType<T>, input: unknown, message: string): T {
  const result = validator.safeParse(input);
  if (!result.success) {
    throw new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return result.data;
}

function remoteLoader<T>(
  endpoint: URL,
  validator: z.ZodType<T>,
  count: () => void,
): DataLoader<string, T | null> {
  const responseShape = z.object({
    records: z.array(z.object({ key: z.string(), value: validator })).max(MAX_BATCH),
  });
  return new DataLoader(
    async (keys) => {
      count();
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: keys }),
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) throw new Error(`Batch endpoint returned HTTP ${response.status}.`);
      const { records } = responseShape.parse(await response.json());
      const byKey = new Map(records.map(({ key, value }) => [key, value]));
      return keys.map((key) => byKey.get(key) ?? null);
    },
    { maxBatchSize: MAX_BATCH },
  );
}

export function createFundingGraphql(deps: Dependencies): FundingGraphql {
  const invoiceEndpoint = new URL('/v1/batch', deps.invoiceUrl);
  const buyerEndpoint = new URL('/v1/batch', deps.buyerUrl);
  const paymentEndpoint = new URL('/v1/payments/batch', deps.paymentUrl);

  return async (principal, payload) => {
    const parsed = envelope.safeParse(payload);
    if (!parsed.success) {
      throw HttpProblem.business(
        'validation-error',
        'Expected a GraphQL request object with a query.',
      );
    }
    const batches = { fundingDb: 0, invoiceHttp: 0, buyerHttp: 0, paymentHttp: 0 };
    const invoices = remoteLoader(invoiceEndpoint, invoice, () => {
      batches.invoiceHttp++;
    });
    const buyers = remoteLoader(buyerEndpoint, buyer, () => {
      batches.buyerHttp++;
    });
    const payments = remoteLoader(paymentEndpoint, payment, () => {
      batches.paymentHttp++;
    });

    const withRelations = (view: FundingRequestView) => ({
      ...view,
      invoice: () => invoices.load(view.invoiceId),
      buyer: () => buyers.load(view.programId),
      payment: () => (view.paymentId === null ? null : payments.load(stepKey(view.id, 'disburse'))),
    });
    const requests = new DataLoader<string, FundingRequestView | null>(
      async (keys) => {
        batches.fundingDb++;
        const rows = await deps.reader.byIds(principal.tenantId, keys);
        const byId = new Map(rows.map((row) => [row.id, toView(row)]));
        return keys.map((key) => byId.get(key) ?? null);
      },
      { maxBatchSize: MAX_BATCH },
    );
    const requestById = async (key: string) => {
      const view = await requests.load(key);
      return view === null ? null : withRelations(view);
    };

    const result = await graphql({
      schema,
      source: parsed.data.query,
      variableValues: parsed.data.variables,
      operationName: parsed.data.operationName,
      rootValue: {
        recentFundingRequests: async (args: { limit: unknown }) => {
          requireScope(principal, 'funding:read');
          const count = validated(limit, args.limit, 'The limit must be between 1 and 50.');
          batches.fundingDb++;
          const rows = await deps.reader.recent(principal.tenantId, count);
          return rows.map((row) => withRelations(toView(row)));
        },
        fundingRequest: (args: { id: unknown }) => {
          requireScope(principal, 'funding:read');
          return requestById(validated(id, args.id, 'Expected a funding request UUID.'));
        },
        fundingRequests: (args: { ids: unknown }) => {
          requireScope(principal, 'funding:read');
          return Promise.all(
            validated(ids, args.ids, 'Expected at most 50 funding request UUIDs.').map(requestById),
          );
        },
        createFundingRequest: async (args: { input: unknown; idempotencyKey?: string | null }) => {
          requireScope(principal, 'funding:write');
          const input = validated(
            CreateFundingRequestBody,
            args.input,
            'Invalid funding request input.',
          );
          const key = validated(
            IdempotencyKeyHeader,
            { 'idempotency-key': args.idempotencyKey ?? undefined },
            'Invalid idempotency key.',
          );
          const outcome = await deps.create.execute({
            ...input,
            tenantId: principal.tenantId,
            idempotencyKey: key['idempotency-key'],
          });
          if (!outcome.ok) {
            throw new GraphQLError(outcome.problem.detail, {
              extensions: { code: outcome.problem.type },
            });
          }
          return withRelations(outcome.value);
        },
      },
    });

    const errors = result.errors?.map((error) => {
      if (error.originalError === undefined || error.originalError instanceof GraphQLError) {
        return error;
      }
      deps.onError(error.originalError);
      return new GraphQLError('The server could not resolve this field.', {
        ...(error.nodes === undefined ? {} : { nodes: error.nodes }),
        ...(error.path === undefined ? {} : { path: error.path }),
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      });
    });
    return { ...result, ...(errors === undefined ? {} : { errors }), extensions: { batches } };
  };
}
