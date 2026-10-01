import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../../shared/db.js';
import { forbidden } from '../../shared/errors.js';
import type { AuthContext } from '../auth/middleware.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { parse } from '../../shared/validate.js';
import { logger } from '../../shared/logger.js';

import * as service from './service.js';
import { defineRoute } from '../../openapi/registry.js';

const CreateRunRequest = z.object({
  hubId: z.string().uuid().optional(),
  driverUserId: z.string().uuid(),
  scheduledDate: z.string().datetime().optional(),
  shipments: z.array(z.object({ shipmentId: z.string().uuid(), sequence: z.number().int().min(0) })).min(1),
}).openapi('CreateRunRequest');

const ClaimRunRequest = z.object({
  hubId: z.string().uuid().optional(),
  shipmentIds: z.array(z.string().uuid()).min(1),
}).openapi('ClaimRunRequest');

const GpsPushRequest = z.object({
  positions: z
    .array(z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), recordedAt: z.string().datetime().optional() }))
    .min(1)
    .max(100),
}).openapi('GpsPushRequest');

const RunResponse = z.object({ run: z.object({ id: z.string().uuid(), hubId: z.string().uuid().nullable(), driverUserId: z.string().uuid(), status: z.string(), scheduledDate: z.string().datetime().nullable(), startedAt: z.string().datetime().nullable(), endedAt: z.string().datetime().nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }) }).openapi('RunResponse');

const RunListResponse = z.object({ runs: z.array(z.object({ id: z.string().uuid(), hubId: z.string().uuid().nullable(), driverUserId: z.string().uuid(), status: z.string(), scheduledDate: z.string().datetime().nullable(), startedAt: z.string().datetime().nullable(), endedAt: z.string().datetime().nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() })) }).openapi('RunListResponse');

const RunSheetEntrySchema = z.object({ id: z.string().uuid(), runId: z.string().uuid(), shipmentId: z.string().uuid(), sequence: z.number() });

const RunSheetResponse = z.object({ run: z.object({ id: z.string().uuid(), hubId: z.string().uuid().nullable(), driverUserId: z.string().uuid(), status: z.string(), scheduledDate: z.string().datetime().nullable(), startedAt: z.string().datetime().nullable(), endedAt: z.string().datetime().nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }), entries: z.array(z.object({ entry: RunSheetEntrySchema, shipment: z.object({ id: z.string().uuid(), status: z.string() }).nullable() })) }).openapi('RunSheetResponse');

const GpsInsertResponse = z.object({ inserted: z.number() }).openapi('GpsInsertResponse');

const IdParam = z.object({ id: z.string().uuid() });

defineRoute({ method: 'post', path: '/runs', request: { body: { content: { 'application/json': { schema: CreateRunRequest } } } }, responses: { 201: { description: 'Run created', content: { 'application/json': { schema: RunResponse } } } } });
defineRoute({ method: 'post', path: '/runs/claim', request: { body: { content: { 'application/json': { schema: ClaimRunRequest } } } }, responses: { 201: { description: 'Run claimed', content: { 'application/json': { schema: RunResponse } } } } });
defineRoute({ method: 'post', path: '/runs/{id}/start', request: { params: IdParam }, responses: { 200: { description: 'Run started', content: { 'application/json': { schema: RunResponse } } } } });
defineRoute({ method: 'post', path: '/runs/{id}/complete', request: { params: IdParam }, responses: { 200: { description: 'Run completed', content: { 'application/json': { schema: RunResponse } } } } });
defineRoute({ method: 'post', path: '/runs/{id}/cancel', request: { params: IdParam }, responses: { 200: { description: 'Run cancelled', content: { 'application/json': { schema: RunResponse } } } } });
defineRoute({ method: 'get', path: '/runs/mine', responses: { 200: { description: 'My runs', content: { 'application/json': { schema: RunListResponse } } } } });
defineRoute({ method: 'get', path: '/runs/{id}', request: { params: IdParam }, responses: { 200: { description: 'Run sheet', content: { 'application/json': { schema: RunSheetResponse } } } } });
defineRoute({ method: 'post', path: '/runs/{id}/gps', request: { params: IdParam, body: { content: { 'application/json': { schema: GpsPushRequest } } } }, responses: { 200: { description: 'GPS positions inserted', content: { 'application/json': { schema: GpsInsertResponse } } } } });

function runId(req: { params: Record<string, unknown> }): string {
  return parse(IdParam, req.params).id;
}

export function operationsRouter(db: Db): Router {
  const router = Router();

  const manage = [requireAuth(db), requirePermission(PERMISSIONS.RUNS_MANAGE)];

  router.post('/', ...manage, async (req, res) => {
    const input = parse(CreateRunRequest, req.body);
    const run = await service.createRun(db, res.locals.auth as AuthContext, input);
    res.status(201).json({ run });
  });

  router.post('/claim', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    if (!ctx.permissions.has(PERMISSIONS.RUNS_MANAGE)) {
      logger.warn({ actorUserId: ctx.userId, actorRole: ctx.roleName }, 'operations.run-claim-denied');
      throw forbidden('FORBIDDEN', 'Not allowed to claim runs');
    }
    const input = parse(ClaimRunRequest, req.body);
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

  router.post('/:id/gps', requireAuth(db), async (req, res) => {
    const input = parse(GpsPushRequest, req.body);
    res.json({ inserted: await service.pushGps(db, res.locals.auth as AuthContext, runId(req), input.positions) });
  });

  return router;
}
