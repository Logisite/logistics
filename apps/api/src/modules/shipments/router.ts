import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../../db.js';
import { badRequest } from '../../errors.js';
import type { AuthContext } from '../../auth/middleware.js';
import { requireAuth, requirePermission } from '../../auth/middleware.js';
import { PERMISSIONS } from '../../auth/permissions.js';

import * as service from './service.js';
import type { ShipmentStatus } from './transitions.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const transitionBodySchema = z.object({
  locationLabel: z.string().max(500).optional(),
  reason: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw badRequest('VALIDATION', 'Invalid request payload');
  return result.data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shipmentId(req: { params: Record<string, unknown> }): string {
  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw badRequest('VALIDATION', 'Invalid shipment id');
  }
  return id;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const ACTION_ROUTES: ReadonlyArray<readonly [string, ShipmentStatus]> = [
  ['pickup', 'PICKED_UP'],
  ['transit', 'IN_TRANSIT'],
  ['out-for-delivery', 'OUT_FOR_DELIVERY'],
  ['deliver', 'DELIVERED'],
  ['fail-attempt', 'FAILED_ATTEMPT'],
  ['return', 'RETURNING'],
  ['returned', 'RETURNED'],
];

export function shipmentsRouter(db: Db): Router {
  const router = Router();

  const staff = [requireAuth(db), requirePermission(PERMISSIONS.SHIPMENT_TRANSITION)];

  // Explicit action routes; every one funnels through the single transition()
  // gateway in service.ts.
  for (const [path, toStatus] of ACTION_ROUTES) {
    router.post(`/:id/${path}`, ...staff, async (req, res) => {
      const ctx = res.locals.auth as AuthContext;
      const input = parse(transitionBodySchema, req.body ?? {});
      const result = await service.transition(db, ctx, shipmentId(req), toStatus, input);
      res.status(200).json(result);
    });
  }

  router.patch('/:id/cancel', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const input = parse(transitionBodySchema, req.body ?? {});
    const result = await service.cancelShipment(db, ctx, shipmentId(req), input);
    res.status(200).json(result);
  });

  router.get('/:id/events', ...staff, async (req, res) => {
    res.json(await service.getShipmentWithEvents(db, shipmentId(req)));
  });

  return router;
}
