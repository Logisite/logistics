import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../db.js';
import { badRequest } from '../errors.js';
import type { AuthContext } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';

import * as service from './service.js';
import { defineRoute } from '../openapi/registry.js';
import { parse } from '../validate.js';

const updateProfileSchema = z.object({
  phone: z.string().max(30).nullable().optional(),
});

const createAddressSchema = z.object({
  label: z.string().min(1).max(100),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).nullable().optional(),
  city: z.string().min(1).max(100),
  zoneId: z.string().uuid().nullable().optional(),
  hubId: z.string().uuid().nullable().optional(),
  pickupLocationId: z.string().uuid().nullable().optional(),
  isDefault: z.boolean().optional(),
});

const updateAddressSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  line1: z.string().min(1).max(200).optional(),
  line2: z.string().max(200).nullable().optional(),
  city: z.string().min(1).max(100).optional(),
  zoneId: z.string().uuid().nullable().optional(),
  hubId: z.string().uuid().nullable().optional(),
  pickupLocationId: z.string().uuid().nullable().optional(),
  isDefault: z.boolean().optional(),
});

const createContactSchema = z.object({
  name: z.string().min(1).max(100),
  phone: z.string().min(1).max(30),
  email: z.string().email().nullable().optional(),
  relationship: z.string().min(1).max(100),
});

const updateContactSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  phone: z.string().min(1).max(30).optional(),
  email: z.string().email().nullable().optional(),
  relationship: z.string().min(1).max(100).optional(),
});

defineRoute({ method: 'post', path: '/customers/me', request: { body: { content: { 'application/json': { schema: updateProfileSchema } } } }, responses: { 201: { description: 'created' }, 401: { description: 'unauthorized' } } });
defineRoute({ method: 'get', path: '/customers/me', responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'put', path: '/customers/me', request: { body: { content: { 'application/json': { schema: updateProfileSchema } } } }, responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'get', path: '/customers/me/addresses', responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'post', path: '/customers/me/addresses', request: { body: { content: { 'application/json': { schema: createAddressSchema } } } }, responses: { 201: { description: 'created' } } });
defineRoute({ method: 'put', path: '/customers/me/addresses/{id}', request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: updateAddressSchema } } } }, responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'delete', path: '/customers/me/addresses/{id}', request: { params: z.object({ id: z.string().uuid() }) }, responses: { 204: { description: 'no content' } } });
defineRoute({ method: 'get', path: '/customers/me/emergency-contacts', responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'post', path: '/customers/me/emergency-contacts', request: { body: { content: { 'application/json': { schema: createContactSchema } } } }, responses: { 201: { description: 'created' } } });
defineRoute({ method: 'put', path: '/customers/me/emergency-contacts/{id}', request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: updateContactSchema } } } }, responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'delete', path: '/customers/me/emergency-contacts/{id}', request: { params: z.object({ id: z.string().uuid() }) }, responses: { 204: { description: 'no content' } } });

export function customerRouter(db: Db): Router {
  const router = Router();

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------

  router.post('/me', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const { phone } = parse(updateProfileSchema, req.body);
    const profile = await service.createProfile(db, ctx, phone);
    res.status(201).json({ profile });
  });

  router.get('/me', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const profile = await service.getProfile(db, ctx.userId);
    res.json({ profile });
  });

  router.put('/me', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const { phone } = parse(updateProfileSchema, req.body);
    const profile = await service.updateProfile(db, ctx, phone ?? '');
    res.json({ profile });
  });

  // ---------------------------------------------------------------------------
  // Addresses
  // ---------------------------------------------------------------------------

  router.get('/me/addresses', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const list = await service.listAddresses(db, ctx.userId);
    res.json({ addresses: list });
  });

  router.post('/me/addresses', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const input = parse(createAddressSchema, req.body);
    const address = await service.createAddress(db, ctx, input);
    res.status(201).json({ address });
  });

  router.put('/me/addresses/:id', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const addressId = req.params.id;
    if (typeof addressId !== 'string') throw badRequest('VALIDATION', 'Invalid address id');
    const input = parse(updateAddressSchema, req.body);
    const address = await service.updateAddress(db, ctx, addressId, input);
    res.json({ address });
  });

  router.delete('/me/addresses/:id', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const addressId = req.params.id;
    if (typeof addressId !== 'string') throw badRequest('VALIDATION', 'Invalid address id');
    await service.deleteAddress(db, ctx, addressId);
    res.status(204).end();
  });

  // ---------------------------------------------------------------------------
  // Emergency contacts
  // ---------------------------------------------------------------------------

  router.get('/me/emergency-contacts', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const list = await service.listEmergencyContacts(db, ctx.userId);
    res.json({ emergencyContacts: list });
  });

  router.post('/me/emergency-contacts', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const input = parse(createContactSchema, req.body);
    const contact = await service.createEmergencyContact(db, ctx, input);
    res.status(201).json({ contact });
  });

  router.put('/me/emergency-contacts/:id', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const contactId = req.params.id;
    if (typeof contactId !== 'string') throw badRequest('VALIDATION', 'Invalid contact id');
    const input = parse(updateContactSchema, req.body);
    const contact = await service.updateEmergencyContact(db, ctx, contactId, input);
    res.json({ contact });
  });

  router.delete('/me/emergency-contacts/:id', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const contactId = req.params.id;
    if (typeof contactId !== 'string') throw badRequest('VALIDATION', 'Invalid contact id');
    await service.deleteEmergencyContact(db, ctx, contactId);
    res.status(204).end();
  });

  return router;
}
