import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const MAX_BATCH = 50;
const MAX_BODY_BYTES = 64 * 1024;

const buyerNames = {
  prg_grand_usd: 'Grand Trading Company',
  prg_apex_usd: 'Apex Manufacturing',
};
const enrich = {
  invoice: (id) => ({ id, description: 'Early supplier payment', dueInDays: 30 }),
  buyer: (id) => ({
    id,
    name: Object.hasOwn(buyerNames, id) ? buyerNames[id] : 'Demo buyer',
    region: 'Europe',
  }),
};

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readIds(request) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(chunk);
    }
    const ids = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.ids;
    if (!Array.isArray(ids) || ids.length > MAX_BATCH) return null;
    return ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)
      ? ids
      : null;
  } catch {
    return null;
  }
}

export function createEnrichmentServer(kind) {
  if (!Object.hasOwn(enrich, kind)) throw new Error('MOCK_KIND must be invoice or buyer.');
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health/live') {
      return send(response, 200, { status: 'up' });
    }
    if (request.method !== 'POST' || request.url !== '/v1/batch') {
      return send(response, 404, { message: 'Not found' });
    }
    const ids = await readIds(request);
    if (ids === null) return send(response, 400, { message: 'Expected at most 50 IDs' });
    const records = [...new Set(ids)].map((key) => ({ key, value: enrich[kind](key) }));
    return send(response, 200, { records });
  });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createEnrichmentServer(process.env.MOCK_KIND);
  server.listen(Number(process.env.PORT ?? 3300), '0.0.0.0');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
