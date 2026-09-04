import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/modules/auth/seed.js';
import type { Db } from '../src/shared/db.js';
import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

describe('reporting cod', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let adminToken: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    await seedAuthData(db);
    app = createApp({ db, mailer: new FakeMailer() } satisfies AppDeps);
    await seedUserWithRoles(db, ['ADMIN'], 'admin-codrep@example.com');
    adminToken = (await request(app).post('/api/v1/auth/login').send({ email: 'admin-codrep@example.com', password: TEST_PASSWORD })).body.accessToken as string;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  it('returns unreconciled and shortfall', async () => {
    const r = await request(app).get('/api/v1/reports/cod').set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.unreconciled).toBeDefined();
    expect(typeof r.body.unreconciled.count).toBe('number');
    expect(typeof r.body.shortfall).toBe('number');
  });

  it('period filter isolates window', async () => {
    const r = await request(app).get('/api/v1/reports/cod?periodStart=2000-01-01T00:00:00.000Z&periodEnd=2000-01-02T00:00:00.000Z').set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.collections).toEqual([]);
  });
});
