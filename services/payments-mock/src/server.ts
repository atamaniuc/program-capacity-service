import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseRequest, Rail, type Payment } from './rail.js';

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': type });
  res.end(JSON.stringify(body));
}

function problem(res: ServerResponse, status: number, title: string): void {
  send(res, status, { type: 'about:blank', title, status }, 'application/problem+json');
}

function view(payment: Payment): Payment {
  return payment;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

export function createApiServer(rail: Rail): Server {
  return createServer((req, res) => {
    void handle(rail, req, res);
  });
}

async function handle(rail: Rail, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/v1/payments') {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key === '') return problem(res, 400, 'Idempotency-Key required');
    const request = parseRequest(await readJson(req));
    if (request === undefined) return problem(res, 400, 'Invalid payment request');
    const outcome = rail.post(key, request);
    switch (outcome.kind) {
      case 'created':
        return send(res, outcome.payment.status === 'PAID' ? 201 : 422, view(outcome.payment));
      case 'replayed':
        return send(res, outcome.payment.status === 'PAID' ? 200 : 422, view(outcome.payment));
      case 'conflict':
        return problem(res, 409, 'Idempotency-Key reused with a different request');
      case 'unavailable':
        return problem(res, 503, 'Rail unavailable');
      case 'committed-no-reply':
        return; // committed, never answered: the caller times out and asks again
    }
  }
  const match = /^\/v1\/payments\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && match?.[1] !== undefined) {
    const payment = rail.get(decodeURIComponent(match[1]));
    return payment === undefined
      ? problem(res, 404, 'Payment not found')
      : send(res, 200, view(payment));
  }
  return problem(res, 404, 'Not found');
}

export function createOpsServer(): Server {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health/live') return send(res, 200, { status: 'up' });
    return problem(res, 404, 'Not found');
  });
}

export function listen(server: Server, port: number, host = '0.0.0.0'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}
