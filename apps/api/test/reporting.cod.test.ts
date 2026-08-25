import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/auth/seed.js';
import type { Db } from '../src/db.js';
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
    adminToken = (await request(app).post('/auth/login').send({ email: 'admin-codrep@example.com', password: TEST_PASSWORD })).body.accessToken as string;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  it('returns unreconciled and shortfall', async () => {
    const r = await request(app).get('/reports/cod').set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.unreconciled).toBeDefined();
    expect(r.body.shortfall).toBeDefined();
  });
});
