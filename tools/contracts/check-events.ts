import { parseArgs } from 'node:util';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { CAPACITY_EVENTS, type ContractMessage } from '#src/platform/contracts/asyncapi.js';
import { CAPACITY_EVENTS_TOPIC } from '#src/capacity/application/shared/capacity-events.js';
import { contractValidators } from './validators.js';

/**
 * Reads capacity.events.v1 from the beginning on a running broker and checks every record (or
 * only those with `--key tenant:program`) against the committed contract: payload schemas
 * (open and strict), the header schema, header/envelope agreement and a gap-free seq per key.
 * Exit code 1 on any violation. Used by `make qa` (QA-72).
 */

const { values } = parseArgs({
  options: {
    brokers: { type: 'string', default:
        process.env['KAFKA_BROKERS_EXTERNAL'] ?? `localhost:${process.env['HOST_PORT_KAFKA'] ?? '39092'}`,
      },
    key: { type: 'string' },
    'timeout-ms': { type: 'string', default: '60000' },
  },
});

interface Envelope {
  readonly messageId?: unknown;
  readonly type?: unknown;
  readonly seq?: unknown;
  readonly tenantId?: unknown;
  readonly programId?: unknown;
  readonly payload?: { readonly programSeq?: unknown };
}

const validators = await contractValidators();
const problems: string[] = [];
const seqsByKey = new Map<string, Set<number>>();
const types = new Map<string, number>();
let checked = 0;

const kafka = new KafkaJS.Kafka({
  kafkaJS: {
    brokers: (values.brokers ?? '').split(','),
    clientId: 'contract-check',
    logLevel: KafkaJS.logLevel.ERROR,
  },
});
// Read up to the end of the topic as it is now: the high watermark of every partition.
const admin = kafka.admin();
await admin.connect();
const end = new Map(
  (await admin.fetchTopicOffsets(CAPACITY_EVENTS_TOPIC)).map((entry) => [
    entry.partition,
    BigInt(entry.high),
  ]),
);
await admin.disconnect();
const next = new Map<number, bigint>();
const caughtUp = () =>
  [...end].every(([partition, high]) => (next.get(partition) ?? 0n) >= high);

const consumer = kafka.consumer({
  kafkaJS: { groupId: `contract-check-${Date.now()}`, fromBeginning: true },
});
await consumer.connect();
await consumer.subscribe({ topic: CAPACITY_EVENTS_TOPIC });
await consumer.run({
  eachMessage: ({ message, partition }) => {
    next.set(partition, BigInt(message.offset) + 1n);
    const key = message.key?.toString() ?? '';
    if (values.key !== undefined && key !== values.key) return Promise.resolve();
    checked += 1;
    const where = `partition ${partition} offset ${message.offset} key ${key}`;
    let value: Envelope;
    try {
      value = JSON.parse(String(message.value)) as Envelope;
    } catch {
      problems.push(`${where}: value is not JSON`);
      return Promise.resolve();
    }
    const type = String(value.type);
    types.set(type, (types.get(type) ?? 0) + 1);
    if (!CAPACITY_EVENTS.includes(type as ContractMessage)) {
      problems.push(`${where}: unknown type ${type}`);
      return Promise.resolve();
    }
    for (const [label, validate] of [
      ['schema', validators.committed.get(type as ContractMessage)],
      ['strict schema', validators.strict.get(type as ContractMessage)],
    ] as const) {
      if (validate !== undefined && !validate(value)) {
        problems.push(`${where} ${type}: ${label}: ${validators.errors(validate)}`);
      }
    }
    const headers = Object.fromEntries(
      Object.entries(message.headers ?? {}).map(([name, header]) => [name, String(header)]),
    );
    if (!validators.eventHeaders(headers)) {
      problems.push(`${where} ${type}: headers: ${validators.errors(validators.eventHeaders)}`);
    }
    const agree: [string, unknown, unknown][] = [
      ['key', key, `${String(value.tenantId)}:${String(value.programId)}`],
      ['event-id', headers['event-id'], value.messageId],
      ['event-type', headers['event-type'], type],
      ['program-seq', headers['program-seq'], String(value.seq)],
      ['payload.programSeq', value.payload?.programSeq, value.seq],
    ];
    for (const [label, actual, expected] of agree) {
      if (actual !== expected) {
        problems.push(`${where} ${type}: ${label} ${String(actual)} != ${String(expected)}`);
      }
    }
    if (typeof value.seq === 'number') {
      const seqs = seqsByKey.get(key) ?? new Set<number>();
      seqs.add(value.seq);
      seqsByKey.set(key, seqs);
    }
    return Promise.resolve();
  },
});

const deadline = Date.now() + Number.parseInt(values['timeout-ms'] ?? '60000', 10);
while (!caughtUp() && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!caughtUp()) problems.push(`did not reach the end of ${CAPACITY_EVENTS_TOPIC} in time`);
await consumer.disconnect();

// At-least-once may repeat a seq; it must never skip one.
for (const [key, seqs] of seqsByKey) {
  const max = Math.max(...seqs);
  if (seqs.size !== max || !seqs.has(1)) problems.push(`key ${key}: seq has gaps (1..${max}, ${seqs.size} distinct)`);
}

const summary = [...types].map(([type, count]) => `${type}=${count}`).join(' ');
console.log(
  `contract-check: ${checked} event(s) on ${CAPACITY_EVENTS_TOPIC}${values.key === undefined ? '' : ` with key ${values.key}`}, ${seqsByKey.size} program(s); ${summary}; violations=${problems.length}`,
);
for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
process.exit(problems.length === 0 && checked > 0 ? 0 : 1);
