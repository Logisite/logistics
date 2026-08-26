import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/auth/seed.js';
import type { Db } from '../src/db.js';
import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

describe('openapi', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let adminToken: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    await seedAuthData(db);
    app = createApp({ db, mailer: new FakeMailer() } satisfies AppDeps);
    await seedUserWithRoles(db, ['ADMIN'], 'admin-openapi@example.com');
    adminToken = (await request(app).post('/auth/login').send({ email: 'admin-openapi@example.com', password: TEST_PASSWORD })).body.accessToken as string;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  it('GET /openapi.json is public and valid', async () => {
    const r = await request(app).get('/openapi.json');
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe('3.1.0');
    expect(Object.keys(r.body.paths).length).toBeGreaterThanOrEqual(5);
  });

  it('GET /docs requires admin', async () => {
    const anon = await request(app).get('/docs');
    expect(anon.status).toBe(401);
    const ok = await request(app).get('/docs').set('Authorization', `Bearer ${adminToken}`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('text/html');
  });
});
