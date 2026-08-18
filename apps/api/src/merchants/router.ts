import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../db.js';
import { badRequest } from '../errors.js';
import type { AuthContext } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';

import * as service from './service.js';

const createProfileSchema = z.object({
  businessName: z.string().min(1).max(200),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
});

const updateProfileSchema = z.object({
  businessName: z.string().min(1).max(200).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw badRequest('VALIDATION', 'Invalid request payload');
  return result.data;
}

export function merchantRouter(db: Db): Router {
  const router = Router();

  router.post('/me', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const input = parse(createProfileSchema, req.body);
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
    const input = parse(updateProfileSchema, req.body);
    const profile = await service.updateProfile(db, ctx, input);
    res.json({ profile });
  });

  return router;
}
