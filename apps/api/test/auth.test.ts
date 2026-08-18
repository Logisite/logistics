import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { passwordResets, roleGrants, roles, users } from '@logistics/db';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { seedAuthData, ensureOwner } from '../src/auth/seed.js';
import { emailTokenSecret, generateOpaqueToken, hashOpaqueToken, signAccessToken } from '../src/auth/tokens.js';
import { ROLE_PERMISSIONS } from '../src/auth/permissions.js';
import type { Db } from '../src/db.js';

import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';
import { TEST_PASSWORD, seedAdmin, seedUserWithRoles } from './helpers.js';

const ADMIN_EMAIL = 'admin@example.com';

describe('auth slice', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let mailer: FakeMailer;
  let app: ReturnType<typeof createApp>;
  let adminToken: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    mailer = new FakeMailer();
    await seedAuthData(db);
    await seedAdmin(db, ADMIN_EMAIL);
    app = createApp({ db, mailer } satisfies AppDeps);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  function register(email: string, password = TEST_PASSWORD) {
    return request(app).post('/auth/register').send({ email, password });
  }

  async function registerAndVerify(email: string, password = TEST_PASSWORD) {
    const res = await register(email, password);
    expect(res.status).toBe(201);
    const mail = mailer.sentTo('verification', email);
    expect(mail).toBeTruthy();
    const verify = await request(app).post('/auth/verify-email').send({ token: mail!.token });
    expect(verify.status).toBe(200);
  }

  function login(email: string, password = TEST_PASSWORD, role?: string) {
    const body: Record<string, string> = { email, password };
    if (role) body.role = role;
    return request(app).post('/auth/login').send(body);
  }

  async function getAdminToken(): Promise<string> {
    if (!adminToken) {
      const res = await login(ADMIN_EMAIL);
      expect(res.status).toBe(200);
      adminToken = res.body.accessToken as string;
    }
    return adminToken;
  }

  describe('registration and email verification', () => {
    it('rejects malformed register payloads', async () => {
      const badEmail = await register('not-an-email');
      expect(badEmail.status).toBe(400);

      const shortPassword = await request(app).post('/auth/register').send({ email: 'a@b.com', password: 'x' });
      expect(shortPassword.status).toBe(400);

      const empty = await request(app).post('/auth/register').send({});
      expect(empty.status).toBe(400);
    });

    it('gates login behind email verification', async () => {
      const res = await register('gate@example.com');
      expect(res.status).toBe(201);
      expect(mailer.sentTo('verification', 'gate@example.com')).toBeTruthy();

      const blocked = await login('gate@example.com');
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');

      const mail = mailer.sentTo('verification', 'gate@example.com');
      const verify = await request(app).post('/auth/verify-email').send({ token: mail!.token });
      expect(verify.status).toBe(200);

      const ok = await login('gate@example.com');
      expect(ok.status).toBe(200);
      expect(ok.body.accessToken).toBeTruthy();
      expect(ok.body.refreshToken).toBeTruthy();
      expect(ok.body.session.id).toBeTruthy();
    });

    it('rejects a wrong password', async () => {
      await registerAndVerify('wrongpw@example.com');
      const res = await login('wrongpw@example.com', 'wrong-password');
      expect(res.status).toBe(401);
    });

    it('rejects passwords longer than 72 bytes', async () => {
      const tooLong = await register('longpw@example.com', 'x'.repeat(73));
      expect(tooLong.status).toBe(400);
    });

    it('rejects duplicate registration', async () => {
      await register('dup@example.com');
      const again = await register('dup@example.com');
      expect(again.status).toBe(409);
    });
  });

  describe('sessions', () => {
    it('rotates refresh tokens and revokes sessions individually', async () => {
      await registerAndVerify('rotate@example.com');

      const deviceA = await login('rotate@example.com');
      expect(deviceA.status).toBe(200);
      const deviceB = await login('rotate@example.com');
      expect(deviceB.status).toBe(200);

      const sessions = await request(app)
        .get('/auth/sessions')
        .set('Authorization', `Bearer ${deviceA.body.accessToken}`);
      expect(sessions.status).toBe(200);
      expect(sessions.body).toHaveLength(2);

      const refreshA = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: deviceA.body.refreshToken });
      expect(refreshA.status).toBe(200);
      expect(refreshA.body.refreshToken).not.toBe(deviceA.body.refreshToken);

      const replay = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: deviceA.body.refreshToken });
      expect(replay.status).toBe(401);

      const revokedRow = await db.query.sessions.findFirst({
        where: (sessions, { eq }) => eq(sessions.id, deviceA.body.session.id),
      });
      expect(revokedRow?.revokedAt).not.toBeNull();

      const refreshAgain = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: refreshA.body.refreshToken });
      expect(refreshAgain.status).toBe(401);

      const revokeB = await request(app)
        .post(`/auth/sessions/${deviceB.body.session.id}/revoke`)
        .set('Authorization', `Bearer ${deviceB.body.accessToken}`);
      expect(revokeB.status).toBe(204);

      const refreshB = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: deviceB.body.refreshToken });
      expect(refreshB.status).toBe(401);
    });

    it('keeps rotating as long as no token is replayed', async () => {
      await registerAndVerify('rotchain@example.com');
      const loginRes = await login('rotchain@example.com');
      expect(loginRes.status).toBe(200);

      let token = loginRes.body.refreshToken as string;
      for (let i = 0; i < 3; i += 1) {
        const res = await request(app).post('/auth/refresh').send({ refreshToken: token });
        expect(res.status).toBe(200);
        expect(res.body.refreshToken).not.toBe(token);
        token = res.body.refreshToken as string;
      }

      const sessionsRes = await request(app)
        .get('/auth/sessions')
        .set('Authorization', `Bearer ${loginRes.body.accessToken}`);
      expect(sessionsRes.status).toBe(200);
      expect(sessionsRes.body).toHaveLength(1);
    });

    it('rejects access tokens of a revoked session', async () => {
      await registerAndVerify('revokedtok@example.com');
      const loginRes = await login('revokedtok@example.com');
      expect(loginRes.status).toBe(200);

      const revoke = await request(app)
        .post(`/auth/sessions/${loginRes.body.session.id}/revoke`)
        .set('Authorization', `Bearer ${loginRes.body.accessToken}`);
      expect(revoke.status).toBe(204);

      const blocked = await request(app)
        .get('/auth/sessions')
        .set('Authorization', `Bearer ${loginRes.body.accessToken}`);
      expect(blocked.status).toBe(401);
    });

    it('logs out and revokes the current session', async () => {
      await registerAndVerify('logout@example.com');
      const loginRes = await login('logout@example.com');
      expect(loginRes.status).toBe(200);

      const out = await request(app)
        .post('/auth/logout')
        .send({ refreshToken: loginRes.body.refreshToken });
      expect(out.status).toBe(204);

      const refresh = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: loginRes.body.refreshToken });
      expect(refresh.status).toBe(401);
    });

    it('blocks protected routes without a valid session', async () => {
      const noToken = await request(app).get('/auth/sessions');
      expect(noToken.status).toBe(401);

      const badToken = await request(app)
        .get('/auth/sessions')
        .set('Authorization', 'Bearer not-a-jwt');
      expect(badToken.status).toBe(401);

      const noAuthInvite = await request(app)
        .post('/auth/invite')
        .send({ email: 'x@example.com', roleNames: ['DRIVER'] });
      expect(noAuthInvite.status).toBe(401);

      const noAuthBundles = await request(app).get('/auth/bundles');
      expect(noAuthBundles.status).toBe(401);
    });
  });

  describe('rbac and role bundles', () => {
    it('enforces the permission matrix (invite requires ADMIN)', async () => {
      await registerAndVerify('customer@example.com');
      const customer = await login('customer@example.com');
      expect(customer.status).toBe(200);

      const denied = await request(app)
        .post('/auth/invite')
        .set('Authorization', `Bearer ${customer.body.accessToken}`)
        .send({ email: 'someone@example.com', roleNames: ['DRIVER'] });
      expect(denied.status).toBe(403);

      const allowed = await request(app)
        .post('/auth/invite')
        .set('Authorization', `Bearer ${await getAdminToken()}`)
        .send({ email: 'someone@example.com', roleNames: ['DRIVER'] });
      expect(allowed.status).toBe(201);
    });

    it('seeds the Owner-Operator bundle and applies it in one click', async () => {
      const bundles = await request(app)
        .get('/auth/bundles')
        .set('Authorization', `Bearer ${await getAdminToken()}`);
      expect(bundles.status).toBe(200);

      const ownerOp = bundles.body.find((b: { name: string }) => b.name === 'Owner-Operator');
      expect(ownerOp).toBeTruthy();
      expect(ownerOp.roleNames).toEqual(
        expect.arrayContaining(['ADMIN', 'DISPATCHER', 'BRANCH_OPERATOR', 'DRIVER']),
      );

      const invite = await request(app)
        .post('/auth/invite')
        .set('Authorization', `Bearer ${await getAdminToken()}`)
        .send({ email: 'ops@example.com', roleNames: [] });
      expect(invite.status).toBe(201);

      const apply = await request(app)
        .post(`/auth/bundles/${ownerOp.id}/apply`)
        .set('Authorization', `Bearer ${await getAdminToken()}`)
        .send({ userId: invite.body.user.id });
      expect(apply.status).toBe(200);
      expect(apply.body.granted).toEqual(
        expect.arrayContaining(['ADMIN', 'DISPATCHER', 'BRANCH_OPERATOR', 'DRIVER']),
      );
    });

    it('lets an admin create, update and delete role bundles', async () => {
      const create = await request(app)
        .post('/auth/bundles')
        .set('Authorization', `Bearer ${await getAdminToken()}`)
        .send({
          name: 'Night Dispatcher',
          description: 'Cover for the graveyard shift',
          roleNames: ['DISPATCHER', 'BRANCH_OPERATOR'],
        });
      expect(create.status).toBe(201);
      expect(create.body.bundle.roleNames).toContain('DISPATCHER');

      const update = await request(app)
        .put(`/auth/bundles/${create.body.bundle.id}`)
        .set('Authorization', `Bearer ${await getAdminToken()}`)
        .send({ name: 'Night Dispatcher', roleNames: ['DISPATCHER'] });
      expect(update.status).toBe(200);
      expect(update.body.bundle.roleNames).toEqual(['DISPATCHER']);

      const del = await request(app)
        .delete(`/auth/bundles/${create.body.bundle.id}`)
        .set('Authorization', `Bearer ${await getAdminToken()}`);
      expect(del.status).toBe(204);

      const list = await request(app)
        .get('/auth/bundles')
        .set('Authorization', `Bearer ${await getAdminToken()}`);
      expect(list.status).toBe(200);
      expect(list.body.find((b: { id: string }) => b.id === create.body.bundle.id)).toBeUndefined();
    });

    it('rejects bundle mutations without the admin permission', async () => {
      await registerAndVerify('nonadmin@example.com');
      const customer = await login('nonadmin@example.com');
      expect(customer.status).toBe(200);

      const create = await request(app)
        .post('/auth/bundles')
        .set('Authorization', `Bearer ${customer.body.accessToken}`)
        .send({ name: 'Sneaky', roleNames: ['ADMIN'] });
      expect(create.status).toBe(403);
    });

    it('rejects bundles with unknown roles or empty names', async () => {
      const badRole = await request(app)
        .post('/auth/bundles')
        .set('Authorization', `Bearer ${await getAdminToken()}`)
        .send({ name: 'Bad', roleNames: ['GODMODE'] });
      expect(badRole.status).toBe(400);

      const emptyName = await request(app)
        .post('/auth/bundles')
        .set('Authorization', `Bearer ${await getAdminToken()}`)
        .send({ name: '', roleNames: ['DRIVER'] });
      expect(emptyName.status).toBe(400);
    });
  });

  describe('admin invite and password flows', () => {
    it('invites a staff member by email who then sets a password', async () => {
      const invite = await request(app)
        .post('/auth/invite')
        .set('Authorization', `Bearer ${await getAdminToken()}`)
        .send({ email: 'dispatcher@example.com', roleNames: ['DISPATCHER'] });
      expect(invite.status).toBe(201);

      const mail = mailer.sentTo('invite', 'dispatcher@example.com');
      expect(mail).toBeTruthy();

      const setPw = await request(app)
        .post('/auth/reset-password')
        .send({ token: mail!.token, newPassword: 'password456' });
      expect(setPw.status).toBe(200);

      const loginRes = await login('dispatcher@example.com', 'password456');
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.roles).toContain('DISPATCHER');
    });

    it('resets a password through the email-only flow', async () => {
      await registerAndVerify('reset@example.com');

      const forgot = await request(app).post('/auth/forgot-password').send({ email: 'reset@example.com' });
      expect(forgot.status).toBe(202);

      const mail = mailer.sentTo('passwordReset', 'reset@example.com');
      expect(mail).toBeTruthy();

      const reset = await request(app)
        .post('/auth/reset-password')
        .send({ token: mail!.token, newPassword: 'newpassword123' });
      expect(reset.status).toBe(200);

      const oldPw = await login('reset@example.com', TEST_PASSWORD);
      expect(oldPw.status).toBe(401);

      const newPw = await login('reset@example.com', 'newpassword123');
      expect(newPw.status).toBe(200);
    });

    it('does not let a disabled account reset its password', async () => {
      const user = await seedUserWithRoles(db, ['CUSTOMER'], 'disabled@example.com');
      await db.update(users).set({ isActive: false }).where(eq(users.id, user.id));

      const forgot = await request(app)
        .post('/auth/forgot-password')
        .send({ email: 'disabled@example.com' });
      expect(forgot.status).toBe(202);
      expect(mailer.sentTo('passwordReset', 'disabled@example.com')).toBeFalsy();

      const token = generateOpaqueToken();
      await db.insert(passwordResets).values({
        userId: user.id,
        tokenHash: hashOpaqueToken(token, emailTokenSecret(getConfig().jwtRefreshSecret)),
        expiresAt: new Date(Date.now() + 60_000),
      });

      const reset = await request(app)
        .post('/auth/reset-password')
        .send({ token, newPassword: 'newpassword123' });
      expect(reset.status).toBe(403);
      expect(reset.body.error.code).toBe('ACCOUNT_DISABLED');
    });
  });

  describe('bootstrap owner', () => {
    it('creates the first admin from env in one click', async () => {
      const bootDb = await createTestDb({ memory: true });
      try {
        await seedAuthData(bootDb.db);

        const prevEmail = process.env.BOOTSTRAP_OWNER_EMAIL;
        const prevPassword = process.env.BOOTSTRAP_OWNER_PASSWORD;
        process.env.BOOTSTRAP_OWNER_EMAIL = 'owner@example.com';
        process.env.BOOTSTRAP_OWNER_PASSWORD = 'ownerpass123';
        try {
          await ensureOwner(bootDb.db);

          const owner = await bootDb.db.query.users.findFirst({
            where: (users, { eq }) => eq(users.email, 'owner@example.com'),
          });
          expect(owner).toBeTruthy();

          const grants = await bootDb.db
            .select({ name: roles.name })
            .from(roleGrants)
            .innerJoin(roles, eq(roleGrants.roleId, roles.id))
            .where(eq(roleGrants.userId, owner!.id));
          expect(grants.map((g) => g.name)).toEqual(
            expect.arrayContaining(['ADMIN', 'DISPATCHER', 'BRANCH_OPERATOR', 'DRIVER']),
          );
        } finally {
          if (prevEmail === undefined) delete process.env.BOOTSTRAP_OWNER_EMAIL;
          else process.env.BOOTSTRAP_OWNER_EMAIL = prevEmail;
          if (prevPassword === undefined) delete process.env.BOOTSTRAP_OWNER_PASSWORD;
          else process.env.BOOTSTRAP_OWNER_PASSWORD = prevPassword;
        }
      } finally {
        await bootDb.cleanup();
      }
    }, 30_000);

    it('skips bootstrapping when an admin already exists', async () => {
      const prevEmail = process.env.BOOTSTRAP_OWNER_EMAIL;
      const prevPassword = process.env.BOOTSTRAP_OWNER_PASSWORD;
      process.env.BOOTSTRAP_OWNER_EMAIL = 'second-owner@example.com';
      process.env.BOOTSTRAP_OWNER_PASSWORD = 'ownerpass123';
      try {
        await ensureOwner(db);

        const user = await db.query.users.findFirst({
          where: (users, { eq }) => eq(users.email, 'second-owner@example.com'),
        });
        expect(user).toBeUndefined();
      } finally {
        if (prevEmail === undefined) delete process.env.BOOTSTRAP_OWNER_EMAIL;
        else process.env.BOOTSTRAP_OWNER_EMAIL = prevEmail;
        if (prevPassword === undefined) delete process.env.BOOTSTRAP_OWNER_PASSWORD;
        else process.env.BOOTSTRAP_OWNER_PASSWORD = prevPassword;
      }
    });
  });

  describe('audit log', () => {
    it('records role-in-context so admin and driver actions are distinguishable', async () => {
      const multi = await seedUserWithRoles(db, ['ADMIN', 'DRIVER'], 'multi@example.com');

      const asAdmin = await login('multi@example.com', TEST_PASSWORD, 'ADMIN');
      expect(asAdmin.status).toBe(200);
      const asDriver = await login('multi@example.com', TEST_PASSWORD, 'DRIVER');
      expect(asDriver.status).toBe(200);

      const inviteAsAdmin = await request(app)
        .post('/auth/invite')
        .set('Authorization', `Bearer ${asAdmin.body.accessToken}`)
        .send({ email: 'driver@example.com', roleNames: ['DRIVER'] });
      expect(inviteAsAdmin.status).toBe(201);

      const inviteAsDriver = await request(app)
        .post('/auth/invite')
        .set('Authorization', `Bearer ${asDriver.body.accessToken}`)
        .send({ email: 'blocked@example.com', roleNames: ['DRIVER'] });
      expect(inviteAsDriver.status).toBe(403);

      const rows = await db.query.auditLog.findMany({
        where: (auditLog, { eq }) => eq(auditLog.userId, multi.id),
        orderBy: (auditLog, { asc }) => [asc(auditLog.occurredAt)],
      });

      const logins = rows.filter((r) => r.action === 'auth.login');
      expect(logins.map((r) => r.roleName)).toEqual(expect.arrayContaining(['ADMIN', 'DRIVER']));

      const inviteAudit = rows.find((r) => r.action === 'auth.invite');
      expect(inviteAudit?.roleName).toBe('ADMIN');
    });
  });

  describe('production hardening (review-driven; should currently FAIL)', () => {
    it('mints at most one session when the same refresh token is used concurrently', async () => {
      await registerAndVerify('race@example.com');
      const first = await login('race@example.com');
      expect(first.status).toBe(200);
      const token = first.body.refreshToken;

      const [a, b] = await Promise.all([
        request(app).post('/auth/refresh').send({ refreshToken: token }),
        request(app).post('/auth/refresh').send({ refreshToken: token }),
      ]);

      const successes = [a, b].filter((r) => r.status === 200).length;
      expect(successes).toBe(1);
    });

    it('revokes every live session when the password is reset', async () => {
      await registerAndVerify('resetrevoke@example.com');
      const before = await login('resetrevoke@example.com');
      expect(before.status).toBe(200);
      const oldRefresh = before.body.refreshToken;

      const forgot = await request(app)
        .post('/auth/forgot-password')
        .send({ email: 'resetrevoke@example.com' });
      expect(forgot.status).toBe(202);
      const mail = mailer.sentTo('passwordReset', 'resetrevoke@example.com');
      expect(mail).toBeTruthy();

      const reset = await request(app)
        .post('/auth/reset-password')
        .send({ token: mail!.token, newPassword: 'newpassword123' });
      expect(reset.status).toBe(200);

      const stale = await request(app).post('/auth/refresh').send({ refreshToken: oldRefresh });
      expect(stale.status).toBe(401);
    });

    it('rejects a password that only matches the truncated 72-byte bcrypt prefix', async () => {
      const prefix = 'é'.repeat(40); // 80 bytes > 72
      const pwA = `${prefix}A`;
      const pwB = `${prefix}B`;

      // Registration rejects >72 byte passwords
      const registerA = await register('trunc@example.com', pwA);
      expect(registerA.status).toBe(400);

      // Login also rejects >72 byte passwords
      const loginB = await login('trunc@example.com', pwB);
      expect(loginB.status).toBe(401);
    });

    it('rejects an access token whose session belongs to a different user', async () => {
      await registerAndVerify('alice@example.com');
      const alice = await login('alice@example.com');
      expect(alice.status).toBe(200);
      const aliceSessionId = alice.body.session.id;

      const mallory = await seedUserWithRoles(db, ['CUSTOMER'], 'mallory@example.com');
      const forged = await signAccessToken(
        { sub: mallory.id, email: 'mallory@example.com', role: 'CUSTOMER', jti: aliceSessionId },
        getConfig().jwtAccessSecret,
        getConfig().jwtAccessTtl,
      );

      const res = await request(app)
        .get('/auth/sessions')
        .set('Authorization', `Bearer ${forged}`);
      expect(res.status).toBe(401);
    });

    it('repairs role permissions when the seed runs over already-existing roles', async () => {
      const bootDb = await createTestDb({ memory: true });
      try {
        await bootDb.db.insert(roles).values({
          name: 'CUSTOMER',
          description: 'pre-existing role row',
          permissions: [],
        });
        await seedAuthData(bootDb.db);

        const row = await bootDb.db
          .select({ permissions: roles.permissions })
          .from(roles)
          .where(eq(roles.name, 'CUSTOMER'));
        expect(row[0].permissions).toEqual(ROLE_PERMISSIONS.CUSTOMER);
      } finally {
        await bootDb.cleanup();
      }
    }, 30_000);
  });
});