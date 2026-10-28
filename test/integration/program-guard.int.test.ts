import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgProgramRepository } from '#src/capacity/adapters/out/postgres/repositories/program.repository.js';
import {
  programRow,
  seedProgram,
  startCapacityWorld,
  type CapacityWorld,
} from '../support/capacity-world.js';

describe('program update guard', () => {
  let world: CapacityWorld;
  let programs: PgProgramRepository;

  beforeAll(async () => {
    world = await startCapacityWorld();
    programs = new PgProgramRepository(world.persistence.db);
    await seedProgram(world, {
      tenantId: 'bank-a',
      id: 'p',
      limitMinor: 1_000n,
      reservedMinor: 900n,
    });
    await seedProgram(world, {
      tenantId: 'bank-a',
      id: 'suspended',
      limitMinor: 1_000n,
      status: 'SUSPENDED',
    });
  });

  afterAll(async () => {
    await world.close();
  });

  it('I2 refuses a reserve above limit minus reserved at the UPDATE itself and changes nothing', async () => {
    const before = await programRow(world, 'bank-a', 'p');
    await expect(programs.reserve('bank-a', 'p', 101n)).resolves.toBeNull();
    expect(await programRow(world, 'bank-a', 'p')).toEqual(before);

    const exact = await programs.reserve('bank-a', 'p', 100n);
    expect(exact).toMatchObject({ reservedMinor: 1_000n, version: 1, platformSeq: 1 });
    await expect(programs.reserve('bank-a', 'p', 1n)).resolves.toBeNull();
    expect((await programRow(world, 'bank-a', 'p')).version).toBe('1');
  });

  it('I2 refuses a reserve on a SUSPENDED program at the UPDATE itself and changes nothing', async () => {
    const before = await programRow(world, 'bank-a', 'suspended');
    await expect(programs.reserve('bank-a', 'suspended', 1n)).resolves.toBeNull();
    expect(await programRow(world, 'bank-a', 'suspended')).toEqual(before);
  });

  it('I2 refuses a release that would drive reserved below zero', async () => {
    const before = await programRow(world, 'bank-a', 'suspended');
    await expect(programs.release('bank-a', 'suspended', 1n)).resolves.toBeNull();
    expect(await programRow(world, 'bank-a', 'suspended')).toEqual(before);
    const { rows } = await sql`SELECT 1 FROM program WHERE tenant_id = 'bank-b'`.execute(
      world.persistence.db,
    );
    expect(rows).toHaveLength(0);
    await expect(programs.reserve('bank-b', 'p', 1n)).resolves.toBeNull();
  });
});
