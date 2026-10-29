import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { renderAsyncApi, renderJsonSchemas } from './contracts.js';
import { connectProducer } from './producer.js';
import { buildScenario, defaultContext, SCENARIO_NAMES, type ScenarioName } from './scenarios.js';

const ROOT = resolve(import.meta.dirname, '../..');

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    brokers: {
      type: 'string',
      default:
        process.env['KAFKA_BROKERS_EXTERNAL'] ??
        `localhost:${process.env['HOST_PORT_KAFKA'] ?? '39092'}`,
    },
    tenant: { type: 'string', default: 'bank-a' },
    program: { type: 'string', default: 'prg_demo' },
    currency: { type: 'string', default: 'USD' },
    seq: { type: 'string' },
    'new-limit': { type: 'string' },
    invoice: { type: 'string' },
    amount: { type: 'string' },
    print: { type: 'boolean', default: false },
  },
});

const command = positionals[0];

if (command === 'export-contracts') {
  for (const [name, content] of renderJsonSchemas()) {
    const path = resolve(ROOT, 'contracts/json-schema', name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await writeFile(resolve(ROOT, 'contracts/asyncapi.yaml'), renderAsyncApi());
  console.log('simulate: wrote contracts/json-schema/*.schema.json and contracts/asyncapi.yaml');
} else if (command !== undefined && (SCENARIO_NAMES as readonly string[]).includes(command)) {
  const overrides = {
    tenantId: values.tenant,
    programId: values.program,
    currency: values.currency,
    ...(values.seq === undefined ? {} : { seq: Number.parseInt(values.seq, 10) }),
    ...(values['new-limit'] === undefined ? {} : { newLimit: values['new-limit'] }),
    ...(values.invoice === undefined ? {} : { invoiceId: values.invoice }),
    ...(values.amount === undefined
      ? {}
      : { invoiceAmount: { value: values.amount, currency: values.currency ?? 'USD' } }),
  };
  const messages = buildScenario(command as ScenarioName, defaultContext(overrides));
  if (values.print) {
    for (const message of messages) console.log(`${message.topic} ${message.key} ${message.value}`);
  } else {
    const producer = await connectProducer((values.brokers ?? '').split(','));
    await producer.send(messages);
    await producer.close();
    console.log(`simulate: ${command} published ${messages.length} message(s)`);
  }
} else {
  console.error(
    `usage: npm run simulate -- <${[...SCENARIO_NAMES, 'export-contracts'].join('|')}> [--tenant bank-a] [--program prg_demo] [--seq N] [--print]`,
  );
  process.exit(1);
}
