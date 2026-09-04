import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/modules/auth/seed.js';
import type { Db } from '../src/shared/db.js';

import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

const ADMIN_EMAIL = 'admin-loc@example.com';
const DISPATCHER_EMAIL = 'dispatcher-loc@example.com';

describe('locations', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let adminToken: string;
  let dispatcherToken: string;

  beforeAll(async () => {
    testDb = await createTestDb({ postgis: true });
    db = testDb.db;
    await seedAuthData(db);
    app = createApp({ db, mailer: new FakeMailer() } satisfies AppDeps);

    await seedUserWithRoles(db, ['ADMIN'], ADMIN_EMAIL);
    await seedUserWithRoles(db, ['DISPATCHER'], DISPATCHER_EMAIL);

    const adminLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: TEST_PASSWORD });
    adminToken = adminLogin.body.accessToken as string;

    const dispatcherLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: DISPATCHER_EMAIL, password: TEST_PASSWORD });
    dispatcherToken = dispatcherLogin.body.accessToken as string;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  // ── Hubs ─────────────────────────────────────────────────────────────────

  describe('hubs', () => {
    let hubId: string;

    it('rejects unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/locations/hubs');
      expect(res.status).toBe(401);
    });

    it('rejects non-admin role (403)', async () => {
      const res = await request(app)
        .get('/api/v1/locations/hubs')
        .set('Authorization', `Bearer ${dispatcherToken}`);
      expect(res.status).toBe(403);
    });

    it('returns empty list initially', async () => {
      const res = await request(app)
        .get('/api/v1/locations/hubs')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.hubs).toEqual([]);
    });

    it('creates a hub', async () => {
      const res = await request(app)
        .post('/api/v1/locations/hubs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'London Hub', code: 'LON-01', address: '10 Downing Street, London' });
      expect(res.status).toBe(201);
      expect(res.body.hub).toMatchObject({
        name: 'London Hub',
        code: 'LON-01',
        address: '10 Downing Street, London',
        isActive: true,
      });
      expect(res.body.hub.id).toBeDefined();
      hubId = res.body.hub.id;
    });

    it('rejects duplicate hub code', async () => {
      const res = await request(app)
        .post('/api/v1/locations/hubs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Another Hub', code: 'LON-01', address: '1 Parliament St' });
      expect(res.status).toBe(409);
    });

    it('rejects missing required fields', async () => {
      const res = await request(app)
        .post('/api/v1/locations/hubs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Incomplete' });
      expect(res.status).toBe(400);
    });

    it('reads the hub', async () => {
      const res = await request(app)
        .get('/api/v1/locations/hubs')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.hubs).toHaveLength(1);
      expect(res.body.hubs[0].code).toBe('LON-01');
    });

    it('updates the hub', async () => {
      const res = await request(app)
        .put(`/api/v1/locations/hubs/${hubId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'London Central Hub' });
      expect(res.status).toBe(200);
      expect(res.body.hub.name).toBe('London Central Hub');
    });

    it('soft-deletes the hub', async () => {
      const res = await request(app)
        .delete(`/api/v1/locations/hubs/${hubId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.hub.isActive).toBe(false);
    });

    it('admin list still includes inactive hubs', async () => {
      const res = await request(app)
        .get('/api/v1/locations/hubs')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.hubs).toHaveLength(1);
      expect(res.body.hubs[0].isActive).toBe(false);
    });

    it('returns 404 for non-existent hub', async () => {
      const res = await request(app)
        .put('/api/v1/locations/hubs/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Nope' });
      expect(res.status).toBe(404);
    });
  });

  // ── Pickup locations ─────────────────────────────────────────────────────

  describe('pickup locations', () => {
    let hubId: string;
    let pickupId: string;

    beforeAll(async () => {
      // Create a hub first (need a valid hub for pickup location)
      const res = await request(app)
        .post('/api/v1/locations/hubs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Manchester Hub', code: 'MAN-01', address: '1 Albert Square, Manchester' });
      hubId = res.body.hub.id;
    });

    it('creates a pickup location', async () => {
      const res = await request(app)
        .post('/api/v1/locations/pickup-points')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ hubId, name: 'City Centre Point', address: '50 Piccadilly, Manchester' });
      expect(res.status).toBe(201);
      expect(res.body.pickupLocation).toMatchObject({
        name: 'City Centre Point',
        hubId,
      });
      pickupId = res.body.pickupLocation.id;
    });

    it('creates a pickup location without hub', async () => {
      const res = await request(app)
        .post('/api/v1/locations/pickup-points')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Standalone Point', address: '1 Oxford Road, Manchester' });
      expect(res.status).toBe(201);
      expect(res.body.pickupLocation.hubId).toBeNull();
    });

    it('rejects invalid hub id', async () => {
      const res = await request(app)
        .post('/api/v1/locations/pickup-points')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ hubId: 'not-a-uuid', name: 'Bad Hub', address: '123 Street' });
      expect(res.status).toBe(400);
    });

    it('rejects non-existent hub', async () => {
      const res = await request(app)
        .post('/api/v1/locations/pickup-points')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          hubId: '00000000-0000-0000-0000-000000000000',
          name: 'Ghost Hub',
          address: '456 Street',
        });
      expect(res.status).toBe(400);
    });

    it('lists pickup locations', async () => {
      const res = await request(app)
        .get('/api/v1/locations/pickup-points')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.pickupLocations.length).toBeGreaterThanOrEqual(2);
    });

    it('updates a pickup location', async () => {
      const res = await request(app)
        .put(`/api/v1/locations/pickup-points/${pickupId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'City Centre Hub Point' });
      expect(res.status).toBe(200);
      expect(res.body.pickupLocation.name).toBe('City Centre Hub Point');
    });

    it('soft-deletes a pickup location', async () => {
      const res = await request(app)
        .delete(`/api/v1/locations/pickup-points/${pickupId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.pickupLocation.isActive).toBe(false);
    });

    it('returns 404 for non-existent pickup location', async () => {
      const res = await request(app)
        .put('/api/v1/locations/pickup-points/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Nope' });
      expect(res.status).toBe(404);
    });
  });

  // ── Zones ────────────────────────────────────────────────────────────────

  describe('zones', () => {
    let hubId: string;
    let zoneId: string;

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/v1/locations/hubs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Birmingham Hub', code: 'BIR-01', address: '1 Victoria Square, Birmingham' });
      hubId = res.body.hub.id;
    });

    it('creates a zone', async () => {
      const res = await request(app)
        .post('/api/v1/locations/zones')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ hubId, name: 'Zone A', description: 'Central Birmingham' });
      expect(res.status).toBe(201);
      expect(res.body.zone).toMatchObject({
        hubId,
        name: 'Zone A',
        description: 'Central Birmingham',
      });
      zoneId = res.body.zone.id;
    });

    it('rejects duplicate zone name per hub', async () => {
      const res = await request(app)
        .post('/api/v1/locations/zones')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ hubId, name: 'Zone A' });
      expect(res.status).toBe(409);
    });

    it('allows same zone name on different hubs', async () => {
      // Create another hub
      const hubRes = await request(app)
        .post('/api/v1/locations/hubs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Leeds Hub', code: 'LDS-01', address: '1 Calverley Street, Leeds' });
      const otherHubId = hubRes.body.hub.id;

      const res = await request(app)
        .post('/api/v1/locations/zones')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ hubId: otherHubId, name: 'Zone A' });
      expect(res.status).toBe(201);
    });

    it('rejects invalid hub id', async () => {
      const res = await request(app)
        .post('/api/v1/locations/zones')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ hubId: 'not-a-uuid', name: 'Bad Zone' });
      expect(res.status).toBe(400);
    });

    it('rejects non-existent hub', async () => {
      const res = await request(app)
        .post('/api/v1/locations/zones')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ hubId: '00000000-0000-0000-0000-000000000000', name: 'Ghost Zone' });
      expect(res.status).toBe(400);
    });

    it('lists zones', async () => {
      const res = await request(app)
        .get('/api/v1/locations/zones')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.zones.length).toBeGreaterThanOrEqual(1);
    });

    it('updates a zone', async () => {
      const res = await request(app)
        .put(`/api/v1/locations/zones/${zoneId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ description: 'Updated description' });
      expect(res.status).toBe(200);
      expect(res.body.zone.description).toBe('Updated description');
    });

    it('soft-deletes a zone', async () => {
      const res = await request(app)
        .delete(`/api/v1/locations/zones/${zoneId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.zone.isActive).toBe(false);
    });

    it('returns 404 for non-existent zone', async () => {
      const res = await request(app)
        .put('/api/v1/locations/zones/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Nope' });
      expect(res.status).toBe(404);
    });
  });

  // ── Public endpoints ─────────────────────────────────────────────────────

  describe('public endpoints', () => {
    let hubId: string;
    let pickupId: string;
    let zoneId: string;

    beforeAll(async () => {
      // Create test data
      const hubRes = await request(app)
        .post('/api/v1/locations/hubs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Public Hub', code: 'PUB-01', address: '1 Public Lane, London' });
      hubId = hubRes.body.hub.id;

      const pickupRes = await request(app)
        .post('/api/v1/locations/pickup-points')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ hubId, name: 'Public Pickup', address: '2 Public Road, London' });
      pickupId = pickupRes.body.pickupLocation.id;

      const zoneRes = await request(app)
        .post('/api/v1/locations/zones')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ hubId, name: 'Bravo Zone', description: 'Zone B area' });
      zoneId = zoneRes.body.zone.id;
    });

    it('public hubs returns active hubs without auth', async () => {
      const res = await request(app).get('/api/v1/locations/public/hubs');
      expect(res.status).toBe(200);
      expect(res.body.hubs.length).toBeGreaterThanOrEqual(1);
      const publicHub = res.body.hubs.find((h: { id: string }) => h.id === hubId);
      expect(publicHub).toBeDefined();
      expect(publicHub).toHaveProperty('name');
      expect(publicHub).toHaveProperty('code');
      expect(publicHub).toHaveProperty('address');
      // Should not expose internal fields
      expect(publicHub).not.toHaveProperty('isActive');
      expect(publicHub).not.toHaveProperty('createdAt');
    });

    it('public pickup-points returns active pickup locations', async () => {
      const res = await request(app).get('/api/v1/locations/public/pickup-points');
      expect(res.status).toBe(200);
      expect(res.body.pickupLocations.length).toBeGreaterThanOrEqual(1);
      const publicPickup = res.body.pickupLocations.find(
        (p: { id: string }) => p.id === pickupId,
      );
      expect(publicPickup).toBeDefined();
      expect(publicPickup).toHaveProperty('name');
      expect(publicPickup).toHaveProperty('address');
      expect(publicPickup).toHaveProperty('hubId');
      expect(publicPickup).not.toHaveProperty('isActive');
    });

    it('public zones returns active zones sorted alphabetically', async () => {
      const res = await request(app).get('/api/v1/locations/public/zones');
      expect(res.status).toBe(200);
      expect(res.body.zones.length).toBeGreaterThanOrEqual(1);
      const publicZone = res.body.zones.find((z: { id: string }) => z.id === zoneId);
      expect(publicZone).toBeDefined();
      expect(publicZone).toHaveProperty('name');
      expect(publicZone).toHaveProperty('description');
      expect(publicZone).not.toHaveProperty('isActive');

      // Verify alphabetical order
      const names = res.body.zones.map((z: { name: string }) => z.name);
      expect(names).toEqual([...names].sort());
    });

    it('public endpoints exclude inactive records', async () => {
      // Delete the hub
      await request(app)
        .delete(`/api/v1/locations/hubs/${hubId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      const res = await request(app).get('/api/v1/locations/public/hubs');
      const deleted = res.body.hubs.find((h: { id: string }) => h.id === hubId);
      expect(deleted).toBeUndefined();
    });
  });
});
