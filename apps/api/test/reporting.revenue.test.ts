import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/auth/seed.js';
import type { Db } from '../src/db.js';
import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

describe('reporting revenue', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let adminToken: string;
  let zoneId: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    await seedAuthData(db);
    app = createApp({ db, mailer: new FakeMailer() } satisfies AppDeps);
    await seedUserWithRoles(db, ['ADMIN'], 'admin-report@example.com');
    adminToken = (await request(app).post('/auth/login').send({ email: 'admin-report@example.com', password: TEST_PASSWORD })).body.accessToken as string;
    const hub = await request(app).post('/locations/hubs').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Rep Hub', code: 'REP', address: '1 St' });
    const oz = await request(app).post('/locations/zones').set('Authorization', `Bearer ${adminToken}`).send({ hubId: hub.body.hub.id, name: 'Rep OZ' });
    const dz = await request(app).post('/locations/zones').set('Authorization', `Bearer ${adminToken}`).send({ hubId: hub.body.hub.id, name: 'Rep DZ' });
    zoneId = dz.body.zone.id;
    const pp = await request(app).post('/locations/pickup-points').set('Authorization', `Bearer ${adminToken}`).send({ hubId: hub.body.hub.id, zoneId: oz.body.zone.id, name: 'PP', address: '2 St' });
    const opt = await request(app).post('/pricing/delivery-options').set('Authorization', `Bearer ${adminToken}`).send({ code: 'STD', name: 'Standard' });
    await request(app).post('/pricing/rules').set('Authorization', `Bearer ${adminToken}`).send({ originZoneId: oz.body.zone.id, destinationZoneId: zoneId, sizeClass: 'SMALL', weightClass: 'LIGHT', deliveryOptionId: opt.body.deliveryOption.id, currency: 'GBP', amountCents: 1200, validFrom: new Date().toISOString() });
    await request(app).post('/pricing/book').set('Authorization', `Bearer ${adminToken}`).send({ recipientName: 'R', pickupLocationId: pp.body.pickupLocation.id, destinationZoneId: zoneId, deliveryOptionId: opt.body.deliveryOption.id, packages: [{ sizeClass: 'SMALL', weightClass: 'LIGHT', quantity: 1 }] });
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  it('returns functional totals and filters by zone', async () => {
    const ok = await request(app).get('/reports/revenue').set('Authorization', `Bearer ${adminToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data[0].functionalTotalMinor).toBeDefined();
    const filtered = await request(app).get(`/reports/revenue?zoneId=${zoneId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(filtered.status).toBe(200);
  });

  it('404 on unknown zone', async () => {
    const fake = crypto.randomUUID();
    const r = await request(app).get(`/reports/revenue?zoneId=${fake}`).set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(404);
  });
});
