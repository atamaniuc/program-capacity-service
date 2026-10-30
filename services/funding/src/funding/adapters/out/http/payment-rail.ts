import { classifyDisburse, type DisburseOutcome, type RailAnswer } from '../../../domain/index.js';
import type { DisburseCall, PaymentRail } from '../../../application/saga-ports.js';

export interface PaymentRailOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

type Lookup = RailAnswer | { readonly kind: 'not-found' };

/**
 * The payment rail over HTTP (ADR 025): `POST /v1/payments` with the step's key. After an
 * unknown attempt the next one first asks `GET /v1/payments/{key}`; a 404 there means the rail
 * never committed, so the POST goes again with the same key.
 */
export class HttpPaymentRail implements PaymentRail {
  constructor(private readonly options: PaymentRailOptions) {}

  async disburse(call: DisburseCall): Promise<DisburseOutcome> {
    if (call.lookupFirst) {
      const known = await this.lookup(call.key);
      if (known.kind !== 'not-found') return classifyDisburse(known);
    }
    return classifyDisburse(await this.post(call));
  }

  private async post(call: DisburseCall): Promise<RailAnswer> {
    try {
      const response = await fetch(`${this.options.baseUrl}/v1/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': call.key },
        // Identical on every attempt: a pure function of the persisted request.
        body: JSON.stringify({
          invoiceId: call.invoiceId,
          amountMinor: call.amount.minor.toString(),
          currency: call.amount.currency,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      return await answerOf(response);
    } catch (error) {
      return transportFailure(error);
    }
  }

  private async lookup(key: string): Promise<Lookup> {
    try {
      const response = await fetch(
        `${this.options.baseUrl}/v1/payments/${encodeURIComponent(key)}`,
        { signal: AbortSignal.timeout(this.options.timeoutMs) },
      );
      if (response.status === 404) return { kind: 'not-found' };
      return await answerOf(response);
    } catch (error) {
      return transportFailure(error);
    }
  }
}

function transportFailure(error: unknown): RailAnswer {
  return error instanceof DOMException && error.name === 'TimeoutError'
    ? { kind: 'timeout' }
    : { kind: 'connection-lost' };
}

async function answerOf(response: Response): Promise<RailAnswer> {
  if (response.status >= 500) return { kind: 'server-error' };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'unparseable' };
  }
  if (typeof body !== 'object' || body === null) return { kind: 'unparseable' };
  const { status, paymentId } = body as { status?: unknown; paymentId?: unknown };
  // 201/200 PAID and 422 DECLINED carry the payment; anything else (400, 409) is not an answer
  // about this payment and stays unknown, never a guess in either direction.
  if (status === 'PAID' && typeof paymentId === 'string' && response.status < 300) {
    return { kind: 'paid', paymentId };
  }
  if (status === 'DECLINED') return { kind: 'declined' };
  return { kind: 'unparseable' };
}
