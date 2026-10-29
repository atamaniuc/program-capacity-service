import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { KafkaJS } from '@confluentinc/kafka-javascript';

/**
 * Republishes DLQ records to their source topic (PRD §8, step 6). The inbox makes a replay safe,
 * and records are deduplicated here by `messageId`, because a crash between the DLQ publish and
 * the offset commit can park the same message twice (ADR 007).
 */
const { values } = parseArgs({
  options: {
    topic: { type: 'string', default: '' },
    from: { type: 'string', default: '0' },
    brokers: {
      type: 'string',
      default:
        process.env['KAFKA_BROKERS_EXTERNAL'] ??
        `localhost:${process.env['HOST_PORT_KAFKA'] ?? '39092'}`,
    },
    'dry-run': { type: 'boolean', default: false },
  },
});

const DLQS = ['treasury.capacity.v1.dlq', 'treasury.fx-rates.v1.dlq'];
const topics = values.topic === undefined || values.topic === '' ? DLQS : [values.topic];
const from = BigInt(values.from === undefined || values.from === '' ? '0' : values.from);
const brokers = (values.brokers ?? '').split(',');

const kafka = new KafkaJS.Kafka({
  kafkaJS: { brokers, clientId: 'dlq-replay', logLevel: KafkaJS.logLevel.ERROR },
});

function identityOf(value: Buffer | null, key: Buffer | null): string {
  try {
    const parsed = JSON.parse(value?.toString('utf8') ?? '') as { messageId?: unknown };
    if (typeof parsed.messageId === 'string') return `id:${parsed.messageId}`;
  } catch {
    // Not JSON: a poison record still has a stable identity, its bytes.
  }
  return `sha:${createHash('sha256')
    .update(key ?? '')
    .update('\0')
    .update(value ?? '')
    .digest('hex')}`;
}

const text = (header: unknown): string | undefined =>
  Buffer.isBuffer(header)
    ? header.toString('utf8')
    : typeof header === 'string'
      ? header
      : undefined;

async function replay(topic: string): Promise<{ read: number; sent: number; duplicates: number }> {
  const admin = kafka.admin();
  await admin.connect();
  const offsets = await admin.fetchTopicOffsets(topic);
  await admin.disconnect();
  const pending = new Map(
    offsets
      .filter((entry) => BigInt(entry.high) > BigInt(entry.low))
      .map((entry) => [entry.partition, BigInt(entry.high) - 1n]),
  );
  if (pending.size === 0) return { read: 0, sent: 0, duplicates: 0 };

  const records: { key: Buffer | null; value: Buffer | null; target: string }[] = [];
  const seen = new Set<string>();
  let read = 0;
  let duplicates = 0;
  const consumer = kafka.consumer({
    kafkaJS: { groupId: `dlq-replay-${Date.now()}`, fromBeginning: true, autoCommit: false },
  });
  await consumer.connect();
  await consumer.subscribe({ topics: [topic] });
  const finished = new Promise<void>((resolve) => {
    void consumer.run({
      eachMessage: ({ partition, message }) => {
        const offset = BigInt(message.offset);
        if (offset >= from) {
          read += 1;
          const identity = identityOf(message.value, message.key);
          if (seen.has(identity)) duplicates += 1;
          else {
            seen.add(identity);
            records.push({
              key: message.key,
              value: message.value,
              target:
                text(
                  (message.headers as Record<string, unknown> | undefined)?.['x-original-topic'],
                ) ?? topic.replace(/\.dlq$/, ''),
            });
          }
        }
        if (pending.get(partition) === offset) pending.delete(partition);
        if (pending.size === 0) resolve();
        return Promise.resolve();
      },
    });
  });
  await finished;
  await consumer.disconnect();

  if (!values['dry-run'] && records.length > 0) {
    const producer = kafka.producer({ kafkaJS: { acks: -1 } });
    await producer.connect();
    for (const record of records) {
      await producer.send({
        topic: record.target,
        messages: [{ key: record.key, value: record.value }],
      });
    }
    await producer.disconnect();
  }
  return { read, sent: values['dry-run'] ? 0 : records.length, duplicates };
}

for (const topic of topics) {
  const result = await replay(topic);
  console.log(
    `dlq-replay: ${topic} from offset ${from}: read ${result.read}, republished ${result.sent}, ` +
      `dropped ${result.duplicates} duplicate(s) by messageId${values['dry-run'] ? ' (dry run)' : ''}`,
  );
}
process.exit(0);
