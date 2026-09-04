import { randomBytes } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import {
  emailVerifications,
  passwordResets,
  roleBundles,
  roleGrants,
  roles,
  sessions,
  users,
} from '@logistics/db';

import { getConfig } from '../../shared/config.js';
import type { Db } from '../../shared/db.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

import { writeAudit } from './audit.js';
import type { Mailer } from './emails.js';
import type { AuthContext } from './middleware.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { PERMISSIONS, ROLE_NAMES, ROLE_PRIORITY, type RoleName } from './permissions.js';
import { emailTokenSecret, generateOpaqueToken, hashOpaqueToken, signAccessToken } from './tokens.js';

const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function parseTtlMs(ttl: string): number {
  const multiplier: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const amount = Number(ttl.slice(0, -1));
  const unit = ttl.slice(-1);
  if (!Number.isFinite(amount) || !(unit in multiplier)) throw new Error(`invalid ttl: ${ttl}`);
  return amount * multiplier[unit]!;
}

export async function loadGrantedRoles(db: Db, userId: string): Promise<Array<{ id: string; name: RoleName }>> {
  const rows = await db
    .select({ id: roles.id, name: roles.name })
    .from(roleGrants)
    .innerJoin(roles, eq(roleGrants.roleId, roles.id))
    .where(eq(roleGrants.userId, userId));

  const known = new Set<string>(ROLE_NAMES);
  return rows.flatMap((row) => (known.has(row.name) ? [{ id: row.id, name: row.name as RoleName }] : []));
}

function hashEmailToken(secret: string): (token: string) => string {
  const emailSecret = emailTokenSecret(secret);
  return (token) => hashOpaqueToken(token, emailSecret);
}

function hashEmailTokenValue(token: string): string {
  return hashEmailToken(getConfig().jwtRefreshSecret)(token);
}

export interface RegisterInput {
  email: string;
  password: string;
}

export async function register(db: Db, mailer: Mailer, input: RegisterInput) {
  const existing = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.email, input.email),
  });
  if (existing) {
    logger.warn({ email: input.email, reason: 'duplicate_email' }, 'auth.register-rejected');
    throw conflict('DUPLICATE_EMAIL', 'An account with this email already exists');
  }

  if (Buffer.byteLength(input.password, 'utf-8') > 72) {
    logger.warn({ email: input.email, reason: 'password_too_long' }, 'auth.register-rejected');
    throw badRequest('PASSWORD_TOO_LONG', 'Password must not exceed 72 bytes');
  }
  const passwordHash = await hashPassword(input.password);
  const [user] = await db
    .insert(users)
    .values({ email: input.email, passwordHash })
    .returning({ id: users.id, email: users.email });
  if (!user) {
    logger.error({ email: input.email }, 'auth.register-failed');
    throw new Error('register: user insert returned nothing');
  }

  const customerRole = await db.query.roles.findFirst({
    where: (roles, { eq }) => eq(roles.name, 'CUSTOMER'),
  });
  if (customerRole) {
    await db.insert(roleGrants).values({ userId: user.id, roleId: customerRole.id });
  } else {
    logger.error({ userId: user.id, email: user.email, roleName: 'CUSTOMER' }, 'auth.register-missing-role');
  }

  const token = generateOpaqueToken();
  await db.insert(emailVerifications).values({
    userId: user.id,
    email: user.email,
    tokenHash: hashEmailTokenValue(token),
    expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS),
  });
  try {
    await mailer.sendVerificationEmail(user.email, token);
  } catch (err) {
    logger.error({ err, userId: user.id, email: user.email, purpose: 'verification' }, 'auth.email-send-failed');
    throw err;
  }

  await writeAudit(db, null, {
    action: 'auth.register',
    entityType: 'user',
    entityId: user.id,
    payload: { email: user.email },
  });

  return user;
}

export async function verifyEmail(db: Db, token: string): Promise<void> {
  const tokenHash = hashEmailTokenValue(token);
  const verification = await db.query.emailVerifications.findFirst({
    where: (emailVerifications, { eq }) => eq(emailVerifications.tokenHash, tokenHash),
  });
  if (!verification || verification.verifiedAt !== null || verification.expiresAt < new Date()) {
    const reason = !verification ? 'not_found' : verification.verifiedAt !== null ? 'already_verified' : 'expired';
    logger.warn({ reason }, 'auth.verify-email-failed');
    throw badRequest('INVALID_TOKEN', 'This verification link is invalid or has expired');
  }

  const now = new Date();
  await db.update(emailVerifications).set({ verifiedAt: now }).where(eq(emailVerifications.id, verification.id));
  await db.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, verification.userId));

  await writeAudit(db, null, {
    action: 'auth.verify-email',
    entityType: 'user',
    entityId: verification.userId,
  });
}

export interface LoginInput {
  email: string;
  password: string;
  role?: RoleName;
  deviceName?: string;
}

export async function login(db: Db, input: LoginInput) {
  const user = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.email, input.email),
  });
  if (!user) {
    logger.warn({ email: input.email, reason: 'unknown_email' }, 'auth.login-failed');
    throw unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
  }

  if (Buffer.byteLength(input.password, 'utf-8') > 72) {
    logger.warn({ email: input.email, reason: 'invalid_credentials' }, 'auth.login-failed');
    throw unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const passwordMatches = await verifyPassword(input.password, user.passwordHash);
  if (!passwordMatches) {
    logger.warn({ email: input.email, reason: 'invalid_credentials' }, 'auth.login-failed');
    throw unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
  }
  if (!user.emailVerifiedAt) {
    logger.warn({ userId: user.id, email: user.email, reason: 'email_not_verified' }, 'auth.login-failed');
    throw forbidden('EMAIL_NOT_VERIFIED', 'Verify your email before logging in');
  }
  if (!user.isActive) {
    logger.warn({ userId: user.id, email: user.email, reason: 'account_disabled' }, 'auth.login-failed');
    throw forbidden('ACCOUNT_DISABLED', 'This account is disabled');
  }

  const granted = await loadGrantedRoles(db, user.id);
  if (granted.length === 0) {
    logger.warn({ userId: user.id, reason: 'no_role' }, 'auth.login-failed');
    throw forbidden('NO_ROLE', 'This account has no roles assigned');
  }

  const actingRole = input.role
    ? granted.find((grant) => grant.name === input.role)?.name
    : granted
        .map((grant) => ({ name: grant.name, priority: ROLE_PRIORITY.indexOf(grant.name) }))
        .filter((entry) => entry.priority !== -1)
        .sort((a, b) => a.priority - b.priority)[0]?.name;

  if (!actingRole) {
    logger.warn({ userId: user.id, reason: 'role_not_granted', requestedRole: input.role }, 'auth.login-failed');
    throw forbidden('ROLE_NOT_GRANTED', 'You do not hold this role');
  }

  const config = getConfig();
  const refreshToken = generateOpaqueToken();
  const [session] = await db
    .insert(sessions)
    .values({
      userId: user.id,
      refreshTokenHash: hashOpaqueToken(refreshToken, config.jwtRefreshSecret),
      roleName: actingRole,
      deviceName: input.deviceName ?? null,
      expiresAt: new Date(Date.now() + parseTtlMs(config.jwtRefreshTtl)),
      lastUsedAt: new Date(),
    })
    .returning({ id: sessions.id, deviceName: sessions.deviceName, createdAt: sessions.createdAt });
  if (!session) {
    logger.error({ userId: user.id, reason: 'session_insert_failed' }, 'auth.login-failed');
    throw new Error('login: session insert returned nothing');
  }

  const accessToken = await signAccessToken(
    { sub: user.id, email: user.email, role: actingRole, jti: session.id },
    config.jwtAccessSecret,
    config.jwtAccessTtl,
  );

  await writeAudit(db, { userId: user.id, roleName: actingRole }, {
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    payload: { sessionId: session.id, deviceName: input.deviceName ?? null },
  });

  return {
    accessToken,
    refreshToken,
    session: { id: session.id, deviceName: session.deviceName, createdAt: session.createdAt },
    roles: granted.map((grant) => grant.name),
  };
}

export async function refresh(db: Db, refreshToken: string) {
  const config = getConfig();
  const tokenHash = hashOpaqueToken(refreshToken, config.jwtRefreshSecret);
  const nextRefreshToken = generateOpaqueToken();

  // Atomic UPDATE: only one concurrent refresh of the same token can succeed.
  // The WHERE clause ensures the token is current and the session is not revoked.
  const [updated] = await db
    .update(sessions)
    .set({
      previousRefreshTokenHash: tokenHash,
      refreshTokenHash: hashOpaqueToken(nextRefreshToken, config.jwtRefreshSecret),
      lastUsedAt: new Date(),
    })
    .where(and(eq(sessions.refreshTokenHash, tokenHash), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id, userId: sessions.userId, roleName: sessions.roleName });

  if (!updated) {
    // Token not found as current — check if it was already rotated (replay).
    const replayed = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.previousRefreshTokenHash, tokenHash), isNull(sessions.revokedAt)))
      .limit(1);
    const replayedRow = replayed[0];
    if (replayedRow) {
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, replayedRow.id));
      await writeAudit(db, { userId: replayedRow.userId, roleName: replayedRow.roleName }, {
        action: 'auth.refresh-replay',
        entityType: 'session',
        entityId: replayedRow.id,
        payload: { note: 'a rotated refresh token was replayed; session revoked' },
      });
      logger.error({ userId: replayedRow.userId, sessionId: replayedRow.id, roleName: replayedRow.roleName }, 'auth.refresh-replay-detected');
    }
    logger.warn({ reason: 'unknown_token' }, 'auth.refresh-failed');
    throw unauthorized('INVALID_REFRESH_TOKEN', 'This session is no longer valid');
  }

  const user = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.id, updated.userId),
  });
  if (!user || !user.isActive) {
    logger.warn({ userId: updated.userId, sessionId: updated.id, reason: 'account_inactive' }, 'auth.refresh-failed');
    throw unauthorized('INVALID_REFRESH_TOKEN', 'This session is no longer valid');
  }

  const granted = await loadGrantedRoles(db, user.id);
  if (!granted.some((grant) => grant.name === updated.roleName)) {
    logger.warn({ userId: user.id, sessionId: updated.id, reason: 'role_revoked', roleName: updated.roleName }, 'auth.refresh-failed');
    throw unauthorized('INVALID_REFRESH_TOKEN', 'This session is no longer valid');
  }

  const accessToken = await signAccessToken(
    { sub: user.id, email: user.email, role: updated.roleName as RoleName, jti: updated.id },
    config.jwtAccessSecret,
    config.jwtAccessTtl,
  );

  await writeAudit(db, { userId: user.id, roleName: updated.roleName }, {
    action: 'auth.refresh',
    entityType: 'session',
    entityId: updated.id,
  });

  return { accessToken, refreshToken: nextRefreshToken };
}

export async function logout(db: Db, refreshToken: string): Promise<void> {
  const tokenHash = hashOpaqueToken(refreshToken, getConfig().jwtRefreshSecret);
  const session = await db.query.sessions.findFirst({
    where: (sessions, { eq }) => eq(sessions.refreshTokenHash, tokenHash),
  });
  if (session && session.revokedAt === null) {
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id));
  } else {
    logger.warn({ reason: 'unknown_or_revoked' }, 'auth.logout-unknown-token');
  }
}

export async function listSessions(db: Db, userId: string) {
  return db.query.sessions.findMany({
    where: (sessions, { and, eq, isNull }) =>
      and(eq(sessions.userId, userId), isNull(sessions.revokedAt)),
    orderBy: (sessions, { desc }) => desc(sessions.createdAt),
    columns: { id: true, deviceName: true, createdAt: true, lastUsedAt: true },
  });
}

export async function revokeSession(db: Db, ctx: AuthContext, sessionId: string): Promise<void> {
  const session = await db.query.sessions.findFirst({
    where: (sessions, { eq }) => eq(sessions.id, sessionId),
  });
  if (!session) {
    logger.warn({ requesterUserId: ctx.userId, sessionId, reason: 'not_found' }, 'auth.revoke-session-denied');
    throw notFound('SESSION_NOT_FOUND', 'No such session');
  }

  const ownsSession = session.userId === ctx.userId;
  const canRevokeAny = ctx.permissions.has(PERMISSIONS.AUTH_REVOKE_ANY_SESSION);
  if (!ownsSession && !canRevokeAny) {
    logger.warn({ requesterUserId: ctx.userId, sessionId, reason: 'not_owner' }, 'auth.revoke-session-denied');
    throw notFound('SESSION_NOT_FOUND', 'No such session');
  }

  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));

  await writeAudit(db, ctx, {
    action: 'auth.revoke-session',
    entityType: 'session',
    entityId: sessionId,
    payload: { targetUserId: session.userId },
  });
}

export interface InviteInput {
  email: string;
  roleNames: RoleName[];
}

export async function invite(db: Db, mailer: Mailer, ctx: AuthContext, input: InviteInput) {
  const existing = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.email, input.email),
  });
  if (existing) {
    logger.warn({ email: input.email, reason: 'duplicate_email', inviterUserId: ctx.userId }, 'auth.invite-rejected');
    throw conflict('DUPLICATE_EMAIL', 'An account with this email already exists');
  }

  const passwordHash = await hashPassword(randomBytes(24).toString('hex'));
  const [user] = await db
    .insert(users)
    .values({ email: input.email, passwordHash })
    .returning({ id: users.id, email: users.email });
  if (!user) {
    logger.error({ email: input.email, inviterUserId: ctx.userId }, 'auth.invite-failed');
    throw new Error('invite: user insert returned nothing');
  }

  for (const name of input.roleNames) {
    const role = await db.query.roles.findFirst({
      where: (roles, { eq }) => eq(roles.name, name),
    });
    if (!role) {
      logger.warn({ inviterUserId: ctx.userId, roleName: name, reason: 'unknown_role' }, 'auth.invite-rejected');
      throw badRequest('INVALID_ROLE', `Unknown role: ${name}`);
    }
    await db.insert(roleGrants).values({ userId: user.id, roleId: role.id }).onConflictDoNothing();
  }

  const token = generateOpaqueToken();
  await db.insert(passwordResets).values({
    userId: user.id,
    tokenHash: hashEmailTokenValue(token),
    expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS),
  });
  try {
    await mailer.sendInviteEmail(user.email, token);
  } catch (err) {
    logger.error({ err, userId: user.id, email: user.email, purpose: 'invite' }, 'auth.email-send-failed');
    throw err;
  }

  await writeAudit(db, ctx, {
    action: 'auth.invite',
    entityType: 'user',
    entityId: user.id,
    payload: { email: user.email, roles: input.roleNames },
  });

  return user;
}

export async function listBundles(db: Db) {
  return db.query.roleBundles.findMany({
    columns: { id: true, name: true, description: true, roleNames: true },
    orderBy: (roleBundles, { asc }) => asc(roleBundles.createdAt),
  });
}

export interface BundleInput {
  name: string;
  description?: string | null;
  roleNames: RoleName[];
}

export async function createBundle(db: Db, ctx: AuthContext, input: BundleInput) {
  const existing = await db.query.roleBundles.findFirst({
    where: (roleBundles, { eq }) => eq(roleBundles.name, input.name),
  });
  if (existing) {
    logger.warn({ name: input.name, actorUserId: ctx.userId, reason: 'duplicate_bundle' }, 'auth.create-bundle-rejected');
    throw conflict('DUPLICATE_BUNDLE', 'A bundle with this name already exists');
  }

  const [bundle] = await db
    .insert(roleBundles)
    .values({ name: input.name, description: input.description ?? null, roleNames: input.roleNames })
    .returning({
      id: roleBundles.id,
      name: roleBundles.name,
      description: roleBundles.description,
      roleNames: roleBundles.roleNames,
    });
  if (!bundle) {
    logger.error({ name: input.name, actorUserId: ctx.userId }, 'auth.create-bundle-failed');
    throw new Error('createBundle: insert returned nothing');
  }

  await writeAudit(db, ctx, {
    action: 'auth.create-bundle',
    entityType: 'role_bundle',
    entityId: bundle.id,
    payload: { name: bundle.name, roleNames: input.roleNames },
  });

  return bundle;
}

export async function updateBundle(db: Db, ctx: AuthContext, bundleId: string, input: BundleInput) {
  const existing = await db.query.roleBundles.findFirst({
    where: (roleBundles, { eq }) => eq(roleBundles.id, bundleId),
  });
  if (!existing) {
    logger.warn({ bundleId, actorUserId: ctx.userId, action: 'update' }, 'auth.bundle-not-found');
    throw notFound('BUNDLE_NOT_FOUND', 'No such bundle');
  }

  const [bundle] = await db
    .update(roleBundles)
    .set({ name: input.name, description: input.description ?? null, roleNames: input.roleNames })
    .where(eq(roleBundles.id, bundleId))
    .returning({
      id: roleBundles.id,
      name: roleBundles.name,
      description: roleBundles.description,
      roleNames: roleBundles.roleNames,
    });
  if (!bundle) throw new Error('updateBundle: update returned nothing');

  await writeAudit(db, ctx, {
    action: 'auth.update-bundle',
    entityType: 'role_bundle',
    entityId: bundle.id,
    payload: { name: bundle.name, roleNames: input.roleNames },
  });

  return bundle;
}

export async function deleteBundle(db: Db, ctx: AuthContext, bundleId: string): Promise<void> {
  const existing = await db.query.roleBundles.findFirst({
    where: (roleBundles, { eq }) => eq(roleBundles.id, bundleId),
  });
  if (!existing) {
    logger.warn({ bundleId, actorUserId: ctx.userId, action: 'delete' }, 'auth.bundle-not-found');
    throw notFound('BUNDLE_NOT_FOUND', 'No such bundle');
  }

  await db.delete(roleBundles).where(eq(roleBundles.id, bundleId));

  await writeAudit(db, ctx, {
    action: 'auth.delete-bundle',
    entityType: 'role_bundle',
    entityId: bundleId,
  });
}

export async function applyBundle(db: Db, ctx: AuthContext, bundleId: string, userId: string) {
  const bundle = await db.query.roleBundles.findFirst({
    where: (roleBundles, { eq }) => eq(roleBundles.id, bundleId),
  });
  if (!bundle) {
    logger.warn({ bundleId, actorUserId: ctx.userId, action: 'apply' }, 'auth.bundle-not-found');
    throw notFound('BUNDLE_NOT_FOUND', 'No such bundle');
  }

  const user = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.id, userId),
  });
  if (!user) {
    logger.warn({ bundleId, targetUserId: userId, actorUserId: ctx.userId, reason: 'user_not_found' }, 'auth.apply-bundle-rejected');
    throw notFound('USER_NOT_FOUND', 'No such user');
  }

  const granted: string[] = [];
  for (const name of bundle.roleNames as RoleName[]) {
    const role = await db.query.roles.findFirst({
      where: (roles, { eq }) => eq(roles.name, name),
    });
    if (!role) {
      logger.error({ bundleId: bundle.id, bundleName: bundle.name, roleName: name }, 'auth.bundle-corrupt');
      throw new Error(`bundle ${bundle.name} references unknown role ${name}`);
    }
    await db.insert(roleGrants).values({ userId, roleId: role.id }).onConflictDoNothing();
    granted.push(role.name);
  }

  await writeAudit(db, ctx, {
    action: 'auth.apply-bundle',
    entityType: 'user',
    entityId: userId,
    payload: { bundleName: bundle.name, granted },
  });

  return granted;
}

export async function forgotPassword(db: Db, mailer: Mailer, email: string): Promise<void> {
  const user = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.email, email),
  });
  if (!user || !user.isActive) {
    logger.warn({ email, reason: 'unknown_or_inactive' }, 'auth.forgot-password-skipped');
    return;
  }

  const token = generateOpaqueToken();
  await db.insert(passwordResets).values({
    userId: user.id,
    tokenHash: hashEmailTokenValue(token),
    expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS),
  });
  try {
    await mailer.sendPasswordResetEmail(user.email, token);
  } catch (err) {
    logger.error({ err, userId: user.id, purpose: 'password_reset' }, 'auth.email-send-failed');
    throw err;
  }

  await writeAudit(db, null, {
    action: 'auth.forgot-password',
    entityType: 'user',
    entityId: user.id,
  });
}

export async function resetPassword(db: Db, token: string, newPassword: string): Promise<void> {
  const tokenHash = hashEmailTokenValue(token);
  const reset = await db.query.passwordResets.findFirst({
    where: (passwordResets, { eq }) => eq(passwordResets.tokenHash, tokenHash),
  });
  if (!reset || reset.usedAt !== null || reset.expiresAt < new Date()) {
    logger.warn({ reason: 'invalid_or_expired' }, 'auth.reset-password-failed');
    throw badRequest('INVALID_TOKEN', 'This token is invalid or has expired');
  }

  const user = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.id, reset.userId),
  });
  if (!user || !user.isActive) {
    logger.warn({ userId: reset.userId, reason: 'account_disabled' }, 'auth.reset-password-failed');
    throw forbidden('ACCOUNT_DISABLED', 'This account is disabled');
  }

  const passwordHash = await hashPassword(newPassword);
  const now = new Date();

  // Revoke every live session for this user so old refresh tokens stop working.
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, reset.userId), isNull(sessions.revokedAt)));

  await db
    .update(users)
    .set({ passwordHash, emailVerifiedAt: now })
    .where(eq(users.id, reset.userId));
  await db.update(passwordResets).set({ usedAt: now }).where(eq(passwordResets.id, reset.id));

  await writeAudit(db, null, {
    action: 'auth.reset-password',
    entityType: 'user',
    entityId: reset.userId,
  });
}