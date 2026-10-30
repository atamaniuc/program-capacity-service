import { createApiServer, createOpsServer, listen } from './server.js';
import { Rail } from './rail.js';

const apiPort = Number(process.env['PAYMENTS_PORT'] ?? 3200);
const opsPort = Number(process.env['PAYMENTS_OPS_PORT'] ?? 9466);

const api = createApiServer(new Rail());
const ops = createOpsServer();
await listen(api, apiPort);
await listen(ops, opsPort);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    api.close();
    ops.close();
    api.closeAllConnections();
  });
}
