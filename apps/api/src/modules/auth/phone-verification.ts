import { randomInt } from 'node:crypto';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

import { phoneOtps, contactIdentities, users, roleGrants } from '@logistics/db';

import { getConfig } from '../../shared/config.js';
import type { Db } from '../../shared/db.js';
import { badRequest, unauthorized } from '../../shared/errors.js';
import { HttpError } from '../../shared/errors.js';

import { writeAudit } from './audit.js';
import type { SmsProvider } from './sms.js';

const OTP_LENGTH = 6;
const OTP_EXPIRY_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 3;
const OTP_SEND_LIMIT_PHONE = 3;
const OTP_RESEND_COOLDOWN_MS = 30_000;

function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(OTP_LENGTH, '0');
}

async function hashOtp(code: string): Promise<string> {
  return bcrypt.hash(code, 10);
}

async function verifyOtpHash(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash);
}

export interface RequestOtpResult {
  sent: boolean;
  cooldownSeconds?: number;
}

export async function requestOtp(
  db: Db,
  sms: SmsProvider,
  phone: string,
  purpose: string,
): Promise<RequestOtpResult> {
  const now = new Date();
  const cooldownWindow = new Date(now.getTime() - OTP_RESEND_COOLDOWN_MS);

  const recentForPhone = await db
    .select({ id: phoneOtps.id })
    .from(phoneOtps)
    .where(
      and(
        eq(phoneOtps.phone, phone),
        eq(phoneOtps.purpose, purpose),
        gt(phoneOtps.createdAt, cooldownWindow),
      ),
    )
    .limit(1);

  if (recentForPhone.length > 0) {
    const remaining = Math.ceil(OTP_RESEND_COOLDOWN_MS / 1000);
    return { sent: false, cooldownSeconds: remaining };
  }

  const hourAgo = new Date(now.getTime() - 3_600_000);
  const sendCountPhone = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(phoneOtps)
    .where(
      and(
        eq(phoneOtps.phone, phone),
        eq(phoneOtps.purpose, purpose),
        gt(phoneOtps.createdAt, hourAgo),
      ),
    );
  if ((sendCountPhone[0]?.count ?? 0) >= OTP_SEND_LIMIT_PHONE) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many OTP requests. Try again later.');
  }

  const code = generateOtp();
  const codeHash = await hashOtp(code);

  await db.insert(phoneOtps).values({
    phone,
    codeHash,
    purpose,
    maxAttempts: OTP_MAX_ATTEMPTS,
    expiresAt: new Date(now.getTime() + OTP_EXPIRY_MS),
  });

  await sms.sendOtp(phone, code);

  await writeAudit(db, null, {
    action: 'identity.otp-request',
    entityType: 'phone',
    payload: { phone, purpose },
  });

  return { sent: true };
}

export interface VerifyOtpResult {
  userId: string;
  isNew: boolean;
}

async function findOrCreateUserByPhone(
  db: Db,
  phone: string,
  country: string,
): Promise<{ userId: string; isNew: boolean }> {
  const existing = await db.query.contactIdentities.findFirst({
    where: (ci, { and, eq }) => and(eq(ci.channel, 'PHONE'), eq(ci.identifier, phone)),
  });

  if (existing) {
    return { userId: existing.userId, isNew: false };
  }

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

  if (!user) throw new Error('findOrCreateUserByPhone: insert returned nothing');

  const customerRole = await db.query.roles.findFirst({
    where: (roles, { eq }) => eq(roles.name, 'CUSTOMER'),
  });
  if (customerRole) {
    await db.insert(roleGrants).values({ userId: user.id, roleId: customerRole.id });
  }

  await db.insert(contactIdentities).values({
    userId: user.id,
    channel: 'PHONE',
    identifier: phone,
    country,
    verifiedAt: now,
  });

  await writeAudit(db, null, {
    action: 'identity.shadow-mint',
    entityType: 'user',
    entityId: user.id,
    payload: { phone, purpose: 'otp-verify' },
  });

  return { userId: user.id, isNew: true };
}

export async function verifyOtp(
  db: Db,
  phone: string,
  code: string,
  purpose: string,
  country?: string,
): Promise<VerifyOtpResult> {
  const now = new Date();

  const [otp] = await db
    .select()
    .from(phoneOtps)
    .where(
      and(
        eq(phoneOtps.phone, phone),
        eq(phoneOtps.purpose, purpose),
        isNull(phoneOtps.verifiedAt),
        gt(phoneOtps.expiresAt, now),
      ),
    )
    .orderBy(sql`${phoneOtps.createdAt} DESC`)
    .limit(1);

  if (!otp) {
    const expired = await db
      .select({ id: phoneOtps.id })
      .from(phoneOtps)
      .where(
        and(
          eq(phoneOtps.phone, phone),
          eq(phoneOtps.purpose, purpose),
          isNull(phoneOtps.verifiedAt),
          sql`${phoneOtps.expiresAt} <= ${now}`,
        ),
      )
      .orderBy(sql`${phoneOtps.createdAt} DESC`)
      .limit(1);

    if (expired.length > 0) {
      throw badRequest('OTP_EXPIRED', 'This code has expired. Request a new one.');
    }
    throw badRequest('INVALID_OTP', 'Invalid verification code.');
  }

  if (otp.attempts >= otp.maxAttempts) {
    throw unauthorized('OTP_EXHAUSTED', 'Too many failed attempts. Request a new code.');
  }

  const match = await verifyOtpHash(code, otp.codeHash);
  if (!match) {
    await db
      .update(phoneOtps)
      .set({ attempts: otp.attempts + 1 })
      .where(eq(phoneOtps.id, otp.id));
    throw badRequest('INVALID_OTP', 'Invalid verification code.');
  }

  await db.update(phoneOtps).set({ verifiedAt: now }).where(eq(phoneOtps.id, otp.id));

  const { userId, isNew } = await findOrCreateUserByPhone(db, phone, country ?? '');

  await writeAudit(db, null, {
    action: 'identity.otp-verify',
    entityType: 'user',
    entityId: userId,
    payload: { phone, purpose, isNew },
  });

  return { userId, isNew };
}
