import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/auth/seed.js';
import type { Db } from '../src/db.js';
import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

describe('reporting exceptions', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let app: ReturnType<typeof createApp>;
  let adminToken: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    const db: Db = testDb.db;
    await seedAuthData(db);
    app = createApp({ db, mailer: new FakeMailer() } satisfies AppDeps);
    await seedUserWithRoles(db, ['ADMIN'], 'admin-exc@example.com');
    adminToken = (await request(app).post('/api/v1/auth/login').send({ email: 'admin-exc@example.com', password: TEST_PASSWORD })).body.accessToken as string;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  it('returns agingBuckets and enforces ageDays range', async () => {
    const ok = await request(app).get('/api/v1/reports/exceptions?ageDays=14').set('Authorization', `Bearer ${adminToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.agingBuckets).toBeDefined();
    const bad = await request(app).get('/api/v1/reports/exceptions?ageDays=100').set('Authorization', `Bearer ${adminToken}`);
    expect(bad.status).toBe(400);
  });
});
