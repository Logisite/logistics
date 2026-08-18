import { eq } from 'drizzle-orm';

import { merchantProfiles } from '@logistics/db';

import { writeAudit } from '../auth/audit.js';
import type { AuthContext } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { conflict, notFound } from '../errors.js';

export async function getProfile(db: Db, userId: string) {
  const profile = await db.query.merchantProfiles.findFirst({
    where: (t, { eq }) => eq(t.userId, userId),
  });
  if (!profile) throw notFound('NOT_FOUND', 'No merchant profile');
  return profile;
}

export async function createProfile(
  db: Db,
  ctx: AuthContext,
  input: { businessName: string; email?: string | null; phone?: string | null },
) {
  const existing = await db.query.merchantProfiles.findFirst({
    where: (t, { eq }) => eq(t.userId, ctx.userId),
  });
  if (existing) throw conflict('CONFLICT', 'Merchant profile already exists');

  const [profile] = await db
    .insert(merchantProfiles)
    .values({
      userId: ctx.userId,
      businessName: input.businessName,
      email: input.email ?? null,
      phone: input.phone ?? null,
    })
    .returning();
  if (!profile) throw new Error('createProfile: insert returned nothing');

  await writeAudit(db, ctx, {
    action: 'merchant.profile.create',
    entityType: 'merchant_profile',
    entityId: profile.id,
  });

  return profile;
}

export async function updateProfile(
  db: Db,
  ctx: AuthContext,
  input: { businessName?: string; email?: string | null; phone?: string | null },
) {
  const [profile] = await db
    .update(merchantProfiles)
    .set({
      ...(input.businessName !== undefined && { businessName: input.businessName }),
      ...(input.email !== undefined && { email: input.email }),
      ...(input.phone !== undefined && { phone: input.phone }),
      updatedAt: new Date(),
    })
    .where(eq(merchantProfiles.userId, ctx.userId))
    .returning();
  if (!profile) throw notFound('NOT_FOUND', 'No merchant profile');

  await writeAudit(db, ctx, {
    action: 'merchant.profile.update',
    entityType: 'merchant_profile',
    entityId: profile.id,
  });

  return profile;
}
