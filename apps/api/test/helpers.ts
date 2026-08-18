import { hash } from 'bcryptjs';

import { roleGrants, users } from '@logistics/db';

import type { Db } from '../src/db.js';

export const TEST_PASSWORD = 'password123';

export async function seedUserWithRoles(
  db: Db,
  roleNames: string[],
  email: string,
  password = TEST_PASSWORD,
): Promise<{ id: string; email: string }> {
  const passwordHash = await hash(password, 10);
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash, emailVerifiedAt: new Date() })
    .returning({ id: users.id, email: users.email });
  if (!user) throw new Error(`seedUserWithRoles: could not insert ${email}`);

  for (const name of roleNames) {
    const role = await db.query.roles.findFirst({
      where: (roles, { eq }) => eq(roles.name, name),
    });
    if (!role) throw new Error(`seedUserWithRoles: role ${name} missing; run seedAuthData first`);
    await db.insert(roleGrants).values({ userId: user.id, roleId: role.id });
  }

  return user;
}

export async function seedAdmin(db: Db, email = 'admin@example.com'): Promise<{ id: string; email: string }> {
  return seedUserWithRoles(db, ['ADMIN'], email);
}