import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../../shared/db.js';
import { badRequest } from '../../shared/errors.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PERMISSIONS } from '../auth/permissions.js';

import * as service from './service.js';
import { defineRoute } from '../../openapi/registry.js';
import { parse } from '../../shared/validate.js';

const currencySchema = z.enum(['USD', 'EUR', 'GBP']);

const CodCollectionRequest = z.object({
  shipmentId: z.string().uuid(),
  driverUserId: z.string().uuid().optional(),
  amountCents: z.number().int().positive(),
  currency: currencySchema,
  paymentMethod: z.enum(['CASH', 'CARD']),
  collectedAt: z.string().datetime().optional(),
}).openapi('CodCollectionRequest');

const CodDepositRequest = z.object({
  hubId: z.string().uuid(),
  driverUserId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  currency: currencySchema,
  depositedAt: z.string().datetime().optional(),
  notes: z.string().max(1000).optional(),
}).openapi('CodDepositRequest');

const CodReconcileRequest = z.object({
  depositId: z.string().uuid(),
  collectionIds: z.array(z.string().uuid()).min(1),
}).openapi('CodReconcileRequest');

const CodSettlementRequest = z.object({
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
}).openapi('CodSettlementRequest');

const CodDisputeRequest = z.object({
  collectionId: z.string().uuid(),
  reason: z.string().min(1).max(500),
  amountCents: z.number().int().positive(),
  currency: currencySchema,
}).openapi('CodDisputeRequest');

const CodResolveRequest = z.object({ resolution: z.enum(['RESOLVED', 'REJECTED']) }).openapi('CodResolveRequest');

const CodFxRateRequest = z.object({
  fromCurrency: currencySchema,
  toCurrency: currencySchema,
  rate: z.string(),
  rateDate: z.string().datetime(),
}).openapi('CodFxRateRequest');

const CodCollectionResponse = z.object({ collection: z.object({ id: z.string().uuid(), shipmentId: z.string().uuid(), driverUserId: z.string().uuid(), amountCents: z.number().int(), currency: z.string(), paymentMethod: z.string(), status: z.string(), collectedAt: z.string().datetime(), createdAt: z.string().datetime() }) }).openapi('CodCollectionResponse');

const CodDepositResponse = z.object({ deposit: z.object({ id: z.string().uuid(), hubId: z.string().uuid(), driverUserId: z.string().uuid(), amountCents: z.number().int(), currency: z.string(), status: z.string(), depositedAt: z.string().datetime(), notes: z.string().nullable(), createdAt: z.string().datetime() }) }).openapi('CodDepositResponse');

const CodPendingResponse = z.object({ pending: z.array(z.object({ currency: z.string(), count: z.number().int(), total: z.number().int() })) }).openapi('CodPendingResponse');

const CodReconciliationResponse = z.object({ reconciliations: z.array(z.object({ id: z.string().uuid(), collectionId: z.string().uuid(), depositId: z.string().uuid(), createdAt: z.string().datetime() })) }).openapi('CodReconciliationResponse');

const CodSettlementResponse = z.object({ settlements: z.array(z.object({ id: z.string().uuid(), merchantProfileId: z.string().uuid(), amountCents: z.number().int(), currency: z.string(), status: z.string(), periodStart: z.string().datetime(), periodEnd: z.string().datetime(), createdAt: z.string().datetime() })) }).openapi('CodSettlementResponse');

const CodSettlementDetailResponse = z.object({ settlement: z.object({ id: z.string().uuid(), merchantProfileId: z.string().uuid(), amountCents: z.number().int(), currency: z.string(), status: z.string(), periodStart: z.string().datetime(), periodEnd: z.string().datetime(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }) }).openapi('CodSettlementDetailResponse');

const CodDisputeResponse = z.object({ dispute: z.object({ id: z.string().uuid(), collectionId: z.string().uuid(), reason: z.string(), amountCents: z.number().int(), currency: z.string(), status: z.string(), createdAt: z.string().datetime() }) }).openapi('CodDisputeResponse');

const CodDisputeDetailResponse = z.object({ dispute: z.object({ id: z.string().uuid(), collectionId: z.string().uuid(), reason: z.string(), amountCents: z.number().int(), currency: z.string(), status: z.string(), resolvedAt: z.string().datetime(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }) }).openapi('CodDisputeDetailResponse');

const CodFxRateResponse = z.object({ fxRate: z.object({ id: z.string().uuid(), fromCurrency: z.string(), toCurrency: z.string(), rate: z.string(), rateDate: z.string().datetime(), createdAt: z.string().datetime() }) }).openapi('CodFxRateResponse');

defineRoute({ method: 'post', path: '/cod/collections', summary: 'Record COD collection', request: { body: { content: { 'application/json': { schema: CodCollectionRequest } } } }, responses: { 201: { description: 'Collection recorded', content: { 'application/json': { schema: CodCollectionResponse } } } } });
defineRoute({ method: 'post', path: '/cod/deposits', summary: 'Record COD deposit', request: { body: { content: { 'application/json': { schema: CodDepositRequest } } } }, responses: { 201: { description: 'Deposit recorded', content: { 'application/json': { schema: CodDepositResponse } } } } });
defineRoute({ method: 'get', path: '/cod/pending', summary: 'Get pending COD summary', responses: { 200: { description: 'Pending summary', content: { 'application/json': { schema: CodPendingResponse } } } } });
defineRoute({ method: 'post', path: '/cod/reconciliations', summary: 'Reconcile deposits with collections', request: { body: { content: { 'application/json': { schema: CodReconcileRequest } } } }, responses: { 201: { description: 'Reconciliations created', content: { 'application/json': { schema: CodReconciliationResponse } } } } });
defineRoute({ method: 'post', path: '/cod/settlements/compute', summary: 'Compute settlements for period', request: { body: { content: { 'application/json': { schema: CodSettlementRequest } } } }, responses: { 201: { description: 'Settlements computed', content: { 'application/json': { schema: CodSettlementResponse } } } } });
defineRoute({ method: 'patch', path: '/cod/settlements/{id}/settle', summary: 'Mark settlement as settled', request: { params: z.object({ id: z.string().uuid() }) }, responses: { 200: { description: 'Settlement updated', content: { 'application/json': { schema: CodSettlementDetailResponse } } } } });
defineRoute({ method: 'post', path: '/cod/disputes', summary: 'Open COD dispute', request: { body: { content: { 'application/json': { schema: CodDisputeRequest } } } }, responses: { 201: { description: 'Dispute opened', content: { 'application/json': { schema: CodDisputeResponse } } } } });
defineRoute({ method: 'patch', path: '/cod/disputes/{id}/resolve', summary: 'Resolve COD dispute', request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: CodResolveRequest } } } }, responses: { 200: { description: 'Dispute resolved', content: { 'application/json': { schema: CodDisputeDetailResponse } } } } });
defineRoute({ method: 'post', path: '/cod/fx-rates', summary: 'Add FX exchange rate', request: { body: { content: { 'application/json': { schema: CodFxRateRequest } } } }, responses: { 201: { description: 'FX rate added', content: { 'application/json': { schema: CodFxRateResponse } } } } });

export function codRouter(db: Db): Router {
  const router = Router();

  const record = [requireAuth(db), requirePermission(PERMISSIONS.COD_RECORD)];
  const manage = [requireAuth(db), requirePermission(PERMISSIONS.COD_MANAGE)];

  router.post('/collections', ...record, async (req, res) => {
    res.status(201).json({ collection: await service.recordCollection(db, res.locals.auth, parse(CodCollectionRequest, req.body)) });
  });

  router.post('/deposits', ...record, async (req, res) => {
    res.status(201).json({ deposit: await service.recordDeposit(db, res.locals.auth, parse(CodDepositRequest, req.body)) });
  });

  router.get('/pending', ...record, async (_req, res) => {
    res.json({ pending: await service.pendingSummary(db) });
  });

  router.post('/reconciliations', ...manage, async (req, res) => {
    const { depositId, collectionIds } = parse(CodReconcileRequest, req.body);
    res.status(201).json({ reconciliations: await service.reconcile(db, res.locals.auth, depositId, collectionIds) });
  });

  router.post('/settlements/compute', ...manage, async (req, res) => {
    const { periodStart, periodEnd } = parse(CodSettlementRequest, req.body);
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
    res.status(201).json({ dispute: await service.openDispute(db, res.locals.auth, parse(CodDisputeRequest, req.body)) });
  });

  router.patch('/disputes/:id/resolve', ...manage, async (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string') throw badRequest('VALIDATION', 'Invalid dispute id');
    const { resolution } = parse(CodResolveRequest, req.body);
    res.json({ dispute: await service.resolveDispute(db, res.locals.auth, id, resolution) });
  });

  router.post('/fx-rates', ...manage, async (req, res) => {
    res.status(201).json({ fxRate: await service.addFxRate(db, res.locals.auth, parse(CodFxRateRequest, req.body)) });
  });

  return router;
}
