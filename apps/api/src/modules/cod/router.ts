import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../../db.js';
import { badRequest } from '../../errors.js';
import { requireAuth, requirePermission } from '../../auth/middleware.js';
import { PERMISSIONS } from '../../auth/permissions.js';

import * as service from './service.js';
import { defineRoute } from '../../openapi/registry.js';

const currencySchema = z.enum(['USD', 'EUR', 'GBP']);

const collectionSchema = z.object({
  shipmentId: z.string().uuid(),
  driverUserId: z.string().uuid().optional(),
  amountCents: z.number().int().positive(),
  currency: currencySchema,
  paymentMethod: z.enum(['CASH', 'CARD']),
  collectedAt: z.string().datetime().optional(),
});

const depositSchema = z.object({
  hubId: z.string().uuid(),
  driverUserId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  currency: currencySchema,
  depositedAt: z.string().datetime().optional(),
  notes: z.string().max(1000).optional(),
});

const reconcileSchema = z.object({
  depositId: z.string().uuid(),
  collectionIds: z.array(z.string().uuid()).min(1),
});

const settlementSchema = z.object({
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
});

const disputeSchema = z.object({
  collectionId: z.string().uuid(),
  reason: z.string().min(1).max(500),
  amountCents: z.number().int().positive(),
  currency: currencySchema,
});

const resolveSchema = z.object({ resolution: z.enum(['RESOLVED', 'REJECTED']) });

const fxRateSchema = z.object({
  fromCurrency: currencySchema,
  toCurrency: currencySchema,
  rate: z.string(),
  rateDate: z.string().datetime(),
});

defineRoute({ method: 'post', path: '/cod/collections', request: { body: { content: { 'application/json': { schema: collectionSchema } } } }, responses: { 201: { description: 'created' }, 401: { description: 'unauthorized' }, 403: { description: 'forbidden' } } });
defineRoute({ method: 'post', path: '/cod/deposits', request: { body: { content: { 'application/json': { schema: depositSchema } } } }, responses: { 201: { description: 'created' } } });
defineRoute({ method: 'get', path: '/cod/pending', responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'post', path: '/cod/reconciliations', request: { body: { content: { 'application/json': { schema: reconcileSchema } } } }, responses: { 201: { description: 'created' } } });
defineRoute({ method: 'post', path: '/cod/settlements/compute', request: { body: { content: { 'application/json': { schema: settlementSchema } } } }, responses: { 201: { description: 'created' } } });
defineRoute({ method: 'patch', path: '/cod/settlements/{id}/settle', request: { params: z.object({ id: z.string().uuid() }) }, responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'post', path: '/cod/disputes', request: { body: { content: { 'application/json': { schema: disputeSchema } } } }, responses: { 201: { description: 'created' } } });
defineRoute({ method: 'patch', path: '/cod/disputes/{id}/resolve', request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: resolveSchema } } } }, responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'post', path: '/cod/fx-rates', request: { body: { content: { 'application/json': { schema: fxRateSchema } } } }, responses: { 201: { description: 'created' } } });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw badRequest('VALIDATION', 'Invalid request payload');
  return result.data;
}

export function codRouter(db: Db): Router {
  const router = Router();

  const record = [requireAuth(db), requirePermission(PERMISSIONS.COD_RECORD)];
  const manage = [requireAuth(db), requirePermission(PERMISSIONS.COD_MANAGE)];

  router.post('/collections', ...record, async (req, res) => {
    res.status(201).json({ collection: await service.recordCollection(db, res.locals.auth, parse(collectionSchema, req.body)) });
  });

  router.post('/deposits', ...record, async (req, res) => {
    res.status(201).json({ deposit: await service.recordDeposit(db, res.locals.auth, parse(depositSchema, req.body)) });
  });

  router.get('/pending', ...record, async (_req, res) => {
    res.json({ pending: await service.pendingSummary(db) });
  });

  router.post('/reconciliations', ...manage, async (req, res) => {
    const { depositId, collectionIds } = parse(reconcileSchema, req.body);
    res.status(201).json({ reconciliations: await service.reconcile(db, res.locals.auth, depositId, collectionIds) });
  });

  router.post('/settlements/compute', ...manage, async (req, res) => {
    const { periodStart, periodEnd } = parse(settlementSchema, req.body);
    const settlements = await service.computeSettlements(
      db,
      res.locals.auth,
      new Date(periodStart),
      new Date(periodEnd),
    );
    res.status(201).json({ settlements });
  });

  router.patch('/settlements/:id/settle', ...manage, async (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string') throw badRequest('VALIDATION', 'Invalid settlement id');
    res.json({ settlement: await service.markSettled(db, res.locals.auth, id) });
  });

  router.post('/disputes', ...manage, async (req, res) => {
    res.status(201).json({ dispute: await service.openDispute(db, res.locals.auth, parse(disputeSchema, req.body)) });
  });

  router.patch('/disputes/:id/resolve', ...manage, async (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string') throw badRequest('VALIDATION', 'Invalid dispute id');
    const { resolution } = parse(resolveSchema, req.body);
    res.json({ dispute: await service.resolveDispute(db, res.locals.auth, id, resolution) });
  });

  router.post('/fx-rates', ...manage, async (req, res) => {
    res.status(201).json({ fxRate: await service.addFxRate(db, res.locals.auth, parse(fxRateSchema, req.body)) });
  });

  return router;
}
