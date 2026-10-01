import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';

import { createApp } from '../src/app.js';
import { defineRoute } from '../src/openapi/registry.js';
import { seedAuthData } from '../src/modules/auth/seed.js';
import type { Db } from '../src/shared/db.js';

import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';

// A route whose declared schema is deliberately narrower than what the handler
// returns, so the projection has something to strip.
const NarrowResponse = z
  .object({ visible: z.string() })
  .openapi('ProjectionProbeResponse');

defineRoute({
  method: 'get',
  path: '/projection-probe',
  security: [],
  responses: {
    200: {
      description: 'probe',
      content: { 'application/json': { schema: NarrowResponse } },
    },
  },
});

describe('response projection (ADR 0016 §1)', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    await seedAuthData(db);
    app = createApp({ db, mailer: new FakeMailer() });

    // Mounted after createApp, so it exercises the same middleware chain the real
    // routers run through. The handler returns three fields; the contract declares one.
    app.get('/api/v1/projection-probe', (_req, res) => {
      res.status(200).json({
        visible: 'yes',
        senderEmail: 'leak@example.com',
        quoteSnapshot: { totalAmountCents: 1500 },
      });
    });
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  it('strips a field the route never declared', async () => {
    const r = await request(app).get('/api/v1/projection-probe');

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ visible: 'yes' });
    expect(r.body).not.toHaveProperty('senderEmail');
    expect(r.body).not.toHaveProperty('quoteSnapshot');
  });

  it('leaves a real route projecting its declared shape', async () => {
    const r = await request(app).get('/api/v1/health');

    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['sha', 'status', 'version']);
  });
});