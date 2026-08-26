import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../../db.js';
import { badRequest } from '../../errors.js';
import type { AuthContext } from '../../auth/middleware.js';
import { requireAuth, requirePermission } from '../../auth/middleware.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import type { Mailer } from '../../auth/emails.js';
import { parse } from '../../validate.js';

import * as service from './service.js';
import type { ShipmentStatus } from './transitions.js';
import { notifyTransition } from '../notifications/index.js';
import { defineRoute } from '../../openapi/registry.js';

const transitionBodySchema = z.object({
  locationLabel: z.string().max(500).optional(),
  reason: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shipmentId(req: { params: Record<string, unknown> }): string {
  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw badRequest('VALIDATION', 'Invalid shipment id');
  }
  return id;
}

const ACTION_ROUTES: ReadonlyArray<readonly [string, ShipmentStatus]> = [
  ['pickup', 'PICKED_UP'],
  ['transit', 'IN_TRANSIT'],
  ['out-for-delivery', 'OUT_FOR_DELIVERY'],
  ['deliver', 'DELIVERED'],
  ['fail-attempt', 'FAILED_ATTEMPT'],
  ['return', 'RETURNING'],
  ['returned', 'RETURNED'],
];

const patchSchema = z.object({
  specialInstructions: z.string().max(2000).nullable().optional(),
  category: z.string().max(200).nullable().optional(),
  destinationZoneId: z.string().uuid().optional(),
  recipientName: z.string().max(200).optional(),
  recipientEmail: z.string().email().max(200).nullable().optional(),
  recipientPhone: z.string().max(50).nullable().optional(),
  deliveryOptionId: z.string().uuid().optional(),
  pickupLocationId: z.string().uuid().optional(),
});

for (const [path] of ACTION_ROUTES) {
  defineRoute({
    method: 'post',
    path: `/shipments/{id}/${path}`,
    request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: transitionBodySchema } } } },
    responses: { 200: { description: 'ok' }, 401: { description: 'unauthorized' }, 403: { description: 'forbidden' }, 409: { description: 'invalid transition' } },
  });
}
defineRoute({
  method: 'patch',
  path: '/shipments/{id}/cancel',
  request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: transitionBodySchema } } } },
  responses: { 200: { description: 'ok' }, 401: { description: 'unauthorized' } },
});
defineRoute({
  method: 'get',
  path: '/shipments/{id}/events',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: { 200: { description: 'ok' }, 401: { description: 'unauthorized' }, 404: { description: 'not found' } },
});
defineRoute({
  method: 'patch',
  path: '/shipments/{id}',
  request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: patchSchema } } } },
  responses: { 200: { description: 'ok' }, 401: { description: 'unauthorized' }, 409: { description: 'locked' } },
});

export function shipmentsRouter(db: Db, mailer?: Mailer): Router {
  const router = Router();

  // a notification failure must never fail the transition
  async function maybeNotify(
    result: Awaited<ReturnType<typeof service.transition>>,
  ): Promise<void> {
    if (!mailer || !result.event) return;
    try {
      await notifyTransition(db, mailer, result.shipment, result.event);
    } catch (err) {
      console.error('notification fan-out failed', err);
    }
  }

  const staff = [requireAuth(db), requirePermission(PERMISSIONS.SHIPMENT_TRANSITION)];

  for (const [path, toStatus] of ACTION_ROUTES) {
    router.post(`/:id/${path}`, ...staff, async (req, res) => {
      const ctx = res.locals.auth as AuthContext;
      const input = parse(transitionBodySchema, req.body ?? {});
      const result = await service.transition(db, ctx, shipmentId(req), toStatus, input);
      await maybeNotify(result);
      res.status(200).json(result);
    });
  }

  router.patch('/:id/cancel', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const input = parse(transitionBodySchema, req.body ?? {});
    const result = await service.cancelShipment(db, ctx, shipmentId(req), input);
    await maybeNotify(result);
    res.status(200).json(result);
  });

  router.get('/:id/events', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    res.json(await service.getShipmentWithEvents(db, ctx, shipmentId(req)));
  });

  router.patch('/:id', requireAuth(db), async (req, res) => {
    const input = parse(patchSchema, req.body ?? {});
    const shipment = await service.patchShipment(db, res.locals.auth as AuthContext, shipmentId(req), input);
    res.json({ shipment });
  });

  return router;
}
