import { and, eq } from 'drizzle-orm';

import { roleBundles, roleGrants, roles, users } from '@logistics/db';

import { getConfig } from '../config.js';
import type { Db } from '../db.js';

import { writeAudit } from './audit.js';
import { hashPassword } from './passwords.js';
import { ROLE_DESCRIPTIONS, ROLE_NAMES, ROLE_PERMISSIONS, type RoleName } from './permissions.js';

export async function seedAuthData(db: Db): Promise<void> {
  for (const name of ROLE_NAMES) {
    await db
      .insert(roles)
      .values({
        name,
        description: ROLE_DESCRIPTIONS[name],
        permissions: [...ROLE_PERMISSIONS[name]],
      })
      .onConflictDoUpdate({
        target: roles.name,
        set: {
          description: ROLE_DESCRIPTIONS[name],
          permissions: [...ROLE_PERMISSIONS[name]],
        },
      });
  }

  await db
    .insert(roleBundles)
    .values({
      name: 'Owner-Operator',
      description: 'One-person office: full platform control plus dispatch, branch and driver access.',
      roleNames: ['ADMIN', 'DISPATCHER', 'BRANCH_OPERATOR', 'DRIVER'],
    })
    .onConflictDoNothing();
}

export async function ensureOwner(db: Db): Promise<void> {
  const config = getConfig();
  if (!config.bootstrapOwnerEmail || !config.bootstrapOwnerPassword) return;

  const adminExists = await db
    .select({ id: users.id })
    .from(roleGrants)
    .innerJoin(users, eq(roleGrants.userId, users.id))
    .innerJoin(roles, eq(roleGrants.roleId, roles.id))
    .where(and(eq(roles.name, 'ADMIN'), eq(users.isActive, true)))
    .limit(1);
  if (adminExists.length > 0) return;

  const ownerBundle = await db.query.roleBundles.findFirst({
    where: (roleBundles, { eq }) => eq(roleBundles.name, 'Owner-Operator'),
  });
  const bundleRoleNames = (ownerBundle?.roleNames ?? ['ADMIN']) as RoleName[];

  const passwordHash = await hashPassword(config.bootstrapOwnerPassword);
  const [owner] = await db
    .insert(users)
    .values({ email: config.bootstrapOwnerEmail, passwordHash, emailVerifiedAt: new Date() })
    .returning({ id: users.id, email: users.email });
  if (!owner) throw new Error('ensureOwner: user insert returned nothing');

  for (const name of bundleRoleNames) {
    const role = await db.query.roles.findFirst({
      where: (roles, { eq }) => eq(roles.name, name),
    });
    if (!role) throw new Error(`ensureOwner: unknown role ${name}`);
    await db.insert(roleGrants).values({ userId: owner.id, roleId: role.id }).onConflictDoNothing();
  }

  await writeAudit(db, null, {
    action: 'auth.bootstrap-owner',
    entityType: 'user',
    entityId: owner.id,
    payload: { roles: bundleRoleNames },
  });
}