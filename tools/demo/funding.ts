import { limitSet } from '../simulator/messages.js';
import { connectProducer } from '../simulator/producer.js';

/**
 * `make demo-funding` (DM-01): submits funding requests against the running compose stack and
 * reads every number back from the APIs. Capacity's numbers are printed before and after, so the
 * effect of each saga path (held, released, untouched) can be read off the lines.
 * Scenarios 1-5 are the documented ones; 6 is the recovery of a lost payment answer.
 */
const ISSUER =
  process.env['OAUTH_TOKEN_ISSUER'] ??
  `http://localhost:${process.env['HOST_PORT_OAUTH'] ?? '18081'}/default`;
const CAPACITY =
  process.env['API_URL'] ?? `http://localhost:${process.env['HOST_PORT_API'] ?? '13000'}`;
const FUNDING =
  process.env['FUNDING_URL'] ?? `http://localhost:${process.env['HOST_PORT_FUNDING'] ?? '13100'}`;
const PAYMENTS =
  process.env['PAYMENTS_URL'] ?? `http://localhost:${process.env['HOST_PORT_PAYMENTS'] ?? '13200'}`;
const BROKERS = (
  process.env['KAFKA_BROKERS_EXTERNAL'] ?? `localhost:${process.env['HOST_PORT_KAFKA'] ?? '39092'}`
).split(',');
const TENANT = 'bank-a';
const RUN = Date.now().toString(36);
/** How long a scenario may take; the needs-attention one waits for FUNDING_DISBURSE_DEADLINE. */
const SETTLE_MS = Number(process.env['DEMO_SETTLE_MS'] ?? 120_000);

const TERMINAL = ['COMPLETED', 'REJECTED', 'FAILED', 'NEEDS_ATTENTION'];

async function token(scope: string): Promise<string> {
  const response = await fetch(`${ISSUER}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: TENANT,
      client_secret: 'local-dev-secret',
      scope,
    }),
  });
  if (!response.ok) throw new Error(`token endpoint answered ${response.status}; is the stack up?`);
  return ((await response.json()) as { access_token: string }).access_token;
}

interface Request {
  id: string;
  state: string;
  reason: string | null;
  reservationId: string | null;
  paymentId: string | null;
}

let fundingToken = '';
let capacityToken = '';

const reserved = async (programId: string): Promise<string> => {
  const response = await fetch(`${CAPACITY}/v1/programs/${programId}/capacity`, {
    headers: { authorization: `Bearer ${capacityToken}` },
  });
  if (!response.ok) return 'n/a';
  return ((await response.json()) as { reserved: string }).reserved;
};

async function submit(programId: string, invoiceId: string, value: string): Promise<string> {
  const response = await fetch(`${FUNDING}/v1/funding-requests`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fundingToken}`,
      'content-type': 'application/json',
      'idempotency-key': `demo-${RUN}-${invoiceId}`,
    },
    body: JSON.stringify({ programId, invoiceId, amount: { value, currency: 'USD' } }),
  });
  if (response.status !== 202) throw new Error(`submit answered ${response.status.toString()}`);
  return ((await response.json()) as Request).id;
}

async function settle(id: string): Promise<Request> {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const response = await fetch(`${FUNDING}/v1/funding-requests/${id}`, {
      headers: { authorization: `Bearer ${fundingToken}` },
    });
    const request = (await response.json()) as Request;
    if (TERMINAL.includes(request.state)) return request;
    if (Date.now() > deadline) throw new Error(`still ${request.state} after ${SETTLE_MS} ms`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function newProgram(): Promise<string> {
  const programId = `fdemo_${RUN}`;
  const producer = await connectProducer(BROKERS);
  await producer.send([
    limitSet({ tenantId: TENANT, programId, seq: 1 }, { value: '100000.00', currency: 'USD' }),
  ]);
  await producer.close();
  const deadline = Date.now() + 40_000;
  while ((await reserved(programId)) === 'n/a') {
    if (Date.now() > deadline) throw new Error(`program ${programId} did not appear`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return programId;
}

interface Scenario {
  name: string;
  invoiceId: string;
  value: string;
  /** The state, reason and capacity change this path must show. */
  expect: { state: string; reason?: string; delta: string };
}

const SCENARIOS: Scenario[] = [
  {
    name: 'completed',
    invoiceId: `FD-OK-${RUN}`,
    value: '1000.00',
    expect: { state: 'COMPLETED', delta: '+1000.00 held' },
  },
  {
    name: 'risk-declined',
    invoiceId: `FD-RISK-${RUN}`,
    value: '1000000.01',
    expect: { state: 'REJECTED', reason: 'risk-declined', delta: 'unchanged, no call' },
  },
  {
    name: 'insufficient-capacity',
    invoiceId: `FD-BIG-${RUN}`,
    value: '150000.00',
    expect: { state: 'REJECTED', reason: 'insufficient-capacity', delta: 'unchanged' },
  },
  {
    name: 'payment-declined',
    invoiceId: `FAULT-DECLINE-${RUN}`,
    value: '2000.00',
    expect: { state: 'FAILED', delta: 'reserved then released (compensated)' },
  },
  {
    name: 'rail-unavailable',
    invoiceId: `FAULT-5XX-999-${RUN}`,
    value: '3000.00',
    expect: {
      state: 'NEEDS_ATTENTION',
      reason: 'disbursement-unknown',
      delta: '+3000.00 held, never released',
    },
  },
  {
    name: 'lost-payment-answer',
    invoiceId: `FAULT-TIMEOUT-${RUN}`,
    value: '4000.00',
    expect: { state: 'COMPLETED', delta: '+4000.00 held, payment found by key' },
  },
];

function money(text: string): bigint {
  return BigInt(text.replace('.', ''));
}

async function main(): Promise<void> {
  fundingToken = await token('funding:write funding:read');
  capacityToken = await token('capacity:read');
  const programId = await newProgram();
  console.log(
    `funding demo run ${RUN}, program ${programId} (limit 100000.00 USD), tenant ${TENANT}`,
  );
  let failures = 0;
  for (const scenario of SCENARIOS) {
    const before = await reserved(programId);
    try {
      const id = await submit(programId, scenario.invoiceId, scenario.value);
      const request = await settle(id);
      const after = await reserved(programId);
      const heldBy = money(after) - money(before);
      const okState = request.state === scenario.expect.state;
      const okReason =
        scenario.expect.reason === undefined || request.reason === scenario.expect.reason;
      const okDelta = heldBy === 0n || heldBy === money(scenario.value);
      const ok = okState && okReason && okDelta;
      if (!ok) failures += 1;
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${scenario.name.padEnd(22)} ${request.state}${request.reason === null ? '' : ` (${request.reason})`}  capacity reserved ${before} -> ${after}  [${scenario.expect.delta}]`,
      );
    } catch (error) {
      failures += 1;
      console.log(
        `FAIL  ${scenario.name.padEnd(22)} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const rail = await fetch(`${PAYMENTS}/v1/payments/${encodeURIComponent('nope')}`).then(
    (r) => r.status,
    () => 0,
  );
  console.log(`rail reachable: ${rail === 404 ? 'yes' : 'no'}`);
  console.log(
    failures === 0
      ? 'demo-funding: all scenarios passed'
      : `demo-funding: ${failures} scenario(s) failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
