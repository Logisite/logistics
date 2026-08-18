import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/auth/seed.js';
import type { Db } from '../src/db.js';

import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

const MERCHANT_EMAIL = 'merchant@example.com';

describe('merchant profiles', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let merchantToken: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    await seedAuthData(db);
    app = createApp({ db, mailer: new FakeMailer() } satisfies AppDeps);

    await seedUserWithRoles(db, ['MERCHANT'], MERCHANT_EMAIL);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: MERCHANT_EMAIL, password: TEST_PASSWORD });
    merchantToken = loginRes.body.accessToken as string;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  describe('profile', () => {
    it('returns 404 when no profile exists', async () => {
      const res = await request(app)
        .get('/merchants/me')
        .set('Authorization', `Bearer ${merchantToken}`);
      expect(res.status).toBe(404);
    });

    it('creates a profile', async () => {
      const res = await request(app)
        .post('/merchants/me')
        .set('Authorization', `Bearer ${merchantToken}`)
        .send({
          businessName: 'Acme Corp',
          email: 'billing@acme.com',
          phone: '+1234567890',
        });
      expect(res.status).toBe(201);
      expect(res.body.profile).toMatchObject({
        businessName: 'Acme Corp',
        email: 'billing@acme.com',
        phone: '+1234567890',
      });
    });

    it('rejects duplicate profile creation', async () => {
      const res = await request(app)
        .post('/merchants/me')
        .set('Authorization', `Bearer ${merchantToken}`)
        .send({ businessName: 'Acme Corp 2' });
      expect(res.status).toBe(409);
    });

    it('reads the profile', async () => {
      const res = await request(app)
        .get('/merchants/me')
        .set('Authorization', `Bearer ${merchantToken}`);
      expect(res.status).toBe(200);
      expect(res.body.profile.businessName).toBe('Acme Corp');
    });

    it('updates the profile', async () => {
      const res = await request(app)
        .put('/merchants/me')
        .set('Authorization', `Bearer ${merchantToken}`)
        .send({ businessName: 'Acme Inc' });
      expect(res.status).toBe(200);
      expect(res.body.profile.businessName).toBe('Acme Inc');
    });
  });

  describe('auth required', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await request(app).get('/merchants/me');
      expect(res.status).toBe(401);
    });
  });
});
