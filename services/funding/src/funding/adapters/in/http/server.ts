import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  CreateFundingRequest,
  GetFundingRequest,
} from '../../../application/funding-requests.js';
import type { Outcome } from '../../../application/problem.js';
import { requireScope, type JwtVerifier } from './auth.js';
import { HttpProblem, PROBLEM_CONTENT_TYPE, problemBody } from './problem.js';
import { CreateFundingRequestBody, IdempotencyKeyHeader } from './schemas.js';

const MAX_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HttpDependencies {
  readonly verifier: JwtVerifier;
  readonly create: CreateFundingRequest;
  readonly get: GetFundingRequest;
  readonly onError?: (error: unknown) => void;
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  contentType = 'application/json',
): void {
  response.writeHead(status, { 'content-type': contentType, ...headers });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw HttpProblem.of('payload-too-large', 'The body is too large.');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw HttpProblem.business('validation-error', 'The body is not valid JSON.');
  }
}

function answer<V>(response: ServerResponse, outcome: Outcome<V>, location?: (value: V) => string) {
  if (!outcome.ok) {
    send(response, outcome.problem.status, problemBody(outcome.problem), {}, PROBLEM_CONTENT_TYPE);
    return;
  }
  const headers: Record<string, string> = {};
  if (location !== undefined && outcome.status === 202)
    headers['Location'] = location(outcome.value);
  send(response, outcome.status, outcome.value, headers);
}

/** The REST adapter of funding: `POST /v1/funding-requests`, `GET /v1/funding-requests/{id}`. */
export function createHttpServer(deps: HttpDependencies): Server {
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = request.method ?? 'GET';
    const item = /^\/v1\/funding-requests\/([^/]+)$/.exec(url.pathname);

    if (url.pathname === '/v1/funding-requests') {
      if (method !== 'POST') {
        send(
          response,
          405,
          problemBody({
            type: 'not-found',
            title: 'Method not allowed',
            status: 405,
            detail: 'Use POST.',
          }),
          { Allow: 'POST' },
          PROBLEM_CONTENT_TYPE,
        );
        return;
      }
      const principal = await deps.verifier.authenticate(request.headers.authorization);
      requireScope(principal, 'funding:write');
      const header = IdempotencyKeyHeader.safeParse({
        'idempotency-key': request.headers['idempotency-key'],
      });
      if (!header.success)
        throw HttpProblem.business('validation-error', 'The Idempotency-Key header is invalid.');
      const body = CreateFundingRequestBody.safeParse(await readJson(request));
      if (!body.success) {
        throw HttpProblem.business(
          'validation-error',
          body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      const outcome = await deps.create.execute({
        tenantId: principal.tenantId,
        idempotencyKey: header.data['idempotency-key'],
        ...body.data,
      });
      answer(response, outcome, (value) => `/v1/funding-requests/${value.id}`);
      return;
    }

    if (item?.[1] !== undefined) {
      if (method !== 'GET') {
        send(
          response,
          405,
          problemBody({
            type: 'not-found',
            title: 'Method not allowed',
            status: 405,
            detail: 'Use GET.',
          }),
          { Allow: 'GET' },
          PROBLEM_CONTENT_TYPE,
        );
        return;
      }
      const principal = await deps.verifier.authenticate(request.headers.authorization);
      requireScope(principal, 'funding:read');
      const id = item[1];
      if (!UUID.test(id)) throw HttpProblem.business('not-found', 'No such funding request.');
      answer(response, await deps.get.execute(principal.tenantId, id));
      return;
    }

    throw HttpProblem.business('not-found', 'No such resource.');
  };

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof HttpProblem) {
        send(response, error.problem.status, error.problem, error.headers, PROBLEM_CONTENT_TYPE);
        return;
      }
      deps.onError?.(error);
      const internal = HttpProblem.of(
        'internal-error',
        'The server failed to process the request.',
      );
      send(response, 500, internal.problem, {}, PROBLEM_CONTENT_TYPE);
    });
  });
}

export function boundPort(server: Server): number {
  return (server.address() as AddressInfo).port;
}
