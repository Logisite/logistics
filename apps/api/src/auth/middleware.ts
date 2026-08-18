import type { RequestHandler } from 'express';

import { and, eq } from 'drizzle-orm';

import { roleGrants, roles, sessions, users } from '@logistics/db';

import { getConfig } from '../config.js';
import type { Db } from '../db.js';
import { forbidden, unauthorized } from '../errors.js';

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
      next(unauthorized('MISSING_TOKEN', 'An access token is required'));
      return;
    }

    let claims;
    try {
      claims = await verifyAccessToken(token, getConfig().jwtAccessSecret);
    } catch {
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
      next(unauthorized('INVALID_TOKEN', 'This access token is invalid or expired'));
      return;
    }

    const session = await db.query.sessions.findFirst({
      where: (sessions, { eq }) => eq(sessions.id, claims.jti),
    });
    if (!session || session.revokedAt !== null || session.expiresAt < new Date()) {
      next(unauthorized('INVALID_TOKEN', 'This access token is invalid or expired'));
      return;
    }

    // Ensure the session belongs to the authenticated user.
    if (session.userId !== claims.sub) {
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
      next(forbidden('FORBIDDEN', 'You do not have permission to do this'));
      return;
    }
    next();
  };
}