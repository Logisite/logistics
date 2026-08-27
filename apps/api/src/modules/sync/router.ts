import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../../shared/db.js';
import { badRequest } from '../../shared/errors.js';
import { requireAuth } from '../auth/middleware.js';

import * as service from './service.js';
import { defineRoute } from '../../openapi/registry.js';

const pushSchema = z.object({
  deviceId: z.string().uuid(),
  ops: z.array(z.object({ seq: z.number().int().min(0), opId: z.string().uuid(), action: z.string(), entity: z.string(), entityId: z.string().uuid().optional(), payload: z.unknown() })).min(1),
}).openapi('SyncPushRequest');

defineRoute({ method: 'post', path: '/sync/push', request: { body: { content: { 'application/json': { schema: pushSchema } } } }, responses: { 200: { description: 'Push results', content: { 'application/json': { schema: z.object({ results: z.array(z.object({ seq: z.number(), opId: z.string(), status: z.string() })) }).openapi('SyncPushResponse') } } } } });
defineRoute({ method: 'get', path: '/sync/pending/{deviceId}', request: { params: z.object({ deviceId: z.string().uuid() }) }, responses: { 200: { description: 'Pending operations', content: { 'application/json': { schema: z.object({ ops: z.array(z.object({ id: z.string(), deviceId: z.string(), seq: z.number(), opId: z.string(), action: z.string(), entity: z.string(), entityId: z.string().nullable(), payload: z.unknown(), status: z.string(), createdAt: z.string() })) }).openapi('SyncPendingResponse') } } } } });
defineRoute({ method: 'get', path: '/sync/static', responses: { 200: { description: 'Static reference data', content: { 'application/json': { schema: z.object({ hubs: z.array(z.unknown()), zones: z.array(z.unknown()), pricingRules: z.array(z.unknown()), deliveryOptions: z.array(z.unknown()), version: z.string().nullable() }).openapi('SyncStaticResponse') } } } } });

export function syncRouter(db: Db): Router {
  const router = Router();

  router.post('/push', requireAuth(db), async (req, res) => {
    const input = pushSchema.parse(req.body);
    const results = await service.pushLedger(db, res.locals.auth, input.deviceId, input.ops);
    res.json({ results });
  });

  router.get('/pending/:deviceId', requireAuth(db), async (req, res) => {
    const deviceId = req.params.deviceId as string;
    if (!deviceId) throw badRequest('VALIDATION', 'Missing deviceId');
    const since = Number(req.query.since ?? -1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
    res.json({ ops: await service.getPending(db, res.locals.auth, deviceId, since, limit) });
  });

  router.get('/static', requireAuth(db), async (_req, res) => {
    res.json(await service.getStaticRefs(db));
  });

  return router;
}
