import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../../db.js';
import { badRequest } from '../../errors.js';
import { requireAuth } from '../../auth/middleware.js';

import * as service from './service.js';

const pushSchema = z.object({
  deviceId: z.string().uuid(),
  ops: z.array(z.object({ seq: z.number().int().min(0), opId: z.string().uuid(), action: z.string(), entity: z.string(), entityId: z.string().uuid().optional(), payload: z.unknown() })).min(1),
});

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

  router.get('/deltas/:deviceId', requireAuth(db), async (req, res) => {
    const deviceId = req.params.deviceId as string;
    const since = Number(req.query.since ?? -1);
    res.json(await service.getDeltas(db, res.locals.auth, deviceId, since));
  });

  router.get('/static', requireAuth(db), async (_req, res) => {
    res.json(await service.getStaticRefs(db));
  });

  return router;
}
