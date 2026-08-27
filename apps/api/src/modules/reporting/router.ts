import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../../shared/db.js';
import { requireAuth, requirePermission } from '../../auth/middleware.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import { parse } from '../../shared/validate.js';

import * as service from './service.js';
import { defineRoute } from '../../openapi/registry.js';

const revenueQuery = z
  .object({ from: z.string().datetime().optional(), to: z.string().datetime().optional(), zoneId: z.string().uuid().optional(), route: z.string().uuid().optional() })
  .refine((v) => !v.from || !v.to || new Date(v.from).getTime() <= new Date(v.to).getTime(), { message: 'from must be before to', path: ['from'] })
  .openapi('RevenueQuery');
const codQuery = z
  .object({ periodStart: z.string().datetime().optional(), periodEnd: z.string().datetime().optional() })
  .refine((v) => !v.periodStart || !v.periodEnd || new Date(v.periodStart).getTime() <= new Date(v.periodEnd).getTime(), { message: 'periodStart must be before periodEnd', path: ['periodStart'] })
  .openapi('CodReportQuery');
const driversQuery = z.object({ periodStart: z.string().datetime().optional(), periodEnd: z.string().datetime().optional() }).openapi('DriversQuery');
const exQuery = z.object({ ageDays: z.coerce.number().int().min(1).max(90).optional() }).openapi('ExceptionsQuery');
defineRoute({ method: 'get', path: '/reports/revenue', request: { query: revenueQuery }, responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({ data: z.array(z.object({ currency: z.string(), count: z.number(), totalMinor: z.number(), functionalCurrency: z.string(), functionalTotalMinor: z.number() })) }).openapi('RevenueResponse') } } } } });
defineRoute({ method: 'get', path: '/reports/cod', request: { query: codQuery }, responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({ collections: z.array(z.object({ currency: z.string(), count: z.number(), total: z.number() })), reconciliations: z.number(), settlements: z.number(), unreconciled: z.object({ count: z.number(), totalFunctionalMinor: z.number() }), shortfall: z.number(), functionalCurrency: z.string() }).openapi('CodReportResponse') } } } } });
defineRoute({ method: 'get', path: '/reports/drivers', request: { query: driversQuery }, responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({ data: z.array(z.object({ driverUserId: z.string().uuid().nullable(), deliveries: z.number(), failedAttempts: z.number(), returns: z.number(), avgSeconds: z.number().nullable() })) }).openapi('DriversResponse') } } } } });
defineRoute({ method: 'get', path: '/reports/exceptions', request: { query: exQuery }, responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({ stuck: z.array(z.object({ shipmentId: z.string().uuid(), status: z.string(), ageDays: z.number() })), failedAttempts: z.number(), returned: z.number(), agingBuckets: z.object({ '7-14': z.number(), '14-30': z.number(), '30+': z.number() }), ageDays: z.number() }).openapi('ExceptionsResponse') } } } } });

export function reportingRouter(db: Db): Router {
  const router = Router();
  const admin = [requireAuth(db), requirePermission(PERMISSIONS.AUDIT_READ)];

  router.get('/revenue', ...admin, async (req, res) => {
    const q = parse(revenueQuery, req.query);
    res.json({ data: await service.revenueVolume(db, q.from, q.to, q.zoneId, q.route) });
  });

  router.get('/cod', ...admin, async (req, res) => {
    const q = parse(codQuery, req.query);
    res.json(await service.codReconciliationReport(db, q.periodStart, q.periodEnd));
  });

  router.get('/drivers', ...admin, async (req, res) => {
    const q = parse(driversQuery, req.query);
    res.json({ data: await service.driverPerformance(db, q.periodStart, q.periodEnd) });
  });

  router.get('/exceptions', ...admin, async (req, res) => {
    const q = parse(exQuery, req.query);
    const ageDays = q.ageDays ?? 7;
    res.json(await service.exceptionsAging(db, ageDays));
  });

  return router;
}
