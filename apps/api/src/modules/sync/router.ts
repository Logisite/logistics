import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../../shared/db.js';
import { parse } from '../../shared/validate.js';
import { requireAuth } from '../auth/middleware.js';

import * as service from './service.js';
import { defineRoute } from '../../openapi/registry.js';

const MAX_OPS_PER_PUSH = 1000;

const opSchema = z.object({
  seq: z.number().int().min(0),
  opId: z.string().uuid(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().uuid().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

const pushSchema = z
  .object({
    deviceId: z.string().uuid(),
    ops: z.array(opSchema).min(1).max(MAX_OPS_PER_PUSH),
  })
  .openapi('SyncPushRequest');

const pendingParams = z.object({ deviceId: z.string().uuid() }).openapi('SyncPendingParams');

const pendingQuery = z
  .object({
    since: z.coerce.number().int().min(-1).default(-1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .openapi('SyncPendingQuery');

defineRoute({ method: 'post', path: '/sync/push', request: { body: { content: { 'application/json': { schema: pushSchema } } } }, responses: { 200: { description: 'Push results', content: { 'application/json': { schema: z.object({ results: z.array(z.object({ seq: z.number(), opId: z.string(), status: z.string() })) }).openapi('SyncPushResponse') } } } } });
defineRoute({ method: 'get', path: '/sync/pending/{deviceId}', request: { params: pendingParams, query: pendingQuery }, responses: { 200: { description: 'Pending operations', content: { 'application/json': { schema: z.object({ ops: z.array(z.object({ id: z.string(), deviceId: z.string(), seq: z.number(), opId: z.string(), action: z.string(), entity: z.string(), entityId: z.string().nullable(), payload: z.unknown(), status: z.string(), createdAt: z.string() })) }).openapi('SyncPendingResponse') } } } } });
defineRoute({ method: 'get', path: '/sync/static', responses: { 200: { description: 'Static reference data', content: { 'application/json': { schema: z.object({ hubs: z.array(z.unknown()), zones: z.array(z.unknown()), pricingRules: z.array(z.unknown()), deliveryOptions: z.array(z.unknown()), version: z.string().nullable() }).openapi('SyncStaticResponse') } } } } });

export function syncRouter(db: Db): Router {
  const router = Router();

  router.post('/push', requireAuth(db), async (req, res) => {
    const input = parse(pushSchema, req.body);
    const results = await service.pushLedger(db, res.locals.auth, input.deviceId, input.ops);
    res.json({ results });
  });

  router.get('/pending/:deviceId', requireAuth(db), async (req, res) => {
    const { deviceId } = parse(pendingParams, req.params);
    const { since, limit } = parse(pendingQuery, req.query);
    res.json({ ops: await service.getPending(db, res.locals.auth, deviceId, since, limit) });
  });

  router.get('/static', requireAuth(db), async (_req, res) => {
    res.json(await service.getStaticRefs(db));
  });

  return router;
}