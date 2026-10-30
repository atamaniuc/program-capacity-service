import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSystemStack, type SystemStack } from '../support/system-stack.js';

let stack: SystemStack;

beforeAll(async () => {
  // A short call deadline: FS-07 loses an answer and must not wait the production 21 s for it.
  stack = await startSystemStack({ grpcDeadlineMs: 3_000 });
  await stack.seedProgram({
    tenantId: 'bank-a',
    id: 'prg_sys',
    currency: 'USD',
    limitMinor: 10_000_000_00n,
  });
}, 600_000);

afterAll(async () => {
  await stack?.close();
}, 120_000);

describe('saga against the real capacity image and the payments mock', () => {
  it('FS-03 a funding request reaches COMPLETED; capacity holds one reservation by funding-service; the rail holds one payment', async () => {
    const id = await stack.submit({
      tenantId: 'bank-a',
      programId: 'prg_sys',
      invoiceId: 'inv-sys-1',
      value: '1250.50',
    });
    await stack.drain(stack.driver());

    const [row] = await stack.funding('SELECT * FROM funding_request WHERE id = $1', [id]);
    expect(row?.['state']).toBe('COMPLETED');

    const reservations = await stack.capacity(
      `SELECT id::text, amount_minor::text, status FROM reservation WHERE tenant_id = 'bank-a' AND invoice_id = 'inv-sys-1'`,
    );
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.['id']).toBe(row?.['reservation_id']);
    expect(reservations[0]?.['amount_minor']).toBe('125050');
    const ledger = await stack.capacity(
      `SELECT kind, actor, delta_reserved_minor::text FROM ledger_entry WHERE reservation_id = $1::uuid ORDER BY id`,
      [reservations[0]?.['id']],
    );
    expect(ledger).toEqual([
      { kind: 'RESERVE', actor: 'funding-service.bank-a', delta_reserved_minor: '125050' },
    ]);
    const [program] = await stack.capacity(
      `SELECT reserved_minor::text FROM program WHERE tenant_id = 'bank-a' AND id = 'prg_sys'`,
    );
    expect(program?.['reserved_minor']).toBe('125050');

    const payment = await fetch(
      `${stack.paymentsUrl}/v1/payments/${encodeURIComponent(`funding:${id}:disburse`)}`,
    );
    expect(payment.status).toBe(200);
    expect(await payment.json()).toMatchObject({
      status: 'PAID',
      invoiceId: 'inv-sys-1',
      amountMinor: '125050',
    });
    expect(row?.['payment_id']).toBeTruthy();

    const outbox = await stack.funding(
      'SELECT type FROM outbox_event WHERE request_id = $1 ORDER BY created_at, id',
      [id],
    );
    expect(outbox.map((o) => o['type'])).toEqual([
      'FundingRequestReceived',
      'FundingRequestCompleted',
    ]);
  }, 120_000);

  it('FS-02 the mock mints aud funding-service for a funding API client, capacity for the rest (review M1)', async () => {
    const api = await stack.mint({
      client_id: 'bank-a',
      client_secret: 's',
      scope: 'funding:write funding:read',
    });
    expect([api['aud']].flat()).toEqual(['funding-service']);
    expect(api['tenant_id']).toBe('bank-a');
    expect(api['scope']).toBe('funding:write funding:read');
    const plain = await stack.mint({
      client_id: 'bank-a',
      client_secret: 's',
      scope: 'capacity:read',
    });
    expect([plain['aud']].flat()).toEqual(['capacity-service']);
  }, 60_000);

  it('FS-03 the per-tenant capacity client carries the tenant_id claim only when the form sends it (review m4)', async () => {
    const withTenant = await stack.mint({
      client_id: 'funding-service.bank-a',
      client_secret: 's',
      scope: 'capacity:write',
      tenant_id: 'bank-a',
    });
    expect([withTenant['aud']].flat()).toEqual(['capacity-service']);
    expect(withTenant['tenant_id']).toBe('bank-a');
    const without = await stack.mint({
      client_id: 'funding-service.bank-a',
      client_secret: 's',
      scope: 'capacity:write',
    });
    expect(without['tenant_id']).not.toBe('bank-a');
  }, 60_000);
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function until(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

const stateOf = async (id: string): Promise<unknown> =>
  (await stack.funding('SELECT state FROM funding_request WHERE id = $1', [id]))[0]?.['state'];

const reserved = async (programId: string): Promise<string> =>
  String(
    (
      await stack.capacity(
        `SELECT reserved_minor::text AS r FROM program WHERE tenant_id = 'bank-a' AND id = $1`,
        [programId],
      )
    )[0]?.['r'],
  );

/** Runs one step at a time until the request reaches `state`. */
async function stepUntil(id: string, state: string, driver = stack.driver()): Promise<void> {
  for (let i = 0; i < 20 && (await stateOf(id)) !== state; i += 1) await driver.runOnce();
  expect(await stateOf(id)).toBe(state);
}

describe('compensation against the real capacity image', () => {
  it('FS-06 a declined payment releases the reservation: reserved is back, RESERVE then RELEASE, state FAILED', async () => {
    await stack.seedProgram({
      tenantId: 'bank-a',
      id: 'prg_comp',
      currency: 'USD',
      limitMinor: 5_000_000_00n,
    });
    const before = await reserved('prg_comp');
    const id = await stack.submit({
      tenantId: 'bank-a',
      programId: 'prg_comp',
      invoiceId: 'FAULT-DECLINE-1',
      value: '500.00',
    });
    await stack.drain(stack.driver());

    expect(await stateOf(id)).toBe('FAILED');
    expect(await reserved('prg_comp')).toBe(before);
    const [reservation] = await stack.capacity(
      `SELECT id::text, status, released_minor::text FROM reservation WHERE invoice_id = 'FAULT-DECLINE-1'`,
    );
    expect(reservation).toMatchObject({ status: 'RELEASED', released_minor: '50000' });
    const ledger = await stack.capacity(
      `SELECT kind, actor, delta_reserved_minor::text AS delta FROM ledger_entry WHERE reservation_id = $1::uuid ORDER BY id`,
      [reservation?.['id']],
    );
    expect(ledger).toEqual([
      { kind: 'RESERVE', actor: 'funding-service.bank-a', delta: '50000' },
      { kind: 'RELEASE', actor: 'funding-service.bank-a', delta: '-50000' },
    ]);
    const releases = await stack.capacity(
      `SELECT release_ref, reason FROM reservation_release WHERE reservation_id = $1::uuid`,
      [reservation?.['id']],
    );
    expect(releases).toEqual([{ release_ref: `funding:${id}:compensation`, reason: 'CANCELLED' }]);
    const payment = await fetch(
      `${stack.paymentsUrl}/v1/payments/${encodeURIComponent(`funding:${id}:disburse`)}`,
    );
    expect(await payment.json()).toMatchObject({ status: 'DECLINED' });
  }, 120_000);

  it('FS-11 capacity unreachable during a compensation: retried, reserved stays, and once it is back the release happens exactly once', async () => {
    await stack.seedProgram({
      tenantId: 'bank-a',
      id: 'prg_outage',
      currency: 'USD',
      limitMinor: 5_000_000_00n,
    });
    const before = await reserved('prg_outage');
    const id = await stack.submit({
      tenantId: 'bank-a',
      programId: 'prg_outage',
      invoiceId: 'FAULT-DECLINE-2',
      value: '300.00',
    });
    const driver = stack.driver();
    await stepUntil(id, 'COMPENSATING', driver);
    expect(await reserved('prg_outage')).toBe(String(BigInt(before) + 30000n));

    await stack.capacityProxy.setEnabled(false);
    try {
      for (let i = 0; i < 3; i += 1) await driver.runOnce();
      expect(await stateOf(id)).toBe('COMPENSATING');
      expect(await reserved('prg_outage')).toBe(String(BigInt(before) + 30000n));
    } finally {
      await stack.capacityProxy.setEnabled(true);
    }
    await until(async () => {
      await driver.runOnce();
      return (await stateOf(id)) === 'FAILED';
    }, 'the compensation to finish once capacity is back');

    expect(await reserved('prg_outage')).toBe(before);
    const ledger = await stack.capacity(
      `SELECT kind FROM ledger_entry WHERE program_id = 'prg_outage' AND kind IN ('RESERVE', 'RELEASE') ORDER BY id`,
    );
    expect(ledger.map((l) => l['kind'])).toEqual(['RESERVE', 'RELEASE']);
  }, 180_000);

  it('FS-11 capacity answers release-exceeds-remaining for a reservation already fully released; the saga ends FAILED without a second release', async () => {
    await stack.seedProgram({
      tenantId: 'bank-a',
      id: 'prg_gone',
      currency: 'USD',
      limitMinor: 5_000_000_00n,
    });
    const id = await stack.submit({
      tenantId: 'bank-a',
      programId: 'prg_gone',
      invoiceId: 'FAULT-DECLINE-3',
      value: '200.00',
    });
    const driver = stack.driver();
    await stepUntil(id, 'COMPENSATING', driver);
    const reservationId = String(
      (await stack.funding('SELECT reservation_id FROM funding_request WHERE id = $1', [id]))[0]?.[
        'reservation_id'
      ],
    );

    // Someone else (an operator over REST, say) releases the whole remainder first.
    const external = { tenantId: 'bank-a', programId: 'prg_gone', reservationId };
    expect(
      await stack.rawRelease({ ...external, releaseRef: 'external-ref', key: 'external-key' }),
    ).toEqual({ ok: true });
    // Proof of capacity's answer to a final release of nothing, asked with a ref of our own.
    const probe = await stack.rawRelease({
      ...external,
      releaseRef: 'probe-ref',
      key: 'probe-key',
    });
    expect(probe).toEqual({
      ok: false,
      code: 'FAILED_PRECONDITION',
      reason: 'release-exceeds-remaining',
    });

    await stack.drain(driver);
    expect(await stateOf(id)).toBe('FAILED');
    const ledger = await stack.capacity(
      `SELECT kind FROM ledger_entry WHERE reservation_id = $1::uuid ORDER BY id`,
      [reservationId],
    );
    expect(ledger.map((l) => l['kind'])).toEqual(['RESERVE', 'RELEASE']);
    expect(await reserved('prg_gone')).toBe('0');
  }, 120_000);
});

describe('exactly-once effect across the gRPC hop', () => {
  it('FS-07 capacity commits the Reserve but the answer is lost: the retry sends the same key and gets the same reservation', async () => {
    await stack.seedProgram({
      tenantId: 'bank-a',
      id: 'prg_lost',
      currency: 'USD',
      limitMinor: 5_000_000_00n,
    });
    const driver = stack.driver();
    // Warm the channel and the token with a first, unharmed request.
    const warm = await stack.submit({
      tenantId: 'bank-a',
      programId: 'prg_lost',
      invoiceId: 'inv-warm',
      value: '10.00',
    });
    await stack.drain(driver);
    expect(await stateOf(warm)).toBe('COMPLETED');

    const id = await stack.submit({
      tenantId: 'bank-a',
      programId: 'prg_lost',
      invoiceId: 'inv-lost-answer',
      value: '75.00',
    });
    await driver.runOnce(); // risk
    // Requests still reach capacity; its answers are held back until the toxic is removed.
    const toxic = await stack.capacityProxy.instance.addToxic({
      name: 'lost-answer',
      type: 'timeout',
      stream: 'downstream',
      toxicity: 1,
      attributes: { timeout: 0 },
    });
    try {
      await driver.runOnce(); // Reserve: committed in capacity, answer lost, deadline passes
      expect(await stateOf(id)).toBe('RESERVING');
      const committed = await stack.capacity(
        `SELECT id::text FROM reservation WHERE invoice_id = 'inv-lost-answer'`,
      );
      expect(committed).toHaveLength(1);
    } finally {
      await toxic.remove();
    }

    await until(async () => {
      await driver.runOnce();
      return (await stateOf(id)) === 'COMPLETED';
    }, 'the retry to finish once the answer path is back');

    const [row] = await stack.funding('SELECT reservation_id FROM funding_request WHERE id = $1', [
      id,
    ]);
    const reservations = await stack.capacity(
      `SELECT id::text FROM reservation WHERE invoice_id = 'inv-lost-answer'`,
    );
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.['id']).toBe(row?.['reservation_id']);
    const ledger = await stack.capacity(
      `SELECT kind FROM ledger_entry WHERE reservation_id = $1::uuid ORDER BY id`,
      [reservations[0]?.['id']],
    );
    expect(ledger.map((l) => l['kind'])).toEqual(['RESERVE']);
    expect(await reserved('prg_lost')).toBe('8500'); // 10.00 + 75.00, once each
    const attempts = await stack.funding(
      `SELECT outcome_class FROM saga_step_attempt WHERE request_id = $1 AND step = 'reserve' ORDER BY created_at, id`,
      [id],
    );
    expect(attempts.map((a) => a['outcome_class'])).toEqual(['unknown', 'success']);
  }, 180_000);
});
