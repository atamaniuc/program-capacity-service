import { KafkaJS } from '@confluentinc/kafka-javascript';
import { TOPIC_CAPACITY } from '../../src/capacity/application/shared/treasury-messages.js';
import { fxRate, limitSet } from '../simulator/messages.js';
import { connectProducer, type SimulatorProducer } from '../simulator/producer.js';
import { buildScenario, defaultContext, type ScenarioName } from '../simulator/scenarios.js';

/**
 * `make demo`: plays every simulator scenario against the running compose stack. Treasury input
 * goes through Kafka, platform calls through the REST API with a mock-OAuth2 token, and every
 * line below is read back from the API, never from the database.
 */
const API = process.env['API_URL'] ?? `http://localhost:${process.env['HOST_PORT_API'] ?? '13000'}`;
const ISSUER =
  process.env['OAUTH_TOKEN_ISSUER'] ??
  `http://localhost:${process.env['HOST_PORT_OAUTH'] ?? '18081'}/default`;
const BROKERS = (
  process.env['KAFKA_BROKERS_EXTERNAL'] ?? `localhost:${process.env['HOST_PORT_KAFKA'] ?? '39092'}`
).split(',');
const TENANT = 'bank-a';
const RUN = Date.now().toString(36);

interface Capacity {
  limit: string;
  reserved: string;
  available: string;
  overLimitBy: string;
  version: number;
  treasurySeq: number;
}

let token = '';
let producer: SimulatorProducer;

async function fetchToken(): Promise<string> {
  const response = await fetch(`${ISSUER}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: TENANT,
      client_secret: 'local-dev-secret',
      scope: 'capacity:read capacity:write',
      audience: 'capacity-service',
    }),
  });
  if (!response.ok) throw new Error(`token endpoint answered ${response.status}; is the stack up?`);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? null : (JSON.parse(text) as Record<string, unknown>),
  };
}

const capacityOf = async (programId: string): Promise<Capacity | null> => {
  const { status, body } = await call('GET', `/v1/programs/${programId}/capacity`);
  return status === 200 ? (body as unknown as Capacity) : null;
};

async function waitFor<T>(probe: () => Promise<T | null | false>, what: string): Promise<T> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 2_500));

async function reserve(programId: string, invoiceId: string, value: string, currency = 'USD') {
  return call('POST', `/v1/programs/${programId}/reservations`, {
    invoiceId,
    amount: { value, currency },
  });
}

/** A fresh USD program created the way production creates one: by a treasury message. */
async function newProgram(name: string, limit = '10000000.00', currency = 'USD') {
  const programId = `demo_${name}_${RUN}`;
  await producer.send([
    limitSet({ tenantId: TENANT, programId, seq: 1 }, { value: limit, currency }),
    fxRate(
      { base: 'EUR', quote: 'USD', rate: '1.0800000000', asOf: new Date() },
      {
        messageId: `demo-fx-${RUN}-${name}`,
      },
    ),
  ]);
  await waitFor(() => capacityOf(programId), `program ${programId}`);
  return programId;
}

const context = (programId: string, overrides = {}) =>
  defaultContext({ tenantId: TENANT, programId, seq: 2, ...overrides });

type Scenario = (programId: string) => Promise<string>;

const SCENARIOS: Record<ScenarioName, { setup?: string; run: Scenario }> = {
  'limit-cut': {
    run: async (programId) => {
      const first = await reserve(programId, 'INV-1', '2000000.00');
      await reserve(programId, 'INV-2', '1620000.00');
      await producer.send(buildScenario('limit-cut', context(programId)));
      const cut = await waitFor(async () => {
        const c = await capacityOf(programId);
        return c?.limit === '3000000.00' ? c : null;
      }, 'the limit cut');
      const refused = await reserve(programId, 'INV-3', '1.00');
      const released = await call(
        'POST',
        `/v1/programs/${programId}/reservations/${String(first.body?.['reservationId'])}/releases`,
        { releaseRef: 'demo-cut-release', reason: 'CANCELLED' },
      );
      const ok =
        cut.available === '0.00' &&
        cut.overLimitBy === '620000.00' &&
        String(refused.body?.['type']).endsWith('program-over-limit') &&
        released.status === 200;
      return `${ok ? 'PASS' : 'FAIL'}|reserved ${cut.reserved}, available ${cut.available}, overLimitBy ${cut.overLimitBy}; new reservation ${refused.status}; release ${released.status}`;
    },
  },

  repayments: {
    run: async (programId) => {
      await reserve(programId, 'INV-DEMO-1', '100000.00', 'EUR');
      const before = await capacityOf(programId);
      await producer.send(
        buildScenario(
          'repayments',
          context(programId, {
            invoiceId: 'INV-DEMO-1',
            invoiceAmount: { value: '100000.00', currency: 'EUR' },
          }),
        ),
      );
      const after = await waitFor(async () => {
        const c = await capacityOf(programId);
        return c?.reserved === '0.00' ? c : null;
      }, 'both repayments');
      const ok = before?.reserved === '108000.00' && after.treasurySeq === 3;
      return `${ok ? 'PASS' : 'FAIL'}|EUR 100,000.00 reserved ${before?.reserved} USD, two repayments free it: reserved ${after.reserved}`;
    },
  },

  'late-snapshot': {
    run: async (programId) => {
      await reserve(programId, 'INV-A', '100000.00');
      await reserve(programId, 'INV-B', '50000.00');
      await producer.send(
        buildScenario(
          'late-snapshot',
          context(programId, {
            platformWatermark: 1,
            currency: 'USD',
            known: [
              {
                invoiceId: 'INV-A',
                outstandingInvoiceAmount: { value: '100000.00', currency: 'USD' },
                outstandingReservedAmount: { value: '100000.00', currency: 'USD' },
              },
            ],
          }),
        ),
      );
      const c = await waitFor(async () => {
        const state = await capacityOf(programId);
        return state !== null && state.treasurySeq >= 2 ? state : null;
      }, 'the snapshot');
      const ok = c.reserved === '150000.00';
      return `${ok ? 'PASS' : 'FAIL'}|snapshot (watermark 1) omits INV-B created by platform event 2: reserved stays ${c.reserved}`;
    },
  },

  'duplicate-delivery': {
    run: async (programId) => {
      await producer.send(
        buildScenario('duplicate-delivery', context(programId, { newLimit: '4000000.00' })),
      );
      const first = await waitFor(async () => {
        const c = await capacityOf(programId);
        return c?.limit === '4000000.00' ? c : null;
      }, 'the limit change');
      await settle();
      const later = await capacityOf(programId);
      const ok = later?.version === first.version && first.version === 2;
      return `${ok ? 'PASS' : 'FAIL'}|same message delivered twice: limit ${later?.limit}, version ${later?.version} (one effect)`;
    },
  },

  'out-of-order': {
    run: async (programId) => {
      await producer.send(
        buildScenario('out-of-order', context(programId, { newLimit: '3000000.00' })),
      );
      await waitFor(
        async () => ((await capacityOf(programId))?.treasurySeq === 3 ? true : null),
        'seq 3',
      );
      await settle();
      const c = await capacityOf(programId);
      const ok = c?.limit === '3000000.00' && c.treasurySeq === 3 && c.version === 2;
      return `${ok ? 'PASS' : 'FAIL'}|seq 3 then seq 2: limit ${c?.limit}, treasurySeq ${c?.treasurySeq} (late message skipped)`;
    },
  },

  'poison-message': {
    run: async (programId) => {
      await producer.send(
        buildScenario('poison-message', context(programId, { newLimit: '2500000.00' })),
      );
      const c = await waitFor(async () => {
        const state = await capacityOf(programId);
        return state?.limit === '2500000.00' ? state : null;
      }, 'the good message behind the poison');
      const parked = await readDlq(`${TENANT}:${programId}`);
      const ok = parked.length >= 2;
      return `${ok ? 'PASS' : 'FAIL'}|2 poison records parked in ${TOPIC_CAPACITY}.dlq (${parked.join(', ')}); the next message applied: limit ${c.limit}`;
    },
  },

  'fx-stale': {
    setup: 'KWD',
    run: async (programId) => {
      await producer.send(
        buildScenario(
          'fx-stale',
          context(programId, { currency: 'KWD', fxPair: { base: 'GBP', quote: 'KWD' } }),
        ),
      );
      await settle();
      const refused = await reserve(programId, 'INV-GBP', '1000.00', 'GBP');
      const c = await capacityOf(programId);
      const ok =
        refused.status === 422 &&
        String(refused.body?.['type']).endsWith('fx-rate-unavailable') &&
        c?.reserved === '0.000';
      return `${ok ? 'PASS' : 'FAIL'}|GBP/KWD rate is 3 days old: reservation ${refused.status} fx-rate-unavailable, reserved ${c?.reserved}`;
    },
  },
};

/** Error codes of the records parked for one key, newest topic content from the start. */
async function readDlq(key: string): Promise<string[]> {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: BROKERS, logLevel: KafkaJS.logLevel.ERROR },
  });
  const consumer = kafka.consumer({
    kafkaJS: { groupId: `demo-dlq-${RUN}-${Date.now()}`, fromBeginning: true, autoCommit: false },
  });
  const codes: string[] = [];
  await consumer.connect();
  await consumer.subscribe({ topics: [`${TOPIC_CAPACITY}.dlq`] });
  await consumer.run({
    eachMessage: ({ message }) => {
      if (message.key?.toString() === key) {
        codes.push(String((message.headers as Record<string, Buffer>)['x-error-code']));
      }
      return Promise.resolve();
    },
  });
  const deadline = Date.now() + 15_000;
  while (codes.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  await consumer.disconnect();
  return codes;
}

async function main(): Promise<void> {
  token = await fetchToken();
  producer = await connectProducer(BROKERS);
  let failures = 0;
  console.log(`demo run ${RUN} against ${API}, tenant ${TENANT}`);
  for (const [name, scenario] of Object.entries(SCENARIOS) as [
    ScenarioName,
    (typeof SCENARIOS)[ScenarioName],
  ][]) {
    try {
      const programId =
        scenario.setup === 'KWD'
          ? await newProgram(name, '1000000.000', 'KWD')
          : await newProgram(name);
      const [verdict, detail] = (await scenario.run(programId)).split('|');
      if (verdict !== 'PASS') failures += 1;
      console.log(`${verdict}  ${name.padEnd(18)} ${detail ?? ''}`);
    } catch (error) {
      failures += 1;
      console.log(
        `FAIL  ${name.padEnd(18)} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await producer.close();
  console.log(
    failures === 0 ? 'demo: all scenarios passed' : `demo: ${failures} scenario(s) failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
