/**
 * QA helper for tools/qa/run.sh: publishes treasury messages described as JSON (argv[2]) through
 * the simulator's builders, so every message is exactly what treasury would send. Kinds:
 *   {"kind":"limit","tenant":"bank-a","program":"p","seq":1,"limit":"100.00","currency":"USD","status":"SUSPENDED"}
 *   {"kind":"repay","tenant":"bank-a","program":"p","seq":2,"invoice":"INV","ref":"r1","amount":"1.00","currency":"USD"}
 *   {"kind":"snapshot","tenant":"bank-a","program":"p","seq":3,"limit":"100.00","currency":"USD","watermark":5,
 *    "rows":[{"invoice":"INV","invoice_value":"1.00","invoice_currency":"USD","reserved_value":"1.00"}]}
 *   {"kind":"fx","base":"EUR","quote":"USD","rate":"1.1000000000","ageHours":0}
 *   {"kind":"raw","topic":"treasury.capacity.v1","key":"k","value":"{...}"}
 */
import { connectProducer } from '../simulator/producer.js';
import {
  fxRate,
  limitSet,
  repayment,
  snapshot,
  type ProducedMessage,
} from '../simulator/messages.js';

interface Envelope {
  readonly tenant: string;
  readonly program: string;
  readonly seq: number;
  readonly messageId?: string;
}

interface SnapshotRow {
  readonly invoice: string;
  readonly invoice_value: string;
  readonly invoice_currency: string;
  readonly reserved_value: string;
}

type Spec =
  | (Envelope & {
      kind: 'limit';
      limit: string;
      currency: string;
      status?: 'ACTIVE' | 'SUSPENDED';
    })
  | (Envelope & {
      kind: 'repay';
      invoice: string;
      ref: string;
      amount: string;
      currency: string;
    })
  | (Envelope & {
      kind: 'snapshot';
      limit: string;
      currency: string;
      watermark?: number;
      asOfOffsetSec?: number;
      rows?: SnapshotRow[];
    })
  | { kind: 'fx'; base: string; quote: string; rate: string; ageHours?: number }
  | { kind: 'raw'; topic: string; key: string; value: string };

function build(spec: Spec): ProducedMessage {
  switch (spec.kind) {
    case 'fx':
      return fxRate({
        base: spec.base,
        quote: spec.quote,
        rate: spec.rate,
        asOf: new Date(Date.now() - (spec.ageHours ?? 0) * 3600 * 1000),
      });
    case 'raw':
      return { topic: spec.topic, key: spec.key, value: spec.value };
    default:
      break;
  }
  const env = {
    tenantId: spec.tenant,
    programId: spec.program,
    seq: spec.seq,
    ...(spec.messageId === undefined ? {} : { messageId: spec.messageId }),
  };
  switch (spec.kind) {
    case 'limit':
      return limitSet(env, { value: spec.limit, currency: spec.currency }, spec.status);
    case 'repay':
      return repayment(env, {
        invoiceId: spec.invoice,
        releaseRef: spec.ref,
        amount: { value: spec.amount, currency: spec.currency },
      });
    case 'snapshot':
      return snapshot(env, {
        asOf: new Date(Date.now() + (spec.asOfOffsetSec ?? 0) * 1000),
        creditLimit: { value: spec.limit, currency: spec.currency },
        ...(spec.watermark === undefined ? {} : { platformWatermark: spec.watermark }),
        reservations: (spec.rows ?? []).map((row) => ({
          invoiceId: row.invoice,
          outstandingInvoiceAmount: { value: row.invoice_value, currency: row.invoice_currency },
          outstandingReservedAmount: { value: row.reserved_value, currency: spec.currency },
        })),
      });
  }
}

const specs = JSON.parse(process.argv[2] ?? '[]') as Spec[];
const producer = await connectProducer([`localhost:${process.env['HOST_PORT_KAFKA'] ?? '39092'}`]);
await producer.send(specs.map(build));
await producer.close();
console.log(`published ${specs.length}`);
