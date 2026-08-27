import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../shared/db.js';
import type { AuthContext } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';

import * as service from './service.js';
import { defineRoute } from '../openapi/registry.js';
import { parse } from '../shared/validate.js';

const MerchantProfileResponse = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  businessName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).openapi('MerchantProfileResponse');

const MerchantCreateRequest = z.object({
  businessName: z.string().min(1).max(200),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
}).openapi('MerchantCreateRequest');

const MerchantUpdateRequest = z.object({
  businessName: z.string().min(1).max(200).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
}).openapi('MerchantUpdateRequest');

defineRoute({
  method: 'post',
  path: '/merchants/me',
  summary: 'Create merchant profile',
  request: { body: { content: { 'application/json': { schema: MerchantCreateRequest } } } },
  responses: {
    201: { description: 'Profile created', content: { 'application/json': { schema: z.object({ profile: MerchantProfileResponse }) } } },
    409: { description: 'Profile already exists', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string() }) }) } } },
  },
});

defineRoute({
  method: 'get',
  path: '/merchants/me',
  summary: 'Get merchant profile',
  responses: {
    200: { description: 'Profile retrieved', content: { 'application/json': { schema: z.object({ profile: MerchantProfileResponse }) } } },
    404: { description: 'No profile', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string() }) }) } } },
  },
});

defineRoute({
  method: 'put',
  path: '/merchants/me',
  summary: 'Update merchant profile',
  request: { body: { content: { 'application/json': { schema: MerchantUpdateRequest } } } },
  responses: {
    200: { description: 'Profile updated', content: { 'application/json': { schema: z.object({ profile: MerchantProfileResponse }) } } },
    404: { description: 'No profile', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string() }) }) } } },
  },
});

export function merchantRouter(db: Db): Router {
  const router = Router();

  router.post('/me', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const input = parse(MerchantCreateRequest, req.body);
    const profile = await service.createProfile(db, ctx, input);
    res.status(201).json({ profile });
  });

  router.get('/me', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const profile = await service.getProfile(db, ctx.userId);
    res.json({ profile });
  });

  router.put('/me', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const input = parse(MerchantUpdateRequest, req.body);
    const profile = await service.updateProfile(db, ctx, input);
    res.json({ profile });
  });

  return router;
}
