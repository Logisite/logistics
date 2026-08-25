import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../../db.js';
import { badRequest, forbidden } from '../../errors.js';
import type { AuthContext } from '../../auth/middleware.js';
import { requireAuth, requirePermission } from '../../auth/middleware.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import { parse } from '../../validate.js';

import * as service from './service.js';

const createRunSchema = z.object({
  hubId: z.string().uuid().optional(),
  driverUserId: z.string().uuid(),
  scheduledDate: z.string().datetime().optional(),
  shipments: z.array(z.object({ shipmentId: z.string().uuid(), sequence: z.number().int().min(0) })).min(1),
});

const claimSchema = z.object({
  hubId: z.string().uuid().optional(),
  shipmentIds: z.array(z.string().uuid()).min(1),
});

function runId(req: { params: Record<string, unknown> }): string {
  const id = req.params.id;
  if (typeof id !== 'string') throw badRequest('VALIDATION', 'Invalid run id');
  return id;
}

export function operationsRouter(db: Db): Router {
  const router = Router();

  const manage = [requireAuth(db), requirePermission(PERMISSIONS.RUNS_MANAGE)];

  router.post('/', ...manage, async (req, res) => {
    const input = parse(createRunSchema, req.body);
    const run = await service.createRun(db, res.locals.auth as AuthContext, input);
    res.status(201).json({ run });
  });

  router.post('/claim', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    if (!ctx.permissions.has(PERMISSIONS.RUNS_MANAGE)) throw forbidden('FORBIDDEN', 'Not allowed to claim runs');
    const input = parse(claimSchema, req.body);
    const shipments = input.shipmentIds.map((id: string, i: number) => ({ shipmentId: id, sequence: i }));
    const run = await service.createRun(db, ctx, { hubId: input.hubId, driverUserId: ctx.userId, shipments });
    res.status(201).json({ run });
  });

  router.post('/:id/start', ...manage, async (req, res) => {
    const run = await service.startRun(db, res.locals.auth as AuthContext, runId(req));
    res.json({ run });
  });

  router.post('/:id/complete', ...manage, async (req, res) => {
    const run = await service.completeRun(db, res.locals.auth as AuthContext, runId(req));
    res.json({ run });
  });

  router.post('/:id/cancel', ...manage, async (req, res) => {
    const run = await service.cancelRun(db, res.locals.auth as AuthContext, runId(req));
    res.json({ run });
  });

  router.get('/mine', requireAuth(db), async (req, res) => {
    res.json({ runs: await service.getMyRuns(db, res.locals.auth as AuthContext) });
  });

  router.get('/:id', requireAuth(db), async (req, res) => {
    res.json(await service.getRunSheet(db, res.locals.auth as AuthContext, runId(req)));
  });

  const gpsSchema = z.object({
    positions: z
      .array(z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), recordedAt: z.string().datetime().optional() }))
      .min(1)
      .max(100),
  });
  router.post('/:id/gps', requireAuth(db), async (req, res) => {
    const input = parse(gpsSchema, req.body);
    res.json({ inserted: await service.pushGps(db, res.locals.auth as AuthContext, runId(req), input.positions) });
  });

  return router;
}
