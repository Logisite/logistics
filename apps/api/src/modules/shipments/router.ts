import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../../shared/db.js';
import { badRequest } from '../../shared/errors.js';
import type { AuthContext } from '../auth/middleware.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PERMISSIONS } from '../auth/permissions.js';
import type { Mailer } from '../auth/emails.js';
import { parse } from '../../shared/validate.js';
import { logger } from '../../shared/logger.js';

import * as service from './service.js';
import { SHIPMENT_STATUSES, type ShipmentStatus } from './transitions.js';
import { notifyTransition } from '../notifications/index.js';
import { defineRoute } from '../../openapi/registry.js';

const ShipmentRowSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(SHIPMENT_STATUSES),
  senderName: z.string(),
  recipientName: z.string(),
  senderUserId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).openapi('ShipmentResponse');

const ShipmentEventRowSchema = z.object({
  id: z.string().uuid(),
  shipmentId: z.string().uuid(),
  fromStatus: z.string(),
  toStatus: z.string(),
  locationLabel: z.string().nullable(),
  reason: z.string().nullable(),
  occurredAt: z.string().datetime(),
}).openapi('ShipmentEventResponse');

const transitionBodySchema = z.object({
  locationLabel: z.string().max(500).optional(),
  reason: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
}).openapi('ShipmentTransitionRequest');

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
}).openapi('ShipmentPatchRequest');

for (const [path] of ACTION_ROUTES) {
  defineRoute({
    method: 'post',
    path: `/shipments/{id}/${path}`,
    request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: transitionBodySchema } } } },
    responses: {
      200: {
        description: 'Transition result',
        content: { 'application/json': { schema: z.object({ shipment: ShipmentRowSchema, event: ShipmentEventRowSchema.nullable() }) } },
      },
    },
  });
}
defineRoute({
  method: 'patch',
  path: '/shipments/{id}/cancel',
  request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: transitionBodySchema } } } },
  responses: {
    200: {
      description: 'Cancel result',
      content: { 'application/json': { schema: z.object({ shipment: ShipmentRowSchema, event: ShipmentEventRowSchema.nullable() }) } },
    },
  },
});
defineRoute({
  method: 'get',
  path: '/shipments/{id}/events',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Shipment with events',
      content: { 'application/json': { schema: z.object({ shipment: ShipmentRowSchema, events: ShipmentEventRowSchema.array() }) } },
    },
  },
});
defineRoute({
  method: 'patch',
  path: '/shipments/{id}',
  request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: patchSchema } } } },
  responses: {
    200: {
      description: 'Patched shipment',
      content: { 'application/json': { schema: z.object({ shipment: ShipmentRowSchema }) } },
    },
  },
});

export function shipmentsRouter(db: Db, mailer?: Mailer): Router {
  const router = Router();

  // a notification failure must never fail the transition
  async function maybeNotify(
    result: Awaited<ReturnType<typeof service.transition>>,
    ctx: AuthContext,
  ): Promise<void> {
    if (!mailer || !result.event) return;
    try {
      await notifyTransition(db, mailer, result.shipment, result.event);
    } catch (err) {
      logger.error({ err, shipmentId: result.shipment.id, status: result.event.toStatus, actorUserId: ctx.userId }, 'notifications.fan-out-failed');
    }
  }

  const staff = [requireAuth(db), requirePermission(PERMISSIONS.SHIPMENT_TRANSITION)];

  for (const [path, toStatus] of ACTION_ROUTES) {
    router.post(`/:id/${path}`, ...staff, async (req, res) => {
      const ctx = res.locals.auth as AuthContext;
      const input = parse(transitionBodySchema, req.body ?? {});
      const result = await service.transition(db, ctx, shipmentId(req), toStatus, input);
      await maybeNotify(result, ctx);
      res.status(200).json(result);
    });
  }

  router.patch('/:id/cancel', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const input = parse(transitionBodySchema, req.body ?? {});
    const result = await service.cancelShipment(db, ctx, shipmentId(req), input);
    await maybeNotify(result, ctx);
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
