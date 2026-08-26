import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../db.js';
import { badRequest } from '../errors.js';
import type { AuthContext } from '../auth/middleware.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PERMISSIONS } from '../auth/permissions.js';

import * as service from './service.js';
import { defineRoute } from '../openapi/registry.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const createHubSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().min(1).max(50),
  address: z.string().min(1).max(500),
});

const updateHubSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  code: z.string().min(1).max(50).optional(),
  address: z.string().min(1).max(500).optional(),
  isActive: z.boolean().optional(),
});

const createPickupLocationSchema = z.object({
  hubId: z.string().uuid().nullable().optional(),
  zoneId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(500),
});

const updatePickupLocationSchema = z.object({
  hubId: z.string().uuid().nullable().optional(),
  zoneId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(200).optional(),
  address: z.string().min(1).max(500).optional(),
  isActive: z.boolean().optional(),
});

const createZoneSchema = z.object({
  hubId: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullable().optional(),
});

const updateZoneSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
});

defineRoute({ method: 'get', path: '/locations/hubs', responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'post', path: '/locations/hubs', request: { body: { content: { 'application/json': { schema: createHubSchema } } } }, responses: { 201: { description: 'created' } } });
defineRoute({ method: 'put', path: '/locations/hubs/{id}', request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: updateHubSchema } } } }, responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'delete', path: '/locations/hubs/{id}', request: { params: z.object({ id: z.string().uuid() }) }, responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'get', path: '/locations/pickup-points', responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'post', path: '/locations/pickup-points', request: { body: { content: { 'application/json': { schema: createPickupLocationSchema } } } }, responses: { 201: { description: 'created' } } });
defineRoute({ method: 'get', path: '/locations/zones', responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'post', path: '/locations/zones', request: { body: { content: { 'application/json': { schema: createZoneSchema } } } }, responses: { 201: { description: 'created' } } });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw badRequest('VALIDATION', 'Invalid request payload');
  return result.data;
}

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
