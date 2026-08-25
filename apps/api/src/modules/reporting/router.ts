import { Router } from 'express';

import type { Db } from '../../db.js';
import { requireAuth, requirePermission } from '../../auth/middleware.js';
import { PERMISSIONS } from '../../auth/permissions.js';

import * as service from './service.js';

export function reportingRouter(db: Db): Router {
  const router = Router();
  const admin = [requireAuth(db), requirePermission(PERMISSIONS.AUDIT_READ)];
  router.get('/revenue', ...admin, async (req, res) => {
    res.json({ data: await service.revenueVolume(db, req.query.from as string, req.query.to as string) });
  });
  router.get('/cod', ...admin, async (_req, res) => {
    res.json(await service.codReconciliationReport(db));
  });
  router.get('/drivers', ...admin, async (_req, res) => {
    res.json({ data: await service.driverPerformance(db) });
  });
  router.get('/exceptions', ...admin, async (_req, res) => {
    res.json(await service.exceptionsAging(db));
  });
  return router;
}
