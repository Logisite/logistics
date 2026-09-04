import type { RequestHandler } from 'express';

import { and, eq } from 'drizzle-orm';

import { roleGrants, roles, users } from '@logistics/db';

import { getConfig } from '../../shared/config.js';
import type { Db } from '../../shared/db.js';
import { forbidden, unauthorized } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

import type { Permission, RoleName } from './permissions.js';
import { verifyAccessToken } from './tokens.js';

export interface AuthContext {
  userId: string;
  email: string;
  roleName: RoleName;
  roleId: string;
  permissions: ReadonlySet<Permission>;
  sessionId: string;
}

export function requireAuth(db: Db): RequestHandler {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) {
      logger.warn({ path: req.path, method: req.method }, 'auth.missing-token');
      next(unauthorized('MISSING_TOKEN', 'An access token is required'));
      return;
    }

    let claims;
    try {
      claims = await verifyAccessToken(token, getConfig().jwtAccessSecret);
    } catch {
      logger.warn({ reason: 'verify_failed' }, 'auth.token-invalid');
      next(unauthorized('INVALID_TOKEN', 'This access token is invalid or expired'));
      return;
    }

    // Single join: user + role grant + permissions.
    const grant = await db
      .select({
        userId: users.id,
        email: users.email,
        isActive: users.isActive,
        roleId: roles.id,
        roleName: roles.name,
        permissions: roles.permissions,
      })
      .from(users)
      .innerJoin(roleGrants, eq(roleGrants.userId, users.id))
      .innerJoin(roles, eq(roleGrants.roleId, roles.id))
      .where(and(eq(users.id, claims.sub), eq(roles.name, claims.role)))
      .limit(1);

    const row = grant[0];
    if (!row || !row.isActive) {
      logger.warn({ sub: claims.sub, role: claims.role, reason: 'no_grant_or_inactive' }, 'auth.token-invalid');
      next(unauthorized('INVALID_TOKEN', 'This access token is invalid or expired'));
      return;
    }

    const session = await db.query.sessions.findFirst({
      where: (sessions, { eq }) => eq(sessions.id, claims.jti),
    });
    if (!session || session.revokedAt !== null || session.expiresAt < new Date()) {
      const reason = !session ? 'missing' : session.revokedAt !== null ? 'revoked' : 'expired';
      logger.warn({ sub: claims.sub, sessionId: claims.jti, reason }, 'auth.session-rejected');
      next(unauthorized('INVALID_TOKEN', 'This access token is invalid or expired'));
      return;
    }

    // Ensure the session belongs to the authenticated user.
    if (session.userId !== claims.sub) {
      logger.error({ sub: claims.sub, sessionId: claims.jti }, 'auth.session-mismatch');
      next(unauthorized('INVALID_TOKEN', 'This access token is invalid or expired'));
      return;
    }

    res.locals.auth = {
      userId: row.userId,
      email: row.email,
      roleName: row.roleName as RoleName,
      roleId: row.roleId,
      permissions: new Set(row.permissions as Permission[]),
      sessionId: session.id,
    } satisfies AuthContext;

    next();
  };
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, res, next) => {
    const ctx = res.locals.auth as AuthContext | undefined;
    if (!ctx) {
      next(unauthorized('MISSING_TOKEN', 'An access token is required'));
      return;
    }
    if (!ctx.permissions.has(permission)) {
      logger.warn({ userId: ctx.userId, roleName: ctx.roleName, permission, path: req.path }, 'auth.forbidden');
      next(forbidden('FORBIDDEN', 'You do not have permission to do this'));
      return;
    }
    next();
  };
}