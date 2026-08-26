import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { shipmentEvents } from '@logistics/db';

import { seedShipmentAt, setupShipmentsTest } from './shipments.fixture.js';
import type { ShipmentsFixture } from './shipments.fixture.js';

describe('shipments state machine: cancel', () => {
  let f: ShipmentsFixture;

  beforeAll(async () => {
    f = await setupShipmentsTest(['ADMIN', 'DISPATCHER', 'MERCHANT', 'CUSTOMER1', 'CUSTOMER2']);
  });

  afterAll(async () => {
    await f.cleanup();
  });

  const cancel = (id: string, token: string) =>
    request(f.app)
      .patch(`/api/v1/shipments/${id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'test-cancel' });

  async function eventCount(id: string): Promise<number> {
    const rows = await f.db
      .select({ id: shipmentEvents.id })
      .from(shipmentEvents)
      .where(eq(shipmentEvents.shipmentId, id));
    return rows.length;
  }

  it('lets a customer cancel their own BOOKED shipment and records the event', async () => {
    const id = await f.bookShipment('Cancel Mine');
    const before = await eventCount(id);

    const res = await cancel(id, f.token('CUSTOMER1'));
    expect(res.status).toBe(200);
    expect(res.body.shipment.status).toBe('CANCELLED');
    expect(res.body.event.fromStatus).toBe('BOOKED');
    expect(res.body.event.metadata).toMatchObject({ reason: 'test-cancel' });
    expect(await eventCount(id)).toBe(before + 1);
  });

  it('treats double cancel as an idempotent no-op (no duplicate event)', async () => {
    const id = await f.bookShipment('Double Cancel');
    await cancel(id, f.token('CUSTOMER1'));
    const afterFirst = await eventCount(id);

    const res = await cancel(id, f.token('CUSTOMER1'));
    expect(res.status).toBe(200);
    expect(res.body.event).toBeNull();
    expect(await eventCount(id)).toBe(afterFirst);
  });

  it('rejects a customer cancelling another customer\u2019s booking', async () => {
    const id = await f.bookShipment('Not Yours');
    const res = await cancel(id, f.token('CUSTOMER2'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_SHIPMENT_OWNER');
  });

  it('lets staff cancel any booking; lets merchants cancel their own', async () => {
    const dispatcherTarget = await f.bookShipment('Dispatcher Cancel');
    const res = await cancel(dispatcherTarget, f.token('DISPATCHER'));
    expect(res.status).toBe(200);

    const adminTarget = await f.bookShipment('Admin Cancel');
    const res2 = await cancel(adminTarget, f.token('ADMIN'));
    expect(res2.status).toBe(200);
  });

  it('rejects cancelling non-cancellable states with 409', async () => {
    for (const status of ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const) {
      const id = await seedShipmentAt(f.db, status);
      const res = await cancel(id, f.token('ADMIN'));
      expect(res.status, status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
    }
  });

  it('cancels a directly-seeded DRAFT shipment', async () => {
    const id = await seedShipmentAt(f.db, 'DRAFT');
    const res = await cancel(id, f.token('ADMIN'));
    expect(res.status).toBe(200);
    expect(res.body.shipment.status).toBe('CANCELLED');
  });

  it('returns 401 unauthenticated, 404 unknown uuid', async () => {
    const id = f.ids.bookedShipmentId;
    expect((await request(f.app).patch(`/api/v1/shipments/${id}/cancel`)).status).toBe(401);

    const missing = await request(f.app)
      .patch('/api/v1/shipments/00000000-0000-0000-0000-000000000000/cancel')
      .set('Authorization', `Bearer ${f.token('ADMIN')}`);
    expect(missing.status).toBe(404);
  });
});
