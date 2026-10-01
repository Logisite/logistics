import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../../shared/db.js';
import { parse } from '../../shared/validate.js';
import { requireAuth } from '../auth/middleware.js';

import * as service from './service.js';
import { SyncOpRequest, SyncOpResult } from './protocol.js';
import {
  SYNC_ACTIONS,
  SYNC_ENTITIES,
  ShipmentTransitionPayloadSchema,
  SyncOpStatusSchema,
  SyncRejectionCodeSchema,
} from './protocol.js';
import { defineRoute } from '../../openapi/registry.js';

const MAX_OPS_PER_PUSH = 1000;

const opSchema = SyncOpRequest;

const pushSchema = z
  .object({
    deviceId: z.string().uuid(),
    ops: z.array(opSchema).min(1).max(MAX_OPS_PER_PUSH),
  })
  .openapi('SyncPushRequest');

const pendingParams = z.object({ deviceId: z.string().uuid() }).openapi('SyncPendingParams');

const pendingQuery = z
  .object({
    since: z.coerce.number().int().min(-1).default(-1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .openapi('SyncPendingQuery');

const PendingOp = z
  .object({
    id: z.string().uuid(),
    deviceId: z.string().uuid(),
    seq: z.number(),
    opId: z.string().uuid(),
    action: z.enum(SYNC_ACTIONS),
    entity: z.enum(SYNC_ENTITIES),
    entityId: z.string().uuid().nullable(),
    payload: ShipmentTransitionPayloadSchema,
    status: SyncOpStatusSchema,
    rejectionCode: SyncRejectionCodeSchema.optional(),
    createdAt: z.string().datetime(),
  })
  .openapi('SyncPendingOp');

const PointXY = z.object({ x: z.number(), y: z.number() });

// These mirror the drizzle row shapes getStaticRefs returns verbatim, so the
// declared fields must match the table columns exactly.
const StaticHub = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    code: z.string(),
    address: z.string(),
    location: PointXY,
    isActive: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .openapi('StaticHub');

const StaticZone = z
  .object({
    id: z.string().uuid(),
    hubId: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    centroid: PointXY,
    isActive: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .openapi('StaticZone');

const StaticPricingRule = z
  .object({
    id: z.string().uuid(),
    originZoneId: z.string().uuid(),
    destinationZoneId: z.string().uuid(),
    sizeClass: z.string(),
    weightClass: z.string(),
    deliveryOptionId: z.string().uuid(),
    currency: z.string(),
    amountCents: z.number().int(),
    isActive: z.boolean(),
    validFrom: z.string().datetime(),
    validTo: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('StaticPricingRule');

const StaticDeliveryOption = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    isActive: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .openapi('StaticDeliveryOption');

defineRoute({ method: 'post', path: '/sync/push', request: { body: { content: { 'application/json': { schema: pushSchema } } } }, responses: { 200: { description: 'Push results', content: { 'application/json': { schema: z.object({ results: z.array(SyncOpResult) }).openapi('SyncPushResponse') } } } } });
defineRoute({ method: 'get', path: '/sync/pending/{deviceId}', request: { params: pendingParams, query: pendingQuery }, responses: { 200: { description: 'Pending operations', content: { 'application/json': { schema: z.object({ ops: z.array(PendingOp) }).openapi('SyncPendingResponse') } } } } });
defineRoute({ method: 'get', path: '/sync/static', description: 'Bootstrap reference data for an offline device. `version` is the newest shipment event timestamp; refetch when it changes.', responses: { 200: { description: 'Static reference data', content: { 'application/json': { schema: z.object({ hubs: z.array(StaticHub), zones: z.array(StaticZone), pricingRules: z.array(StaticPricingRule), deliveryOptions: z.array(StaticDeliveryOption), version: z.string().datetime().nullable() }).openapi('SyncStaticResponse') } } } } });

export function syncRouter(db: Db): Router {
  const router = Router();

  router.post('/push', requireAuth(db), async (req, res) => {
    const input = parse(pushSchema, req.body);
    const results = await service.pushLedger(db, res.locals.auth, input.deviceId, input.ops);
    res.json({ results });
  });

  router.get('/pending/:deviceId', requireAuth(db), async (req, res) => {
    const { deviceId } = parse(pendingParams, req.params);
    const { since, limit } = parse(pendingQuery, req.query);
    res.json({ ops: await service.getPending(db, res.locals.auth, deviceId, since, limit) });
  });

  router.get('/static', requireAuth(db), async (_req, res) => {
    res.json(await service.getStaticRefs(db));
  });

  return router;
}