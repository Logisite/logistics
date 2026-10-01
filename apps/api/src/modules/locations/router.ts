import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../../shared/db.js';
import { badRequest } from '../../shared/errors.js';
import type { AuthContext } from '../auth/middleware.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PERMISSIONS } from '../auth/permissions.js';

import * as service from './service.js';
import { defineRoute } from '../../openapi/registry.js';
import { parse } from '../../shared/validate.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const createHubSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().min(1).max(50),
  address: z.string().min(1).max(500),
}).openapi('HubRequest');

const updateHubSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  code: z.string().min(1).max(50).optional(),
  address: z.string().min(1).max(500).optional(),
  isActive: z.boolean().optional(),
}).openapi('HubUpdateRequest');

const createPickupLocationSchema = z.object({
  hubId: z.string().uuid().nullable().optional(),
  zoneId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(500),
}).openapi('PickupLocationRequest');

const updatePickupLocationSchema = z.object({
  hubId: z.string().uuid().nullable().optional(),
  zoneId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(200).optional(),
  address: z.string().min(1).max(500).optional(),
  isActive: z.boolean().optional(),
}).openapi('PickupLocationUpdateRequest');

const createZoneSchema = z.object({
  hubId: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullable().optional(),
}).openapi('ZoneRequest');

const updateZoneSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
}).openapi('ZoneUpdateRequest');

defineRoute({
  method: 'get',
  path: '/locations/hubs',
  responses: {
    200: { description: 'List hubs', content: { 'application/json': { schema: z.object({ hubs: z.array(z.object({ id: z.string().uuid(), name: z.string(), code: z.string(), address: z.string(), isActive: z.boolean(), location: z.object({ x: z.number(), y: z.number() }).nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() })) }) } } },
  },
});

defineRoute({
  method: 'post',
  path: '/locations/hubs',
  request: { body: { content: { 'application/json': { schema: createHubSchema } } } },
  responses: {
    201: { description: 'Hub created', content: { 'application/json': { schema: z.object({ hub: z.object({ id: z.string().uuid(), name: z.string(), code: z.string(), address: z.string(), isActive: z.boolean(), location: z.object({ x: z.number(), y: z.number() }).nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }) }) } } },
  },
});

defineRoute({
  method: 'put',
  path: '/locations/hubs/{id}',
  request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: updateHubSchema } } } },
  responses: {
    200: { description: 'Hub updated', content: { 'application/json': { schema: z.object({ hub: z.object({ id: z.string().uuid(), name: z.string(), code: z.string(), address: z.string(), isActive: z.boolean(), location: z.object({ x: z.number(), y: z.number() }).nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }) }) } } },
  },
});

defineRoute({
  method: 'delete',
  path: '/locations/hubs/{id}',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Hub deleted', content: { 'application/json': { schema: z.object({ hub: z.object({ id: z.string().uuid(), name: z.string(), code: z.string(), address: z.string(), isActive: z.boolean() }) }) } } },
  },
});

defineRoute({
  method: 'get',
  path: '/locations/pickup-points',
  responses: {
    200: { description: 'List pickup locations', content: { 'application/json': { schema: z.object({ pickupLocations: z.array(z.object({ id: z.string().uuid(), hubId: z.string().uuid().nullable(), zoneId: z.string().uuid().nullable(), name: z.string(), address: z.string(), isActive: z.boolean(), location: z.object({ x: z.number(), y: z.number() }).nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() })) }) } } },
  },
});

defineRoute({
  method: 'post',
  path: '/locations/pickup-points',
  request: { body: { content: { 'application/json': { schema: createPickupLocationSchema } } } },
  responses: {
    201: { description: 'Pickup location created', content: { 'application/json': { schema: z.object({ pickupLocation: z.object({ id: z.string().uuid(), hubId: z.string().uuid().nullable(), zoneId: z.string().uuid().nullable(), name: z.string(), address: z.string(), isActive: z.boolean(), location: z.object({ x: z.number(), y: z.number() }).nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }) }) } } },
  },
});

defineRoute({
  method: 'get',
  path: '/locations/zones',
  responses: {
    200: { description: 'List zones', content: { 'application/json': { schema: z.object({ zones: z.array(z.object({ id: z.string().uuid(), hubId: z.string().uuid(), name: z.string(), description: z.string().nullable(), isActive: z.boolean(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() })) }) } } },
  },
});

defineRoute({
  method: 'post',
  path: '/locations/zones',
  request: { body: { content: { 'application/json': { schema: createZoneSchema } } } },
  responses: {
    201: { description: 'Zone created', content: { 'application/json': { schema: z.object({ zone: z.object({ id: z.string().uuid(), hubId: z.string().uuid(), name: z.string(), description: z.string().nullable(), isActive: z.boolean(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }) }) } } },
  },
});

defineRoute({
  method: 'put',
  path: '/locations/pickup-points/{id}',
  request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: updatePickupLocationSchema } } } },
  responses: {
    200: { description: 'Pickup location updated', content: { 'application/json': { schema: z.object({ pickupLocation: z.object({ id: z.string().uuid(), hubId: z.string().uuid().nullable(), zoneId: z.string().uuid().nullable(), name: z.string(), address: z.string(), isActive: z.boolean(), location: z.object({ x: z.number(), y: z.number() }).nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }) }) } } },
  },
});

defineRoute({
  method: 'delete',
  path: '/locations/pickup-points/{id}',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Pickup location deleted', content: { 'application/json': { schema: z.object({ pickupLocation: z.object({ id: z.string().uuid(), hubId: z.string().uuid().nullable(), zoneId: z.string().uuid().nullable(), name: z.string(), address: z.string(), isActive: z.boolean() }) }) } } },
  },
});

defineRoute({
  method: 'put',
  path: '/locations/zones/{id}',
  request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: updateZoneSchema } } } },
  responses: {
    200: { description: 'Zone updated', content: { 'application/json': { schema: z.object({ zone: z.object({ id: z.string().uuid(), hubId: z.string().uuid(), name: z.string(), description: z.string().nullable(), isActive: z.boolean(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }) }) } } },
  },
});

defineRoute({
  method: 'delete',
  path: '/locations/zones/{id}',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Zone deleted', content: { 'application/json': { schema: z.object({ zone: z.object({ id: z.string().uuid(), hubId: z.string().uuid(), name: z.string(), description: z.string().nullable(), isActive: z.boolean() }) }) } } },
  },
});

defineRoute({
  method: 'get',
  path: '/locations/public/hubs',
  security: [],
  responses: {
    200: { description: 'List active hubs', content: { 'application/json': { schema: z.object({ hubs: z.array(z.object({ id: z.string().uuid(), name: z.string(), code: z.string(), address: z.string() })) }) } } },
  },
});

defineRoute({
  method: 'get',
  path: '/locations/public/pickup-points',
  security: [],
  responses: {
    200: { description: 'List active pickup locations', content: { 'application/json': { schema: z.object({ pickupLocations: z.array(z.object({ id: z.string().uuid(), name: z.string(), address: z.string(), hubId: z.string().uuid().nullable(), zoneId: z.string().uuid().nullable() })) }) } } },
  },
});

defineRoute({
  method: 'get',
  path: '/locations/public/zones',
  security: [],
  responses: {
    200: { description: 'List active zones', content: { 'application/json': { schema: z.object({ zones: z.array(z.object({ id: z.string().uuid(), name: z.string(), hubId: z.string().uuid(), description: z.string().nullable() })) }) } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function locationRouter(db: Db): Router {
  const router = Router();

  const requireAdmin = [requireAuth(db), requirePermission(PERMISSIONS.LOCATIONS_MANAGE)];

  // ── Admin: Hubs ──────────────────────────────────────────────────────────

  router.get('/hubs', ...requireAdmin, async (_req, res) => {
    const hubs = await service.listHubs(db);
    res.json({ hubs });
  });

  router.post('/hubs', ...requireAdmin, async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const input = parse(createHubSchema, req.body);
    const hub = await service.createHub(db, ctx, input);
    res.status(201).json({ hub });
  });

  router.put('/hubs/:id', ...requireAdmin, async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const { id } = req.params;
    if (typeof id !== 'string') throw badRequest('VALIDATION', 'Invalid hub id');
    const input = parse(updateHubSchema, req.body);
    const hub = await service.updateHub(db, ctx, id, input);
    res.json({ hub });
  });

  router.delete('/hubs/:id', ...requireAdmin, async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const { id } = req.params;
    if (typeof id !== 'string') throw badRequest('VALIDATION', 'Invalid hub id');
    const hub = await service.deleteHub(db, ctx, id);
    res.json({ hub });
  });

  // ── Admin: Pickup locations ──────────────────────────────────────────────

  router.get('/pickup-points', ...requireAdmin, async (_req, res) => {
    const pickupLocations = await service.listPickupLocations(db);
    res.json({ pickupLocations });
  });

  router.post('/pickup-points', ...requireAdmin, async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const input = parse(createPickupLocationSchema, req.body);
    const pickupLocation = await service.createPickupLocation(db, ctx, input);
    res.status(201).json({ pickupLocation });
  });

  router.put('/pickup-points/:id', ...requireAdmin, async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const { id } = req.params;
    if (typeof id !== 'string') throw badRequest('VALIDATION', 'Invalid pickup location id');
    const input = parse(updatePickupLocationSchema, req.body);
    const pickupLocation = await service.updatePickupLocation(db, ctx, id, input);
    res.json({ pickupLocation });
  });

  router.delete('/pickup-points/:id', ...requireAdmin, async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const { id } = req.params;
    if (typeof id !== 'string') throw badRequest('VALIDATION', 'Invalid pickup location id');
    const pickupLocation = await service.deletePickupLocation(db, ctx, id);
    res.json({ pickupLocation });
  });

  // ── Admin: Zones ─────────────────────────────────────────────────────────

  router.get('/zones', ...requireAdmin, async (_req, res) => {
    const zones = await service.listZones(db);
    res.json({ zones });
  });

  router.post('/zones', ...requireAdmin, async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const input = parse(createZoneSchema, req.body);
    const zone = await service.createZone(db, ctx, input);
    res.status(201).json({ zone });
  });

  router.put('/zones/:id', ...requireAdmin, async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const { id } = req.params;
    if (typeof id !== 'string') throw badRequest('VALIDATION', 'Invalid zone id');
    const input = parse(updateZoneSchema, req.body);
    const zone = await service.updateZone(db, ctx, id, input);
    res.json({ zone });
  });

  router.delete('/zones/:id', ...requireAdmin, async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const { id } = req.params;
    if (typeof id !== 'string') throw badRequest('VALIDATION', 'Invalid zone id');
    const zone = await service.deleteZone(db, ctx, id);
    res.json({ zone });
  });

  // ── Public: active-only reads ────────────────────────────────────────────

  router.get('/public/hubs', async (_req, res) => {
    const hubs = await service.listActiveHubs(db);
    res.json({ hubs });
  });

  router.get('/public/pickup-points', async (_req, res) => {
    const pickupLocations = await service.listActivePickupLocations(db);
    res.json({ pickupLocations });
  });

  router.get('/public/zones', async (_req, res) => {
    const zones = await service.listActiveZones(db);
    res.json({ zones });
  });

  return router;
}
