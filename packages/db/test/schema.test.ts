import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, cleanup } from './db.js';

describe('schema migration + round-trip', () => {
  afterAll(async () => {
    await cleanup();
  });

  it('migrates cleanly to a fresh database', async () => {
    const result = await db.execute(sql`
      SELECT COUNT(*) AS table_count
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    expect(Number(result.rows[0]!.table_count)).toBeGreaterThanOrEqual(30);
  });

  it('rejects invalid shipment status enum', async () => {
    await expect(
      db.execute(sql`
        INSERT INTO shipments (id, status, created_at, updated_at)
        VALUES (gen_random_uuid(), 'INVALID_STATUS', now(), now())
      `),
    ).rejects.toThrow();
  });

  it('rejects invalid currency enum', async () => {
    await expect(
      db.execute(sql`
        INSERT INTO collections (id, shipment_id, driver_user_id, amount_cents, currency, payment_method, collected_at, created_at)
        VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1000, 'XYZ', 'CASH', now(), now())
      `),
    ).rejects.toThrow();
  });

  it('round-trips a full shipment lifecycle', async () => {
    const hubResult = await db.execute(sql`
      INSERT INTO hubs (id, name, code, address, created_at)
      VALUES (gen_random_uuid(), 'Main Hub', 'HUB-001', '123 Main St', now())
      RETURNING id
    `);
    const hubId = hubResult.rows[0]!.id as string;

    const zoneResult = await db.execute(sql`
      INSERT INTO zones (id, hub_id, name, is_active, created_at)
      VALUES (gen_random_uuid(), ${hubId}, 'Zone A', true, now())
      RETURNING id
    `);
    const zoneId = zoneResult.rows[0]!.id as string;

    const userResult = await db.execute(sql`
      INSERT INTO users (id, email, password_hash, created_at, updated_at)
      VALUES (gen_random_uuid(), 'driver@test.com', 'hash', now(), now())
      RETURNING id
    `);
    const driverId = userResult.rows[0]!.id as string;

    const shipmentResult = await db.execute(sql`
      INSERT INTO shipments (id, status, sender_name, recipient_name, destination_zone_id, quote_amount_cents, quote_currency, created_at, updated_at)
      VALUES (gen_random_uuid(), 'DRAFT', 'Alice', 'Bob', ${zoneId}, 1500, 'USD', now(), now())
      RETURNING id
    `);
    const shipmentId = shipmentResult.rows[0]!.id as string;

    const packageResult = await db.execute(sql`
      INSERT INTO packages (id, shipment_id, size_class, weight_class, quantity, created_at)
      VALUES (gen_random_uuid(), ${shipmentId}, 'MEDIUM', 'LIGHT', 2, now())
      RETURNING id
    `);
    expect(packageResult.rows.length).toBe(1);

    const eventResult = await db.execute(sql`
      INSERT INTO shipment_events (id, shipment_id, to_status, occurred_at, created_at)
      VALUES (gen_random_uuid(), ${shipmentId}, 'BOOKED', now(), now())
      RETURNING id
    `);
    expect(eventResult.rows.length).toBe(1);

    const runResult = await db.execute(sql`
      INSERT INTO runs (id, driver_user_id, status, created_at)
      VALUES (gen_random_uuid(), ${driverId}, 'ACTIVE', now())
      RETURNING id
    `);
    const runId = runResult.rows[0]!.id as string;

    const entryResult = await db.execute(sql`
      INSERT INTO run_sheet_entries (id, run_id, shipment_id, sequence, created_at)
      VALUES (gen_random_uuid(), ${runId}, ${shipmentId}, 1, now())
      RETURNING id
    `);
    expect(entryResult.rows.length).toBe(1);

    const gpsResult = await db.execute(sql`
      INSERT INTO gps_positions (id, run_id, driver_user_id, latitude, longitude, recorded_at, created_at)
      VALUES (gen_random_uuid(), ${runId}, ${driverId}, 40.7128, -74.0060, now(), now())
      RETURNING id
    `);
    expect(gpsResult.rows.length).toBe(1);

    const collectionResult = await db.execute(sql`
      INSERT INTO collections (id, shipment_id, driver_user_id, amount_cents, currency, payment_method, collected_at, created_at)
      VALUES (gen_random_uuid(), ${shipmentId}, ${driverId}, 2500, 'GBP', 'CASH', now(), now())
      RETURNING id
    `);
    expect(collectionResult.rows.length).toBe(1);
  });

  it('enforces FK: child with nonexistent parent fails', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';

    await expect(
      db.execute(sql`
        INSERT INTO packages (id, shipment_id, size_class, weight_class, quantity, created_at)
        VALUES (gen_random_uuid(), ${fakeId}, 'SMALL', 'HEAVY', 1, now())
      `),
    ).rejects.toThrow();
  });

  it('enforces unique constraint on user email', async () => {
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, created_at, updated_at)
      VALUES (gen_random_uuid(), 'unique@test.com', 'hash', now(), now())
    `);

    await expect(
      db.execute(sql`
        INSERT INTO users (id, email, password_hash, created_at, updated_at)
        VALUES (gen_random_uuid(), 'unique@test.com', 'hash2', now(), now())
      `),
    ).rejects.toThrow();
  });

  it('stores and retrieves JSONB payload', async () => {
    const result = await db.execute(sql`
      INSERT INTO roles (id, name, permissions, created_at)
      VALUES (gen_random_uuid(), 'ADMIN', '{"read": true, "write": true}', now())
      RETURNING permissions
    `);

    expect(result.rows[0]!.permissions).toEqual({ read: true, write: true });
  });
});