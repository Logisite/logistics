import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { phoneOtps } from '@logistics/db';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/auth/seed.js';
import { FakeSmsProvider } from '../src/auth/sms.js';
import { requestOtp, verifyOtp } from '../src/auth/phone-verification.js';
import { issueCapabilityLink, verifyCapabilityLink, consumeCapabilityLink } from '../src/auth/capability-links.js';
import type { Db } from '../src/db.js';

import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';

describe('identity pack', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let mailer: FakeMailer;
  let app: ReturnType<typeof createApp>;
  let sms: FakeSmsProvider;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    mailer = new FakeMailer();
    sms = new FakeSmsProvider();
    await seedAuthData(db);
    app = createApp({ db, mailer } satisfies AppDeps);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  describe('phone validation', () => {
    it('rejects invalid E.164 phone numbers', async () => {
      const res = await request(app)
        .post('/api/v1/auth/otp/request')
        .send({ phone: 'not-a-phone' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PHONE');
    });

    it('accepts valid E.164 phone numbers', async () => {
      const res = await request(app)
        .post('/api/v1/auth/otp/request')
        .send({ phone: '+447911123456' });
      expect(res.status).toBe(200);
      expect(res.body.sent).toBe(true);
    });
  });

  describe('OTP flow', () => {
    it('sends OTP and verifies correctly', async () => {
      const phone = '+447911123457';
      const purpose = 'login';

      const requestResult = await requestOtp(db, sms, phone, purpose);
      expect(requestResult.sent).toBe(true);

      const code = sms.lastCode;
      expect(code).toBeDefined();
      expect(code).toMatch(/^\d{6}$/);

      const verifyResult = await verifyOtp(db, phone, code!, purpose);
      expect(verifyResult.userId).toBeDefined();
      expect(verifyResult.isNew).toBe(true);
    });

    it('rejects invalid OTP codes', async () => {
      const phone = '+447911123458';
      const purpose = 'login';

      await requestOtp(db, sms, phone, purpose);

      await expect(verifyOtp(db, phone, '000000', purpose)).rejects.toThrow('Invalid verification code');
    });

    it('rejects expired OTP codes', async () => {
      const phone = '+447911123459';
      const purpose = 'login';

      await requestOtp(db, sms, phone, purpose);

      const otp = await db.query.phoneOtps.findFirst({
        where: (t, { eq }) => eq(t.phone, phone),
      });
      expect(otp).toBeDefined();

      await db.update(phoneOtps)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(phoneOtps.id, otp!.id));

      await expect(verifyOtp(db, phone, sms.lastCode!, purpose)).rejects.toThrow('expired');
    });

    it('enforces max attempts', async () => {
      const phone = '+447911123460';
      const purpose = 'login';

      await requestOtp(db, sms, phone, purpose);
      const code = sms.lastCode;

      for (let i = 0; i < 3; i++) {
        await verifyOtp(db, phone, '111111', purpose).catch(() => {});
      }

      await expect(verifyOtp(db, phone, code!, purpose)).rejects.toThrow('Too many failed attempts');
    });

    it('enforces rate limiting', async () => {
      const phone = '+447911123461';
      const purpose = 'login';

      for (let i = 0; i < 3; i++) {
        await requestOtp(db, sms, phone, purpose);
      }

      await expect(requestOtp(db, sms, phone, purpose)).rejects.toThrow('Too many OTP requests');
    });
  });

  describe('shadow accounts', () => {
    it('creates shadow on first OTP verify', async () => {
      const phone = '+447911123462';
      const purpose = 'login';

      await requestOtp(db, sms, phone, purpose);
      const result = await verifyOtp(db, phone, sms.lastCode!, purpose);

      const user = await db.query.users.findFirst({
        where: (t, { eq }) => eq(t.id, result.userId),
      });
      expect(user).toBeDefined();
      expect(user!.isShadow).toBe(true);
      expect(user!.shadowExpiresAt).toBeDefined();
    });

    it('reuses existing identity on second verify', async () => {
      const phone = '+447911123463';
      const purpose = 'login';

      await requestOtp(db, sms, phone, purpose);
      const first = await verifyOtp(db, phone, sms.lastCode!, purpose);

      await requestOtp(db, sms, phone, purpose);
      const second = await verifyOtp(db, phone, sms.lastCode!, purpose);

      expect(second.userId).toBe(first.userId);
      expect(second.isNew).toBe(false);
    });

    it('upgrades shadow to full account', async () => {
      const phone = '+447911123464';
      const purpose = 'login';

      await requestOtp(db, sms, phone, purpose);
      const result = await verifyOtp(db, phone, sms.lastCode!, purpose);

      const res = await request(app)
        .post('/api/v1/auth/otp/upgrade')
        .set('Authorization', `Bearer ${await getAccessToken(result.userId)}`)
        .send({ password: 'newpassword123' });

      expect(res.status).toBe(200);
      expect(res.body.upgraded).toBe(true);

      const user = await db.query.users.findFirst({
        where: (t, { eq }) => eq(t.id, result.userId),
      });
      expect(user!.isShadow).toBe(false);
      expect(user!.upgradedAt).toBeDefined();
    });
  });

  describe('capability links', () => {
    it('issues and verifies a capability link', async () => {
      const result = await issueCapabilityLink(db, {
        action: 'BOOKING',
        payload: { phone: '+447911123465', priceCents: 1500 },
      });

      expect(result.nonce).toBeDefined();
      expect(result.expiresAt).toBeInstanceOf(Date);

      const verified = await verifyCapabilityLink(db, result.nonce);
      expect(verified.action).toBe('BOOKING');
      expect((verified.payload as Record<string, unknown>).phone).toBe('+447911123465');
    });

    it('rejects expired capability links', async () => {
      const result = await issueCapabilityLink(db, {
        action: 'BOOKING',
        payload: { phone: '+447911123466', priceCents: 1500 },
        expiresInMinutes: -1,
      });

      await expect(verifyCapabilityLink(db, result.nonce)).rejects.toThrow('expired');
    });

    it('rejects used capability links', async () => {
      const result = await issueCapabilityLink(db, {
        action: 'BOOKING',
        payload: { phone: '+447911123467', priceCents: 1500 },
      });

      await consumeCapabilityLink(db, result.nonce, 'some-shipment-id');
      await expect(consumeCapabilityLink(db, result.nonce, 'another-shipment-id')).rejects.toThrow('already been used');
    });

    it('cannot consume expired links', async () => {
      const result = await issueCapabilityLink(db, {
        action: 'BOOKING',
        payload: { phone: '+447911123468', priceCents: 1500 },
        expiresInMinutes: -1,
      });

      await expect(consumeCapabilityLink(db, result.nonce, 'some-shipment-id')).rejects.toThrow('expired');
    });

    it('books via capability link and creates session', async () => {
      const nonceResult = await issueCapabilityLink(db, {
        action: 'BOOKING',
        payload: { phone: '+447911123469', priceCents: 1500 },
      });

      const bookRes = await request(app)
        .post(`/api/v1/capability/${nonceResult.nonce}/book`);

      expect(bookRes.status).toBe(200);
      expect(bookRes.body.accessToken).toBeDefined();
      expect(bookRes.body.refreshToken).toBeDefined();
      expect(bookRes.body.shadowUser).toBeDefined();
    });

    it('tracks via capability link', async () => {
      const nonceResult = await issueCapabilityLink(db, {
        action: 'TRACKING',
        payload: { shipmentId: '00000000-0000-0000-0000-000000000001' },
      });

      const trackRes = await request(app)
        .get(`/api/v1/capability/${nonceResult.nonce}/track`);

      expect(trackRes.status).toBe(200);
      expect(trackRes.body.shipment).toBeDefined();
    });
  });

  async function getAccessToken(userId: string): Promise<string> {
    const { signAccessToken } = await import('../src/auth/tokens.js');
    const { getConfig } = await import('../src/config.js');
    const config = getConfig();

    return signAccessToken(
      { sub: userId, email: '', role: 'CUSTOMER', jti: 'test-session' },
      config.jwtAccessSecret,
      config.jwtAccessTtl,
    );
  }
});
