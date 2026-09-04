import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/modules/auth/seed.js';
import type { Db } from '../src/shared/db.js';
import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

describe('reporting drivers', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let app: ReturnType<typeof createApp>;
  let adminToken: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    const db: Db = testDb.db;
    await seedAuthData(db);
    app = createApp({ db, mailer: new FakeMailer() } satisfies AppDeps);
    await seedUserWithRoles(db, ['ADMIN'], 'admin-drv@example.com');
    adminToken = (await request(app).post('/api/v1/auth/login').send({ email: 'admin-drv@example.com', password: TEST_PASSWORD })).body.accessToken as string;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  it('returns driver performance with period filter', async () => {
    const ok = await request(app).get('/api/v1/reports/drivers').set('Authorization', `Bearer ${adminToken}`);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.data)).toBe(true);
    const filtered = await request(app).get('/api/v1/reports/drivers?periodStart=2000-01-01T00:00:00.000Z&periodEnd=2000-01-02T00:00:00.000Z').set('Authorization', `Bearer ${adminToken}`);
    expect(filtered.status).toBe(200);
  });
});
