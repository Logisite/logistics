import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { auditLog, shipmentEvents } from '@logistics/db';

import { seedShipmentAt, setupShipmentsTest } from './shipments.fixture.js';
import type { ShipmentsFixture } from './shipments.fixture.js';

// Mirrors modules/api/v1/shipments/transitions.ts on purpose: if the gateway and this
// table ever disagree, these tests fail and the diff IS the bug.
const VALID: Record<string, string[]> = {
  DRAFT: ['BOOKED', 'CANCELLED'],
  BOOKED: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: ['IN_TRANSIT'],
  IN_TRANSIT: ['OUT_FOR_DELIVERY', 'RETURNING'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'FAILED_ATTEMPT'],
  FAILED_ATTEMPT: ['OUT_FOR_DELIVERY', 'RETURNING'],
  RETURNING: ['RETURNED'],
  DELIVERED: [],
  RETURNED: [],
  CANCELLED: [],
};

const STATUSES = Object.keys(VALID);

const TARGET_ROUTES: Record<string, { method: 'post' | 'patch'; path: string }> = {
  PICKED_UP: { method: 'post', path: 'pickup' },
  IN_TRANSIT: { method: 'post', path: 'transit' },
  OUT_FOR_DELIVERY: { method: 'post', path: 'out-for-delivery' },
  DELIVERED: { method: 'post', path: 'deliver' },
  FAILED_ATTEMPT: { method: 'post', path: 'fail-attempt' },
  RETURNING: { method: 'post', path: 'return' },
  RETURNED: { method: 'post', path: 'returned' },
  CANCELLED: { method: 'patch', path: 'cancel' },
};

describe('shipments state machine: transitions', () => {
  let f: ShipmentsFixture;

  beforeAll(async () => {
    f = await setupShipmentsTest(['ADMIN', 'DISPATCHER', 'MERCHANT', 'CUSTOMER1', 'CUSTOMER2']);
  });

  afterAll(async () => {
    await f.cleanup();
  });

  const admin = () => `Bearer ${f.token('ADMIN')}`;

  async function callTransition(
    shipmentId: string,
    target: string,
    token: string,
    body: Record<string, unknown> = {},
  ): Promise<request.Response> {
    const route = TARGET_ROUTES[target]!;
    const req =
      route.method === 'patch'
        ? request(f.app).patch(`/api/v1/shipments/${shipmentId}/${route.path}`)
        : request(f.app).post(`/api/v1/shipments/${shipmentId}/${route.path}`);
    return req.set('Authorization', `Bearer ${token}`).send(body);
  }

  async function eventCount(shipmentId: string): Promise<number> {
    const rows = await f.db
      .select({ id: shipmentEvents.id })
      .from(shipmentEvents)
      .where(eq(shipmentEvents.shipmentId, shipmentId));
    return rows.length;
  }

  it('walks the happy chain BOOKED to DELIVERED, appending an event per step', async () => {
    const id = await f.bookShipment('Happy Chain');
    const steps = [
      ['pickup', 'PICKED_UP'],
      ['transit', 'IN_TRANSIT'],
      ['out-for-delivery', 'OUT_FOR_DELIVERY'],
      ['deliver', 'DELIVERED'],
    ] as const;

    let from = 'BOOKED';
    for (const [path, status] of steps) {
      const res = await request(f.app)
        .post(`/api/v1/shipments/${id}/${path}`)
        .set('Authorization', admin())
        .send({ locationLabel: `Hub @ ${status}` });
      expect(res.status).toBe(200);
      expect(res.body.shipment.status).toBe(status);
      expect(res.body.event.fromStatus).toBe(from);
      expect(res.body.event.toStatus).toBe(status);
      expect(res.body.event.actorUserId).toBeTruthy();
      expect(res.body.event.locationLabel).toBe(`Hub @ ${status}`);
      from = status;
    }

    const timeline = await request(f.app)
      .get(`/api/v1/shipments/${id}/events`)
      .set('Authorization', admin());
    expect(timeline.status).toBe(200);
    const seq = timeline.body.events.map((e: { toStatus: string }) => e.toStatus);
    expect(seq).toEqual(['BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']);

    const last = timeline.body.events.at(-1);
    expect(Date.now() - Date.parse(last.occurredAt)).toBeLessThan(60000);
  });

  describe('rejects every invalid (from,to) pair with 409', () => {
    for (const from of STATUSES) {
      it(`from ${from}`, async () => {
        const id = await seedShipmentAt(f.db, from as never);
        for (const to of STATUSES) {
          // DRAFT/BOOKED are never transition targets: booking creates BOOKED,
          // and no route exists for either.
          if ((to === 'DRAFT' || to === 'BOOKED') || to === from) continue;
          if (VALID[from]!.includes(to)) continue;
          const res = await callTransition(id, to, f.token('ADMIN'));
          expect(res.status, `${from} -> ${to}`).toBe(409);
          expect(res.body.error.code).toBe('INVALID_TRANSITION');
        }
      });
    }
  });

  it('treats same-state calls as idempotent no-ops without appending events', async () => {
    const id = await f.bookShipment('Noop Target');
    const before = await eventCount(id);

    const first = await callTransition(id, 'PICKED_UP', f.token('ADMIN'));
    expect(first.status).toBe(200);
    const afterFirst = await eventCount(id);

    const second = await callTransition(id, 'PICKED_UP', f.token('ADMIN'));
    expect(second.status).toBe(200);
    expect(second.body.event).toBeNull();
    expect(second.body.shipment.status).toBe('PICKED_UP');
    expect(await eventCount(id)).toBe(afterFirst);
    expect(afterFirst).toBe(before + 1);
  });

  it('audits rejected attempts', async () => {
    const id = await f.bookShipment('Reject Audit');
    const before = await f.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, 'shipment.transition.rejected'));

    await callTransition(id, 'DELIVERED', f.token('ADMIN'));

    const after = await f.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, 'shipment.transition.rejected'));
    expect(after.length).toBe(before.length + 1);
  });

  it('rejects unauthenticated transition and read attempts', async () => {
    const id = f.ids.bookedShipmentId;
    expect((await request(f.app).post(`/api/v1/shipments/${id}/pickup`)).status).toBe(401);
    expect((await request(f.app).get(`/api/v1/shipments/${id}/events`)).status).toBe(401);
  });

  it('rejects non-staff roles on staff transitions and reads', async () => {
    const id = f.ids.bookedShipmentId;
    for (const role of ['CUSTOMER2', 'MERCHANT'] as const) {
      const post = await callTransition(id, 'PICKED_UP', f.token(role));
      expect(post.status, role).toBe(403);
      const get = await request(f.app)
        .get(`/api/v1/shipments/${id}/events`)
        .set('Authorization', `Bearer ${f.token(role)}`);
      expect(get.status, role).toBe(403);
    }
  });

  it('returns 400 for malformed ids and 404 for unknown uuids', async () => {
    const bad = await request(f.app)
      .post('/api/v1/shipments/not-a-uuid/pickup')
      .set('Authorization', admin());
    expect(bad.status).toBe(400);

    const missing = await request(f.app)
      .post('/api/v1/shipments/00000000-0000-0000-0000-000000000000/pickup')
      .set('Authorization', admin());
    expect(missing.status).toBe(404);

    const missingEvents = await request(f.app)
      .get('/api/v1/shipments/00000000-0000-0000-0000-000000000000/events')
      .set('Authorization', admin());
    expect(missingEvents.status).toBe(404);
  });
});
