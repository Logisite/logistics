import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/auth/seed.js';
import type { Db } from '../src/db.js';

import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

const CUSTOMER_EMAIL = 'customer@example.com';
const OTHER_EMAIL = 'other@example.com';

describe('customer profiles', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let customerToken: string;
  let otherToken: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    await seedAuthData(db);
    app = createApp({ db, mailer: new FakeMailer() } satisfies AppDeps);

    const customer = await seedUserWithRoles(db, ['CUSTOMER'], CUSTOMER_EMAIL);
    const other = await seedUserWithRoles(db, ['CUSTOMER'], OTHER_EMAIL);

    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: CUSTOMER_EMAIL, password: TEST_PASSWORD });
    customerToken = loginRes.body.accessToken as string;

    const otherLoginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: OTHER_EMAIL, password: TEST_PASSWORD });
    otherToken = otherLoginRes.body.accessToken as string;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------

  describe('profile', () => {
    it('returns 404 when no profile exists', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(404);
    });

    it('creates a profile', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ phone: '+1234567890' });
      expect(res.status).toBe(201);
      expect(res.body.profile).toMatchObject({
        phone: '+1234567890',
      });
      expect(res.body.profile.id).toBeDefined();
    });

    it('rejects duplicate profile creation', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ phone: '+0000000000' });
      expect(res.status).toBe(409);
    });

    it('reads the profile', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.profile.phone).toBe('+1234567890');
    });

    it('updates the profile', async () => {
      const res = await request(app)
        .put('/api/v1/customers/me')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ phone: '+9999999999' });
      expect(res.status).toBe(200);
      expect(res.body.profile.phone).toBe('+9999999999');
    });
  });

  // ---------------------------------------------------------------------------
  // Addresses
  // ---------------------------------------------------------------------------

  describe('addresses', () => {
    let addressId: string;

    it('returns empty list initially', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/addresses')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.addresses).toEqual([]);
    });

    it('creates an address', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          label: 'Home',
          line1: '123 Main St',
          city: 'Lagos',
          isDefault: true,
        });
      expect(res.status).toBe(201);
      expect(res.body.address).toMatchObject({
        label: 'Home',
        line1: '123 Main St',
        city: 'Lagos',
        isDefault: true,
      });
      addressId = res.body.address.id;
    });

    it('lists addresses', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/addresses')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.addresses).toHaveLength(1);
    });

    it('updates an address', async () => {
      const res = await request(app)
        .put(`/api/v1/customers/me/addresses/${addressId}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ line1: '456 New St' });
      expect(res.status).toBe(200);
      expect(res.body.address.line1).toBe('456 New St');
    });

    it('clears previous default when setting new default', async () => {
      const createRes = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          label: 'Office',
          line1: '789 Corp Ave',
          city: 'Lagos',
          isDefault: true,
        });
      expect(createRes.status).toBe(201);

      const listRes = await request(app)
        .get('/api/v1/customers/me/addresses')
        .set('Authorization', `Bearer ${customerToken}`);
      const defaults = listRes.body.addresses.filter((a: { isDefault: boolean }) => a.isDefault);
      expect(defaults).toHaveLength(1);
    });

    it('rejects updates to other users addresses', async () => {
      const res = await request(app)
        .put(`/api/v1/customers/me/addresses/${addressId}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ line1: 'Hacked' });
      expect(res.status).toBe(404);
    });

    it('deletes an address', async () => {
      const res = await request(app)
        .delete(`/api/v1/customers/me/addresses/${addressId}`)
        .set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(204);

      const listRes = await request(app)
        .get('/api/v1/customers/me/addresses')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(listRes.body.addresses).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Emergency contacts
  // ---------------------------------------------------------------------------

  describe('emergency contacts', () => {
    let contactId: string;

    it('returns empty list initially', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/emergency-contacts')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.emergencyContacts).toEqual([]);
    });

    it('creates a contact', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/emergency-contacts')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          name: 'Jane Doe',
          phone: '+0987654321',
          relationship: 'spouse',
        });
      expect(res.status).toBe(201);
      expect(res.body.contact).toMatchObject({
        name: 'Jane Doe',
        phone: '+0987654321',
        relationship: 'spouse',
      });
      contactId = res.body.contact.id;
    });

    it('lists contacts', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/emergency-contacts')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.emergencyContacts).toHaveLength(1);
    });

    it('updates a contact', async () => {
      const res = await request(app)
        .put(`/api/v1/customers/me/emergency-contacts/${contactId}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ phone: '+111222333' });
      expect(res.status).toBe(200);
      expect(res.body.contact.phone).toBe('+111222333');
    });

    it('rejects updates to other users contacts', async () => {
      const res = await request(app)
        .put(`/api/v1/customers/me/emergency-contacts/${contactId}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ name: 'Hacked' });
      expect(res.status).toBe(404);
    });

    it('deletes a contact', async () => {
      const res = await request(app)
        .delete(`/api/v1/customers/me/emergency-contacts/${contactId}`)
        .set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(204);

      const listRes = await request(app)
        .get('/api/v1/customers/me/emergency-contacts')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(listRes.body.emergencyContacts).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Auth required
  // ---------------------------------------------------------------------------

  describe('auth required', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/customers/me');
      expect(res.status).toBe(401);
    });
  });
});
