import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/auth/seed.js';
import type { Db } from '../src/db.js';

import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

describe('sync ledger', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let driverToken: string;
  let driverId: string;
  let adminToken: string;
  let merchantToken: string;
  let deviceId: string;

  beforeAll(async () => {
    testDb = await createTestDb({ postgis: true });
    db = testDb.db;
    await seedAuthData(db);
    app = createApp({ db, mailer: new FakeMailer() } satisfies AppDeps);
    await seedUserWithRoles(db, ['DRIVER'], 'driver-sync@example.com');
    await seedUserWithRoles(db, ['ADMIN'], 'admin-sync@example.com');
    await seedUserWithRoles(db, ['MERCHANT'], 'merchant-sync@example.com');
    driverToken = (await request(app).post('/auth/login').send({ email: 'driver-sync@example.com', password: TEST_PASSWORD })).body.accessToken as string;
    adminToken = (await request(app).post('/auth/login').send({ email: 'admin-sync@example.com', password: TEST_PASSWORD })).body.accessToken as string;
    merchantToken = (await request(app).post('/auth/login').send({ email: 'merchant-sync@example.com', password: TEST_PASSWORD })).body.accessToken as string;
    driverId = (await db.query.users.findFirst({ where: (t, { eq }) => eq(t.email, 'driver-sync@example.com') }))!.id;
    const { devices } = await import('@logistics/db');
    const [d] = await db.insert(devices).values({ userId: driverId, name: 'test-device' }).returning();
    deviceId = d!.id;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  async function seedHubZonePickup() {
    const hubRes = await request(app).post('/locations/hubs').set('Authorization', `Bearer ${adminToken}`).send({ name: `Hub ${Date.now()}`, code: `H${Date.now()}`, address: '1 Test St' });
    const hubId = hubRes.body.hub.id as string;
    const oz = await request(app).post('/locations/zones').set('Authorization', `Bearer ${adminToken}`).send({ hubId, name: `OZ ${Date.now()}` });
    const dz = await request(app).post('/locations/zones').set('Authorization', `Bearer ${adminToken}`).send({ hubId, name: `DZ ${Date.now()}` });
    const pr = await request(app).post('/locations/pickup-points').set('Authorization', `Bearer ${adminToken}`).send({ hubId, zoneId: oz.body.zone.id, name: 'Pickup', address: '2 Test St' });
    const opt = await request(app).post('/pricing/delivery-options').set('Authorization', `Bearer ${adminToken}`).send({ code: `STD${Date.now()}`, name: 'Standard' });
    await request(app).post('/pricing/rules').set('Authorization', `Bearer ${adminToken}`).send({ originZoneId: oz.body.zone.id, destinationZoneId: dz.body.zone.id, sizeClass: 'SMALL', weightClass: 'LIGHT', deliveryOptionId: opt.body.deliveryOption.id, currency: 'GBP', amountCents: 1500, validFrom: new Date().toISOString() });
    return { hubId, originZoneId: oz.body.zone.id, destZoneId: dz.body.zone.id, pickupLocationId: pr.body.pickupLocation.id, deliveryOptionId: opt.body.deliveryOption.id };
  }

  async function bookShipment(ids: { pickupLocationId: string; destZoneId: string; deliveryOptionId: string }) {
    const res = await request(app).post('/pricing/book').set('Authorization', `Bearer ${merchantToken}`).send({ recipientName: 'Sync Recipient', pickupLocationId: ids.pickupLocationId, destinationZoneId: ids.destZoneId, deliveryOptionId: ids.deliveryOptionId, packages: [{ sizeClass: 'SMALL', weightClass: 'LIGHT', quantity: 1 }] });
    expect(res.status).toBe(201);
    return res.body.shipment.id as string;
  }

  it('ledger replay is idempotent via same-TX opId', async () => {
    const opId = crypto.randomUUID();
    const r1 = await request(app).post('/sync/push').set('Authorization', `Bearer ${driverToken}`).send({ deviceId, ops: [{ seq: 1, opId, action: 'noop', entity: 'shipment', payload: {} }] });
    expect(r1.status).toBe(200);
    expect(r1.body.results[0].status).toBe('APPLIED');
    const r2 = await request(app).post('/sync/push').set('Authorization', `Bearer ${driverToken}`).send({ deviceId, ops: [{ seq: 1, opId, action: 'noop', entity: 'shipment', payload: {} }] });
    expect(r2.status).toBe(200);
    expect(r2.body.results.length).toBe(0);
  });

  it('duplicate seq is rejected', async () => {
    const opA = crypto.randomUUID();
    const opB = crypto.randomUUID();
    await request(app).post('/sync/push').set('Authorization', `Bearer ${driverToken}`).send({ deviceId, ops: [{ seq: 2, opId: opA, action: 'noop', entity: 'shipment', payload: {} }] });
    const r = await request(app).post('/sync/push').set('Authorization', `Bearer ${driverToken}`).send({ deviceId, ops: [{ seq: 2, opId: opB, action: 'noop', entity: 'shipment', payload: {} }] });
    expect(r.status).toBe(409);
  });

  it('client resumes from last acked offset', async () => {
    const opId = crypto.randomUUID();
    await request(app).post('/sync/push').set('Authorization', `Bearer ${driverToken}`).send({ deviceId, ops: [{ seq: 3, opId, action: 'noop', entity: 'shipment', payload: {} }] });
    const pending = await request(app).get(`/sync/pending/${deviceId}?since=2`).set('Authorization', `Bearer ${driverToken}`);
    expect(pending.status).toBe(200);
    expect(pending.body.ops.some((o: { opId: string }) => o.opId === opId)).toBe(true);
  });

  it('field-locked shipment rejects conflicting op', async () => {
    const ids = await seedHubZonePickup();
    const shipmentId = await bookShipment(ids);
    const create = await request(app).post('/runs').set('Authorization', `Bearer ${adminToken}`).send({ hubId: ids.hubId, driverUserId: driverId, shipments: [{ shipmentId, sequence: 0 }] });
    const runId = create.body.run.id as string;
    await request(app).post(`/runs/${runId}/start`).set('Authorization', `Bearer ${adminToken}`);
    const opId = crypto.randomUUID();
    const r = await request(app).post('/sync/push').set('Authorization', `Bearer ${driverToken}`).send({ deviceId, ops: [{ seq: 10, opId, action: 'shipment.patch', entity: 'shipment', entityId: shipmentId, payload: { destinationZoneId: ids.hubId } }] });
    expect(r.body.results[0].status).toBe('REJECTED:SHIPMENT_LOCKED');
    await request(app).post(`/runs/${runId}/complete`).set('Authorization', `Bearer ${adminToken}`);
  });

  it('shipment transition via ledger respects state machine and skew', async () => {
    const ids = await seedHubZonePickup();
    const shipmentId = await bookShipment(ids);
    const opId = crypto.randomUUID();
    const r = await request(app).post('/sync/push').set('Authorization', `Bearer ${driverToken}`).send({ deviceId, ops: [{ seq: 11, opId, action: 'shipment.transition', entity: 'shipment', entityId: shipmentId, payload: { toStatus: 'PICKED_UP', occurredAt: new Date().toISOString() } }] });
    expect(r.body.results[0].status).toBe('APPLIED');
    const bad = crypto.randomUUID();
    const r2 = await request(app).post('/sync/push').set('Authorization', `Bearer ${driverToken}`).send({ deviceId, ops: [{ seq: 12, opId: bad, action: 'shipment.transition', entity: 'shipment', entityId: shipmentId, payload: { toStatus: 'DELIVERED', occurredAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() } }] });
    expect(r2.body.results[0].status).toBe('REJECTED:BAD_OCCURRED_AT');
  });

  it('batched GPS gated on ACTIVE does not resurrect completed run', async () => {
    const ids = await seedHubZonePickup();
    const shipmentId = await bookShipment(ids);
    const create = await request(app).post('/runs').set('Authorization', `Bearer ${adminToken}`).send({ hubId: ids.hubId, driverUserId: driverId, shipments: [{ shipmentId, sequence: 0 }] });
    const runId = create.body.run.id as string;
    await request(app).post(`/runs/${runId}/start`).set('Authorization', `Bearer ${adminToken}`);
    const ok = await request(app).post(`/runs/${runId}/gps`).set('Authorization', `Bearer ${driverToken}`).send({ positions: [{ latitude: 51.5, longitude: -0.1 }] });
    expect(ok.status).toBe(200);
    await request(app).post(`/runs/${runId}/complete`).set('Authorization', `Bearer ${adminToken}`);
    const bad = await request(app).post(`/runs/${runId}/gps`).set('Authorization', `Bearer ${driverToken}`).send({ positions: [{ latitude: 51.5, longitude: -0.1 }] });
    expect(bad.status).toBe(409);
  });
});
