import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { collections, users } from '@logistics/db';

import type { Db } from '../src/shared/db.js';

import { createTestDb } from './db.js';

// Postgres sum(int) returns bigint. An ::int cast overflows at 2^31-1 minor units
// (2,147,483,647 cents = GBP 21,474,836.47), so a large tenant's report threw
// instead of returning a number. ::float8 removes that ceiling while keeping the
// wire type a JSON number.
const OVERFLOW_CEILING_MINOR = 2_147_483_647;

describe('money aggregates', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let driverUserId: string;

  beforeAll(async () => {
    // scripts/test-cod.sh exports DATABASE_URL for the socket server, so this
    // connects over TCP and never instantiates PGlite in-process. The option is
    // only a fallback for running this file bare.
    testDb = await createTestDb({ memory: true });
    db = testDb.db;

    const [driver] = await db
      .insert(users)
      .values({ email: 'money-driver@example.com', emailVerifiedAt: new Date() })
      .returning({ id: users.id });
    driverUserId = driver!.id;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  async function insertCollection(amountCents: number): Promise<void> {
    await db.insert(collections).values({
      shipmentId: crypto.randomUUID(),
      driverUserId,
      amountCents,
      currency: 'GBP',
      paymentMethod: 'CASH',
      collectedAt: new Date(),
    });
  }

  async function aggregate(cast: string): Promise<unknown> {
    const rows = await db.execute(
      sql.raw(`select coalesce(sum(amount_cents), 0) ${cast} as v from collections`),
    );
    return (rows as unknown as { v: unknown }[])[0]?.v;
  }

  it('returns a total past the old ::int ceiling without throwing', async () => {
    // 90,000,000,000 cents = GBP 900,000,000, far beyond the ::int ceiling.
    await insertCollection(90_000_000_000);

    const value = await aggregate('::float8');

    expect(typeof value).toBe('number');
    expect(value).toBe(90_000_000_000);
    expect(90_000_000_000).toBeGreaterThan(OVERFLOW_CEILING_MINOR);
  });

  it('still errors under ::int, proving the cast is load-bearing', async () => {
    await expect(aggregate('::int')).rejects.toThrow();
  });

  it('serialises as an integer JSON number, not a float with decimals', async () => {
    await insertCollection(1234);
    await insertCollection(1235);

    const value = await aggregate('::float8');
    const encoded = JSON.stringify({ total: value });

    expect(value).toBe(90_000_000_002 + 2469);
    expect(encoded).not.toContain('.');
    expect(Number.isInteger(value)).toBe(true);
  });

  it('sums exactly, with no floating point drift', async () => {
    await insertCollection(1);
    await insertCollection(2);

    const value = await aggregate('::float8');

    expect(value).toBe(90_000_000_002 + 2469 + 3);
  });
});