import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { sessions, users } from '@logistics/db';

import type { Db } from '../db.js';
import { badRequest } from '../errors.js';

import type { Mailer } from './emails.js';
import type { AuthContext } from './middleware.js';
import { defineRoute } from '../openapi/registry.js';
import { requireAuth, requirePermission } from './middleware.js';
import { PERMISSIONS, ROLE_NAMES, ROLE_PRIORITY, type RoleName } from './permissions.js';
import * as service from './service.js';
import { loadGrantedRoles } from './service.js';
import { parse } from '../validate.js';
import { requestOtp, verifyOtp } from './phone-verification.js';
import { parsePhone } from './phone.js';
import { upgradeShadow, markLastVerified } from './shadows.js';
import { signAccessToken, generateOpaqueToken, hashOpaqueToken } from './tokens.js';
import { hashPassword } from './passwords.js';
import { createSmsProvider } from './sms.js';
import { getConfig } from '../config.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(72),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  role: z.enum(ROLE_NAMES).optional(),
  deviceName: z.string().max(120).optional(),
});

const tokenSchema = z.object({ token: z.string().min(1) });
const refreshSchema = z.object({ refreshToken: z.string().min(1) });

const inviteSchema = z.object({
  email: z.string().email(),
  roleNames: z.array(z.enum(ROLE_NAMES)).max(ROLE_NAMES.length),
});

const bundleSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  roleNames: z.array(z.enum(ROLE_NAMES)).max(ROLE_NAMES.length),
});

const bundleApplySchema = z.object({ userId: z.string().uuid() });
const forgotSchema = z.object({ email: z.string().email() });

const resetSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8).max(72),
});

defineRoute({ method: 'post', path: '/auth/register', request: { body: { content: { 'application/json': { schema: registerSchema } } } }, responses: { 201: { description: 'created' } } });
defineRoute({ method: 'post', path: '/auth/verify-email', request: { body: { content: { 'application/json': { schema: tokenSchema } } } }, responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'post', path: '/auth/login', request: { body: { content: { 'application/json': { schema: loginSchema } } } }, responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'post', path: '/auth/refresh', request: { body: { content: { 'application/json': { schema: refreshSchema } } } }, responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'post', path: '/auth/logout', request: { body: { content: { 'application/json': { schema: refreshSchema } } } }, responses: { 204: { description: 'no content' } } });
defineRoute({ method: 'get', path: '/auth/sessions', responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'post', path: '/auth/sessions/{id}/revoke', request: { params: z.object({ id: z.string() }) }, responses: { 204: { description: 'no content' } } });
defineRoute({ method: 'post', path: '/auth/invite', request: { body: { content: { 'application/json': { schema: inviteSchema } } } }, responses: { 201: { description: 'created' } } });
defineRoute({ method: 'get', path: '/auth/bundles', responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'post', path: '/auth/bundles', request: { body: { content: { 'application/json': { schema: bundleSchema } } } }, responses: { 201: { description: 'created' } } });
defineRoute({ method: 'put', path: '/auth/bundles/{id}', request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: bundleSchema } } } }, responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'delete', path: '/auth/bundles/{id}', request: { params: z.object({ id: z.string().uuid() }) }, responses: { 204: { description: 'no content' } } });
defineRoute({ method: 'post', path: '/auth/bundles/{id}/apply', request: { params: z.object({ id: z.string().uuid() }), body: { content: { 'application/json': { schema: bundleApplySchema } } } }, responses: { 200: { description: 'ok' } } });
defineRoute({ method: 'post', path: '/auth/forgot-password', request: { body: { content: { 'application/json': { schema: forgotSchema } } } }, responses: { 202: { description: 'accepted' } } });
defineRoute({ method: 'post', path: '/auth/reset-password', request: { body: { content: { 'application/json': { schema: resetSchema } } } }, responses: { 200: { description: 'ok' } } });

const otpRequestSchema = z.object({ phone: z.string().min(1) });
const otpVerifySchema = z.object({ phone: z.string().min(1), code: z.string().length(6) });
const otpUpgradeSchema = z.object({ password: z.string().min(8).max(72) });

defineRoute({ method: 'post', path: '/auth/otp/request', request: { body: { content: { 'application/json': { schema: otpRequestSchema } } } }, responses: { 200: { description: 'ok' }, 429: { description: 'rate limited' } } });
defineRoute({ method: 'post', path: '/auth/otp/verify', request: { body: { content: { 'application/json': { schema: otpVerifySchema } } } }, responses: { 200: { description: 'ok' }, 400: { description: 'invalid code' } } });
defineRoute({ method: 'post', path: '/auth/otp/upgrade', request: { body: { content: { 'application/json': { schema: otpUpgradeSchema } } } }, responses: { 200: { description: 'ok' }, 403: { description: 'not a shadow' } } });

export function authRouter(db: Db, mailer: Mailer): Router {
  const router = Router();

  router.post('/register', async (req, res) => {
    const input = parse(registerSchema, req.body);
    const user = await service.register(db, mailer, input);
    res.status(201).json({ user });
  });

  router.post('/verify-email', async (req, res) => {
    const { token } = parse(tokenSchema, req.body);
    await service.verifyEmail(db, token);
    res.json({ verified: true });
  });

  router.post('/login', async (req, res) => {
    const input = parse(loginSchema, req.body);
    const result = await service.login(db, input);
    res.json(result);
  });

  router.post('/refresh', async (req, res) => {
    const { refreshToken } = parse(refreshSchema, req.body);
    const result = await service.refresh(db, refreshToken);
    res.json(result);
  });

  router.post('/logout', async (req, res) => {
    const { refreshToken } = parse(refreshSchema, req.body);
    await service.logout(db, refreshToken);
    res.status(204).end();
  });

  router.get('/sessions', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const sessions = await service.listSessions(db, ctx.userId);
    res.json(sessions);
  });

  router.post('/sessions/:id/revoke', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const sessionId = req.params.id;
    if (typeof sessionId !== 'string') throw badRequest('VALIDATION', 'Invalid session id');
    await service.revokeSession(db, ctx, sessionId);
    res.status(204).end();
  });

  router.post(
    '/invite',
    requireAuth(db),
    requirePermission(PERMISSIONS.AUTH_INVITE),
    async (req, res) => {
      const ctx = res.locals.auth as AuthContext;
      const input = parse(inviteSchema, req.body);
      const user = await service.invite(db, mailer, ctx, input);
      res.status(201).json({ user });
    },
  );

  router.get('/bundles', requireAuth(db), async (_req, res) => {
    const bundles = await service.listBundles(db);
    res.json(bundles);
  });

  router.post(
    '/bundles',
    requireAuth(db),
    requirePermission(PERMISSIONS.AUTH_MANAGE_BUNDLES),
    async (req, res) => {
      const ctx = res.locals.auth as AuthContext;
      const input = parse(bundleSchema, req.body);
      const bundle = await service.createBundle(db, ctx, input);
      res.status(201).json({ bundle });
    },
  );

  router.put(
    '/bundles/:id',
    requireAuth(db),
    requirePermission(PERMISSIONS.AUTH_MANAGE_BUNDLES),
    async (req, res) => {
      const ctx = res.locals.auth as AuthContext;
      const bundleId = req.params.id;
      if (typeof bundleId !== 'string') throw badRequest('VALIDATION', 'Invalid bundle id');
      const input = parse(bundleSchema, req.body);
      const bundle = await service.updateBundle(db, ctx, bundleId, input);
      res.json({ bundle });
    },
  );

  router.delete(
    '/bundles/:id',
    requireAuth(db),
    requirePermission(PERMISSIONS.AUTH_MANAGE_BUNDLES),
    async (req, res) => {
      const ctx = res.locals.auth as AuthContext;
      const bundleId = req.params.id;
      if (typeof bundleId !== 'string') throw badRequest('VALIDATION', 'Invalid bundle id');
      await service.deleteBundle(db, ctx, bundleId);
      res.status(204).end();
    },
  );

  router.post(
    '/bundles/:id/apply',
    requireAuth(db),
    requirePermission(PERMISSIONS.AUTH_MANAGE_BUNDLES),
    async (req, res) => {
      const ctx = res.locals.auth as AuthContext;
      const bundleId = req.params.id;
      if (typeof bundleId !== 'string') throw badRequest('VALIDATION', 'Invalid bundle id');
      const { userId } = parse(bundleApplySchema, req.body);
      const granted = await service.applyBundle(db, ctx, bundleId, userId);
      res.json({ granted });
    },
  );

  router.post('/forgot-password', async (req, res) => {
    const { email } = parse(forgotSchema, req.body);
    await service.forgotPassword(db, mailer, email);
    res.status(202).json({ sent: true });
  });

  router.post('/reset-password', async (req, res) => {
    const { token, newPassword } = parse(resetSchema, req.body);
    await service.resetPassword(db, token, newPassword);
    res.json({ ok: true });
  });

  router.post('/otp/request', async (req, res) => {
    const { phone } = parse(otpRequestSchema, req.body);
    const parsed = parsePhone(phone);
    const sms = createSmsProvider();
    const result = await requestOtp(db, sms, parsed.phone, 'login');
    res.json(result);
  });

  router.post('/otp/verify', async (req, res) => {
    const { phone, code } = parse(otpVerifySchema, req.body);
    const parsed = parsePhone(phone);
    const result = await verifyOtp(db, parsed.phone, code, 'login', parsed.country);

    const config = getConfig();
    const granted = await loadGrantedRoles(db, result.userId);
    const actingRole = granted
      .map((g) => ({ name: g.name, priority: ROLE_PRIORITY.indexOf(g.name) }))
      .filter((e) => e.priority !== -1)
      .sort((a, b) => a.priority - b.priority)[0]?.name;

    if (!actingRole) {
      res.status(403).json({ error: { code: 'NO_ROLE', message: 'Account has no roles' } });
      return;
    }

    await markLastVerified(db, result.userId);

    const refreshToken = generateOpaqueToken();
    const sessionRows = await db.insert(sessions).values({
      userId: result.userId,
      refreshTokenHash: hashOpaqueToken(refreshToken, config.jwtRefreshSecret),
      roleName: actingRole as RoleName,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      lastUsedAt: new Date(),
    }).returning({ id: sessions.id, createdAt: sessions.createdAt });

    const session = sessionRows[0];
    if (!session) {
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Failed to create session' } });
      return;
    }

    const accessToken = await signAccessToken(
      { sub: result.userId, email: '', role: actingRole as RoleName, jti: session.id },
      config.jwtAccessSecret,
      config.jwtAccessTtl,
    );

    res.json({ accessToken, refreshToken, session: { id: session.id, createdAt: session.createdAt } });
  });

  router.post('/otp/upgrade', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const { password } = parse(otpUpgradeSchema, req.body);

    const passwordHash = await hashPassword(password);
    await db.update(users).set({ passwordHash }).where(eq(users.id, ctx.userId));
    await upgradeShadow(db, ctx.userId);
    res.json({ upgraded: true });
  });

  return router;
}