import { Router } from 'express';
import { z } from 'zod';

import { contactIdentities, sessions } from '@logistics/db';

import type { Db } from '../db.js';
import { defineRoute } from '../openapi/registry.js';
import { getConfig } from '../config.js';
import { ROLE_PRIORITY, type RoleName } from './permissions.js';
import { signAccessToken, generateOpaqueToken, hashOpaqueToken } from './tokens.js';
import type { AuthContext } from './middleware.js';
import { requireAuth } from './middleware.js';
import { loadGrantedRoles } from './service.js';
import { verifyCapabilityLink, revokeCapabilityLink } from './capability-links.js';
import { mintShadow, isShadowExpired } from './shadows.js';
import { parsePhone } from './phone.js';
import { writeAudit } from './audit.js';

const revokeSchema = z.object({ reason: z.string().max(500).optional() });

defineRoute({ method: 'get', path: '/capability/{nonce}', responses: { 200: { description: 'ok' }, 404: { description: 'not found' } } });
defineRoute({ method: 'post', path: '/capability/{nonce}/book', responses: { 200: { description: 'ok' }, 409: { description: 'conflict' } } });
defineRoute({ method: 'get', path: '/capability/{nonce}/track', responses: { 200: { description: 'ok' }, 404: { description: 'not found' } } });
defineRoute({ method: 'post', path: '/capability/{nonce}/revoke', request: { body: { content: { 'application/json': { schema: revokeSchema } } } }, responses: { 204: { description: 'revoked' } } });

export function capabilityRouter(db: Db): Router {
  const router = Router();

  router.get('/:nonce', async (req, res) => {
    const nonce = String(req.params.nonce);
    const link = await verifyCapabilityLink(db, nonce);
    res.json({ action: link.action, expiresAt: link.expiresAt });
  });

  router.post('/:nonce/book', async (req, res) => {
    const nonce = String(req.params.nonce);
    const link = await verifyCapabilityLink(db, nonce);

    if (link.action !== 'BOOKING') {
      res.status(400).json({ error: { code: 'WRONG_ACTION', message: 'This link is not for booking' } });
      return;
    }

    const payload = link.payload as Record<string, unknown>;
    const phone = typeof payload.phone === 'string' ? payload.phone : null;
    if (!phone) {
      res.status(400).json({ error: { code: 'INVALID_PAYLOAD', message: 'Link payload missing phone' } });
      return;
    }

    const parsed = parsePhone(phone);
    let shadowUserId: string | null = link.senderUserId ?? null;

    const existingIdentity = await db.query.contactIdentities.findFirst({
      where: (ci, { and, eq }) => and(eq(ci.channel, 'PHONE'), eq(ci.identifier, parsed.phone)),
    });

    if (existingIdentity) {
      shadowUserId = existingIdentity.userId;
    } else if (!shadowUserId) {
      const shadow = await mintShadow(db, parsed.phone, 'capability-booking');
      shadowUserId = shadow.id;

      await db.insert(contactIdentities).values({
        userId: shadow.id,
        channel: 'PHONE',
        identifier: parsed.phone,
        country: parsed.country,
        verifiedAt: new Date(),
      });
    }

    if (shadowUserId && (await isShadowExpired(db, shadowUserId))) {
      res.status(403).json({ error: { code: 'SHADOW_EXPIRED', message: 'Account expired. Contact support.' } });
      return;
    }

    if (!shadowUserId) {
      res.status(403).json({ error: { code: 'NO_USER', message: 'Unable to resolve user' } });
      return;
    }

    const config = getConfig();
    const granted = await loadGrantedRoles(db, shadowUserId);
    const actingRole = granted
      .map((g: { name: RoleName; id: string }) => ({ name: g.name, priority: ROLE_PRIORITY.indexOf(g.name) }))
      .filter((e: { name: RoleName; priority: number }) => e.priority !== -1)
      .sort((a: { priority: number }, b: { priority: number }) => a.priority - b.priority)[0]?.name;

    if (!actingRole) {
      res.status(403).json({ error: { code: 'NO_ROLE', message: 'Account has no roles' } });
      return;
    }

    const refreshToken = generateOpaqueToken();
    const sessionRows = await db.insert(sessions).values({
      userId: shadowUserId,
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
      { sub: shadowUserId, email: '', role: actingRole as RoleName, jti: session.id },
      config.jwtAccessSecret,
      config.jwtAccessTtl,
    );

    res.json({
      accessToken,
      refreshToken,
      session: { id: session.id, createdAt: session.createdAt },
      shadowUser: { id: shadowUserId, isNew: !existingIdentity },
    });

    await writeAudit(db, null, {
      action: 'identity.capability-book',
      entityType: 'capability_link',
      entityId: link.id,
      payload: { nonce, userId: shadowUserId, shipmentId: null },
    });
  });

  router.get('/:nonce/track', async (req, res) => {
    const nonce = String(req.params.nonce);
    const link = await verifyCapabilityLink(db, nonce);

    if (link.action !== 'TRACKING') {
      res.status(400).json({ error: { code: 'WRONG_ACTION', message: 'This link is not for tracking' } });
      return;
    }

    const payload = link.payload as Record<string, unknown>;
    const shipmentId = typeof payload.shipmentId === 'string' ? payload.shipmentId : null;
    if (!shipmentId) {
      res.status(400).json({ error: { code: 'INVALID_PAYLOAD', message: 'Link payload missing shipmentId' } });
      return;
    }

    const shipment = await db.query.shipments.findFirst({
      where: (s, { eq }) => eq(s.id, shipmentId),
      columns: {
        id: true,
        status: true,
        senderName: true,
        recipientName: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!shipment) {
      res.status(404).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Shipment not found' } });
      return;
    }

    res.json({ shipment });
  });

  router.post('/:nonce/revoke', requireAuth(db), async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const nonce = String(req.params.nonce);
    const link = await verifyCapabilityLink(db, nonce);
    await revokeCapabilityLink(db, link.id, ctx.userId);
    res.status(204).end();
  });

  return router;
}
