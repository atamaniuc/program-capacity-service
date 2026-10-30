import { randomUUID } from 'node:crypto';

/**
 * Fault markers are read from the invoice id, so a test or a demo picks the rail's behaviour
 * without any side channel:
 *   FAULT-DECLINE...   the rail refuses; nothing moves (422, stored under the key)
 *   FAULT-TIMEOUT...   the payment is committed, then the response is never sent
 *   FAULT-5XX-<n>...   the first n attempts under a key answer 503 with nothing committed
 */
export type Fault =
  | { readonly kind: 'none' }
  | { readonly kind: 'decline' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'fail'; readonly times: number };

export function faultOf(invoiceId: string): Fault {
  if (invoiceId.startsWith('FAULT-DECLINE')) return { kind: 'decline' };
  if (invoiceId.startsWith('FAULT-TIMEOUT')) return { kind: 'timeout' };
  const failing = /^FAULT-5XX-(\d{1,3})/.exec(invoiceId);
  if (failing?.[1] !== undefined) return { kind: 'fail', times: Number(failing[1]) };
  return { kind: 'none' };
}

export interface PaymentRequest {
  readonly invoiceId: string;
  readonly amountMinor: string;
  readonly currency: string;
}

export interface Payment extends PaymentRequest {
  readonly paymentId: string;
  readonly status: 'PAID' | 'DECLINED';
}

export type PostOutcome =
  | { readonly kind: 'created'; readonly payment: Payment }
  | { readonly kind: 'replayed'; readonly payment: Payment }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'unavailable'; readonly attempt: number }
  | { readonly kind: 'committed-no-reply'; readonly payment: Payment };

interface Stored {
  readonly request: PaymentRequest;
  readonly payment: Payment;
}

/** In-memory payment rail: one stored result per idempotency key, no database. */
export class Rail {
  private readonly stored = new Map<string, Stored>();
  private readonly failures = new Map<string, number>();

  post(key: string, request: PaymentRequest): PostOutcome {
    const known = this.stored.get(key);
    if (known !== undefined) {
      return sameRequest(known.request, request)
        ? { kind: 'replayed', payment: known.payment }
        : { kind: 'conflict' };
    }
    const fault = faultOf(request.invoiceId);
    if (fault.kind === 'fail') {
      const attempt = (this.failures.get(key) ?? 0) + 1;
      if (attempt <= fault.times) {
        this.failures.set(key, attempt);
        return { kind: 'unavailable', attempt };
      }
    }
    const payment: Payment = {
      ...request,
      paymentId: randomUUID(),
      status: fault.kind === 'decline' ? 'DECLINED' : 'PAID',
    };
    this.stored.set(key, { request, payment });
    return fault.kind === 'timeout'
      ? { kind: 'committed-no-reply', payment }
      : { kind: 'created', payment };
  }

  get(key: string): Payment | undefined {
    return this.stored.get(key)?.payment;
  }
}

function sameRequest(a: PaymentRequest, b: PaymentRequest): boolean {
  return (
    a.invoiceId === b.invoiceId && a.amountMinor === b.amountMinor && a.currency === b.currency
  );
}

export function parseRequest(body: unknown): PaymentRequest | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { invoiceId, amountMinor, currency } = body as Record<string, unknown>;
  if (typeof invoiceId !== 'string' || invoiceId === '') return undefined;
  if (typeof amountMinor !== 'string' || !/^[1-9]\d*$/.test(amountMinor)) return undefined;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return undefined;
  return { invoiceId, amountMinor, currency };
}
