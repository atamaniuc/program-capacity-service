import { readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';

const port = Number(process.env.PORT ?? 8080);
const fundingUrl = process.env.FUNDING_URL ?? 'http://funding-api:3100';
const demoTokenEnabled = process.env.DEMO_TOKEN_ENABLED === 'true';
const allowedOrigins = (
  process.env.DEMO_UI_ORIGINS ?? 'http://localhost:13300,http://127.0.0.1:13300'
)
  .split(',')
  .map((value) => new URL(value.trim()));
const assetPaths = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/operations.mjs': ['operations.mjs', 'application/javascript; charset=utf-8'],
};
const assets = new Map(
  await Promise.all(
    Object.entries(assetPaths).map(async ([path, [file, type]]) => [
      path,
      { body: await readFile(new URL(file, import.meta.url)), type },
    ]),
  ),
);

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function failure(res, status, message) {
  send(res, status, JSON.stringify({ errors: [{ message }] }));
}

function requestDemoToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: 'bank-a',
    client_secret: 'local-dev-secret',
    scope: 'funding:read funding:write',
  }).toString();
  return new Promise((resolve, reject) => {
    // Mock OAuth derives the issuer from Host. Fetch uses the upstream URL's authority.
    const upstream = request(
      process.env.DEMO_TOKEN_URL ?? 'http://oauth:8080/default/token',
      {
        method: 'POST',
        headers: {
          host: process.env.DEMO_TOKEN_HOST ?? 'localhost:18081',
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
        },
        signal: AbortSignal.timeout(5000),
      },
      resolve,
    );
    upstream.once('error', reject);
    upstream.end(body);
  });
}

async function readBody(req) {
  const limit = 32 * 1024;
  if (Number(req.headers['content-length']) > limit) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handle(req, res) {
  if (req.method === 'GET' && req.url === '/health/live') {
    return send(res, 200, '{"status":"up"}');
  }
  const browserOrigin = allowedOrigins.find((url) => url.host === req.headers.host);
  if (!browserOrigin || (req.headers.origin && req.headers.origin !== browserOrigin.origin)) {
    return failure(res, 403, 'Origin not allowed');
  }

  const path = new URL(req.url, browserOrigin).pathname;
  const asset = assets.get(path);
  if (req.method === 'GET' && asset) return send(res, 200, asset.body, asset.type);
  if (req.method === 'GET' && path === '/favicon.ico') return send(res, 204, '');
  if (req.method === 'POST' && path === '/graphql') {
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      return failure(res, 415, 'Use application/json');
    }
    const body = await readBody(req);
    if (body === null) return failure(res, 413, 'GraphQL request exceeds 32 KiB');
    const headers = { 'content-type': 'application/json' };
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    const upstream = await fetch(new URL('/graphql', fundingUrl), {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    return send(res, upstream.status, await upstream.text());
  }
  if (req.method === 'POST' && path === '/demo/token' && demoTokenEnabled) {
    if (req.headers.origin !== browserOrigin.origin) {
      return failure(res, 403, 'Origin required');
    }
    const response = await requestDemoToken();
    const tokenBody = await readBody(response);
    if (response.statusCode !== 200 || tokenBody === null) {
      return failure(res, 502, 'Demo OAuth is unavailable');
    }
    const { access_token: token } = JSON.parse(tokenBody.toString('utf8'));
    if (typeof token !== 'string') return failure(res, 502, 'Demo OAuth returned no token');
    return send(res, 200, JSON.stringify({ access_token: token }));
  }
  return failure(res, 404, 'Not found');
}

createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) failure(res, 502, 'Upstream unavailable');
  });
}).listen(port, '0.0.0.0');
