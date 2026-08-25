import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/auth/seed.js';
import type { Db } from '../src/db.js';

import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

describe('runs + dispatch + field locks', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let adminToken: string;
  let dispatcherToken: string;
  let driverToken: string;
  let driverId: string;
  let merchantToken: string;
  let ids: { hubId: string; originZoneId: string; destZoneId: string; pickupLocationId: string; deliveryOptionId: string };

  beforeAll(async () => {
    testDb = await createTestDb({ postgis: true });
    db = testDb.db;
    await seedAuthData(db);
    app = createApp({ db, mailer: new FakeMailer() } satisfies AppDeps);

    await seedUserWithRoles(db, ['ADMIN'], 'admin-runs@example.com');
    await seedUserWithRoles(db, ['DISPATCHER'], 'dispatcher-runs@example.com');
    await seedUserWithRoles(db, ['DRIVER'], 'driver-runs@example.com');
    await seedUserWithRoles(db, ['MERCHANT'], 'merchant-runs@example.com');

    adminToken = (await request(app).post('/auth/login').send({ email: 'admin-runs@example.com', password: TEST_PASSWORD })).body.accessToken as string;
    dispatcherToken = (await request(app).post('/auth/login').send({ email: 'dispatcher-runs@example.com', password: TEST_PASSWORD })).body.accessToken as string;
    driverToken = (await request(app).post('/auth/login').send({ email: 'driver-runs@example.com', password: TEST_PASSWORD })).body.accessToken as string;
    merchantToken = (await request(app).post('/auth/login').send({ email: 'merchant-runs@example.com', password: TEST_PASSWORD })).body.accessToken as string;

    driverId = (await db.query.users.findFirst({ where: (t, { eq }) => eq(t.email, 'driver-runs@example.com') }))!.id;

    const hubRes = await request(app).post('/locations/hubs').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Runs Hub', code: 'RUN-01', address: '1 Runs Street, London' });
    const hubId = hubRes.body.hub.id as string;
    const oz = await request(app).post('/locations/zones').set('Authorization', `Bearer ${adminToken}`).send({ hubId, name: 'Runs Origin' });
    const dz = await request(app).post('/locations/zones').set('Authorization', `Bearer ${adminToken}`).send({ hubId, name: 'Runs Dest' });
    const pr = await request(app).post('/locations/pickup-points').set('Authorization', `Bearer ${adminToken}`).send({ hubId, zoneId: oz.body.zone.id, name: 'Runs Pickup', address: '2 Pickup Road, London' });
    const opt = await request(app).post('/pricing/delivery-options').set('Authorization', `Bearer ${adminToken}`).send({ code: 'STANDARD', name: 'Standard Delivery' });
    await request(app).post('/pricing/rules').set('Authorization', `Bearer ${adminToken}`).send({ originZoneId: oz.body.zone.id, destinationZoneId: dz.body.zone.id, sizeClass: 'SMALL', weightClass: 'LIGHT', deliveryOptionId: opt.body.deliveryOption.id, currency: 'GBP', amountCents: 1800, validFrom: new Date().toISOString() });

    ids = { hubId, originZoneId: oz.body.zone.id, destZoneId: dz.body.zone.id, pickupLocationId: pr.body.pickupLocation.id, deliveryOptionId: opt.body.deliveryOption.id };
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  async function bookAs(token: string): Promise<string> {
    const res = await request(app).post('/pricing/book').set('Authorization', `Bearer ${token}`).send({ recipientName: 'Run Recipient', pickupLocationId: ids.pickupLocationId, destinationZoneId: ids.destZoneId, deliveryOptionId: ids.deliveryOptionId, packages: [{ sizeClass: 'SMALL', weightClass: 'LIGHT', quantity: 1 }] });
    expect(res.status).toBe(201);
    return res.body.shipment.id as string;
  }

  it('dispatcher builds a run and driver retrieves run-sheet', async () => {
    const s1 = await bookAs(merchantToken);
    const s2 = await bookAs(merchantToken);
    const create = await request(app).post('/runs').set('Authorization', `Bearer ${dispatcherToken}`).send({ hubId: ids.hubId, driverUserId: driverId, shipments: [{ shipmentId: s1, sequence: 0 }, { shipmentId: s2, sequence: 1 }] });
    expect(create.status).toBe(201);
    const runId = create.body.run.id as string;
    const sheet = await request(app).get(`/runs/${runId}`).set('Authorization', `Bearer ${driverToken}`);
    expect(sheet.status).toBe(200);
    expect(sheet.body.entries).toHaveLength(2);
    expect(sheet.body.entries[0].shipment.id).toBe(s1);
    const mine = await request(app).get('/runs/mine').set('Authorization', `Bearer ${driverToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.runs.some((r: { id: string }) => r.id === runId)).toBe(true);
  });

  it('field lock active on active run rejects restricted edits but allows free fields and admin bypass', async () => {
    const sid = await bookAs(merchantToken);
    const create = await request(app).post('/runs').set('Authorization', `Bearer ${dispatcherToken}`).send({ hubId: ids.hubId, driverUserId: driverId, shipments: [{ shipmentId: sid, sequence: 0 }] });
    const runId = create.body.run.id as string;
    await request(app).post(`/runs/${runId}/start`).set('Authorization', `Bearer ${dispatcherToken}`);
    const blocked = await request(app).patch(`/shipments/${sid}`).set('Authorization', `Bearer ${merchantToken}`).send({ recipientName: 'Hacked' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SHIPMENT_LOCKED');
    const free = await request(app).patch(`/shipments/${sid}`).set('Authorization', `Bearer ${merchantToken}`).send({ specialInstructions: 'leave at back door' });
    expect(free.status).toBe(200);
    const adminBypass = await request(app).patch(`/shipments/${sid}`).set('Authorization', `Bearer ${adminToken}`).send({ recipientName: 'Admin Fix' });
    expect(adminBypass.status).toBe(200);
    await request(app).post(`/runs/${runId}/complete`).set('Authorization', `Bearer ${dispatcherToken}`);
    const after = await request(app).patch(`/shipments/${sid}`).set('Authorization', `Bearer ${merchantToken}`).send({ recipientName: 'After Unlock' });
    expect(after.status).toBe(200);
  });

  it('prevents duplicate assignment via active run check', async () => {
    const sid = await bookAs(merchantToken);
    const r1 = await request(app).post('/runs').set('Authorization', `Bearer ${dispatcherToken}`).send({ hubId: ids.hubId, driverUserId: driverId, shipments: [{ shipmentId: sid, sequence: 0 }] });
    const runId1 = r1.body.run.id as string;
    await request(app).post(`/runs/${runId1}/start`).set('Authorization', `Bearer ${dispatcherToken}`);
    const r2 = await request(app).post('/runs').set('Authorization', `Bearer ${dispatcherToken}`).send({ hubId: ids.hubId, driverUserId: driverId, shipments: [{ shipmentId: sid, sequence: 0 }] });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('SHIPMENT_ON_ACTIVE_RUN');
    await request(app).post(`/runs/${runId1}/complete`).set('Authorization', `Bearer ${dispatcherToken}`);
  });

  it('rejects ineligible shipment statuses', async () => {
    const sid = await bookAs(merchantToken);
    await request(app).post(`/shipments/${sid}/pickup`).set('Authorization', `Bearer ${dispatcherToken}`);
    await request(app).post(`/shipments/${sid}/transit`).set('Authorization', `Bearer ${dispatcherToken}`);
    await request(app).post(`/shipments/${sid}/out-for-delivery`).set('Authorization', `Bearer ${dispatcherToken}`);
    await request(app).post(`/shipments/${sid}/deliver`).set('Authorization', `Bearer ${dispatcherToken}`);
    const attempt = await request(app).post('/runs').set('Authorization', `Bearer ${dispatcherToken}`).send({ hubId: ids.hubId, driverUserId: driverId, shipments: [{ shipmentId: sid, sequence: 0 }] });
    expect(attempt.status).toBe(409);
    expect(attempt.body.error.code).toBe('INELIGIBLE_STATUS');
  });

  it('driver self-claim creates a run assigned to self', async () => {
    const sid = await bookAs(merchantToken);
    const res = await request(app).post('/runs/claim').set('Authorization', `Bearer ${driverToken}`).send({ hubId: ids.hubId, shipmentIds: [sid] });
    expect(res.status).toBe(201);
    expect(res.body.run.driverUserId).toBe(driverId);
  });

  it('cancel-while-active releases lock', async () => {
    const sid = await bookAs(merchantToken);
    const create = await request(app).post('/runs').set('Authorization', `Bearer ${dispatcherToken}`).send({ hubId: ids.hubId, driverUserId: driverId, shipments: [{ shipmentId: sid, sequence: 0 }] });
    const runId = create.body.run.id as string;
    await request(app).post(`/runs/${runId}/start`).set('Authorization', `Bearer ${dispatcherToken}`);
    await request(app).post(`/runs/${runId}/cancel`).set('Authorization', `Bearer ${dispatcherToken}`);
    const after = await request(app).patch(`/shipments/${sid}`).set('Authorization', `Bearer ${merchantToken}`).send({ recipientName: 'After Cancel' });
    expect(after.status).toBe(200);
  });

  it('rejects non-dispatcher run creation', async () => {
    const sid = await bookAs(merchantToken);
    const res = await request(app).post('/runs').set('Authorization', `Bearer ${merchantToken}`).send({ hubId: ids.hubId, driverUserId: driverId, shipments: [{ shipmentId: sid, sequence: 0 }] });
    expect(res.status).toBe(403);
  });
});
