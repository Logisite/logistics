import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../../db.js';
import { requireAuth, requirePermission } from '../../auth/middleware.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import { parse } from '../../validate.js';

import * as service from './service.js';

export function reportingRouter(db: Db): Router {
  const router = Router();
  const admin = [requireAuth(db), requirePermission(PERMISSIONS.AUDIT_READ)];

  const revenueQuery = z
    .object({ from: z.string().datetime().optional(), to: z.string().datetime().optional(), zoneId: z.string().uuid().optional(), route: z.string().uuid().optional() })
    .refine((v) => !v.from || !v.to || new Date(v.from).getTime() <= new Date(v.to).getTime(), { message: 'from must be before to', path: ['from'] });
  router.get('/revenue', ...admin, async (req, res) => {
    const q = parse(revenueQuery, req.query);
    res.json({ data: await service.revenueVolume(db, q.from, q.to, q.zoneId, q.route) });
  });

  const codQuery = z
    .object({ periodStart: z.string().datetime().optional(), periodEnd: z.string().datetime().optional() })
    .refine((v) => !v.periodStart || !v.periodEnd || new Date(v.periodStart).getTime() <= new Date(v.periodEnd).getTime(), { message: 'periodStart must be before periodEnd', path: ['periodStart'] });
  router.get('/cod', ...admin, async (req, res) => {
    const q = parse(codQuery, req.query);
    res.json(await service.codReconciliationReport(db, q.periodStart, q.periodEnd));
  });

  const driversQuery = z.object({ periodStart: z.string().datetime().optional(), periodEnd: z.string().datetime().optional() });
  router.get('/drivers', ...admin, async (req, res) => {
    const q = parse(driversQuery, req.query);
    res.json({ data: await service.driverPerformance(db, q.periodStart, q.periodEnd) });
  });

  const exQuery = z.object({ ageDays: z.coerce.number().int().min(1).max(90).optional() });
  router.get('/exceptions', ...admin, async (req, res) => {
    const q = parse(exQuery, req.query);
    const ageDays = q.ageDays ?? 7;
    res.json(await service.exceptionsAging(db, ageDays));
  });

  return router;
}
