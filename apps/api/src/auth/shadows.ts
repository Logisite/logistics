import { and, eq } from 'drizzle-orm';
import { users, roleGrants } from '@logistics/db';

import { getConfig } from '../config.js';
import type { Db } from '../db.js';
import { forbidden } from '../errors.js';

import { writeAudit } from './audit.js';

export interface ShadowUser {
  id: string;
  isShadow: boolean;
}

export async function mintShadow(
  db: Db,
  phone: string,
  purpose: string,
): Promise<ShadowUser> {
  const config = getConfig();
  const ttlMs = config.shadowAccountTtlDays * 24 * 60 * 60 * 1000;

  const now = new Date();
  const [user] = await db
    .insert(users)
    .values({
      email: `shadow-${phone}-${Date.now()}@logistics.local`,
      passwordHash: 'shadow-no-password',
      isShadow: true,
      shadowExpiresAt: new Date(now.getTime() + ttlMs),
    })
    .returning({ id: users.id });

  if (!user) throw new Error('mintShadow: insert returned nothing');

  const customerRole = await db.query.roles.findFirst({
    where: (roles, { eq }) => eq(roles.name, 'CUSTOMER'),
  });
  if (customerRole) {
    await db.insert(roleGrants).values({ userId: user.id, roleId: customerRole.id });
  }

  await writeAudit(db, null, {
    action: 'identity.shadow-mint',
    entityType: 'user',
    entityId: user.id,
    payload: { phone, purpose },
  });

  return { id: user.id, isShadow: true };
}

export async function upgradeShadow(
  db: Db,
  userId: string,
): Promise<void> {
  const now = new Date();
  const [user] = await db
    .update(users)
    .set({
      isShadow: false,
      upgradedAt: now,
    })
    .where(and(eq(users.id, userId), eq(users.isShadow, true)))
    .returning({ id: users.id });

  if (!user) throw forbidden('NOT_SHADOW', 'User is not a shadow account');

  await writeAudit(db, null, {
    action: 'identity.shadow-upgrade',
    entityType: 'user',
    entityId: userId,
  });
}

export async function isShadowExpired(db: Db, userId: string): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.id, userId),
    columns: { isShadow: true, shadowExpiresAt: true },
  });
  if (!user || !user.isShadow) return false;
  if (!user.shadowExpiresAt) return false;
  return user.shadowExpiresAt < new Date();
}

export async function markLastVerified(db: Db, userId: string): Promise<void> {
  await db.update(users).set({ lastVerifiedAt: new Date() }).where(eq(users.id, userId));
}
