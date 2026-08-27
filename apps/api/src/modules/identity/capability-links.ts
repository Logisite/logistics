import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import { capabilityLinks } from '@logistics/db';

import { getConfig } from '../../shared/config.js';
import type { Db } from '../../shared/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { writeAudit } from '../auth/audit.js';

export type CapabilityAction = 'BOOKING' | 'TRACKING' | 'CLAIM';

const DEFAULT_EXPIRY_MINUTES: Record<string, number> = {
  BOOKING: 24 * 60,
  TRACKING: 7 * 24 * 60,
  CLAIM: 60,
};

function generateNonce(): string {
  return randomBytes(24).toString('base64url');
}

function computeHmac(nonce: string, payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${nonce}.${payload}`).digest('base64url');
}

function verifyHmac(nonce: string, payload: string, signature: string, secret: string): boolean {
  const expected = computeHmac(nonce, payload, secret);
  const sigBuf = Buffer.from(signature, 'base64url');
  const expBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

export interface IssueCapabilityLinkInput {
  action: CapabilityAction;
  payload: Record<string, unknown>;
  senderUserId?: string;
  expiresInMinutes?: number;
}

export interface IssuedCapabilityLink {
  nonce: string;
  expiresAt: Date;
}

export async function issueCapabilityLink(
  db: Db,
  input: IssueCapabilityLinkInput,
): Promise<IssuedCapabilityLink> {
  const config = getConfig();
  const nonce = generateNonce();
  const payloadStr = JSON.stringify(input.payload);
  const hmac = computeHmac(nonce, payloadStr, config.capabilityLinkSecret);
  const expiryMinutes = input.expiresInMinutes ?? DEFAULT_EXPIRY_MINUTES[input.action] ?? 24 * 60;
  const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

  await db.insert(capabilityLinks).values({
    nonce,
    action: input.action,
    hmacSignature: hmac,
    senderUserId: input.senderUserId ?? null,
    payload: input.payload,
    expiresAt,
  });

  return { nonce, expiresAt };
}

export interface VerifiedCapabilityLink {
  id: string;
  action: string;
  payload: Record<string, unknown>;
  senderUserId: string | null;
  shipmentId: string | null;
  expiresAt: Date;
}

export async function verifyCapabilityLink(
  db: Db,
  nonce: string,
): Promise<VerifiedCapabilityLink> {
  const config = getConfig();
  const link = await db.query.capabilityLinks.findFirst({
    where: (capabilityLinks, { eq }) => eq(capabilityLinks.nonce, nonce),
  });

  if (!link) throw notFound('LINK_NOT_FOUND', 'Invalid capability link');
  if (link.usedAt) throw conflict('LINK_USED', 'This link has already been used');
  if (link.revokedAt) throw forbidden('LINK_REVOKED', 'This link has been revoked');
  if (link.expiresAt < new Date()) throw badRequest('LINK_EXPIRED', 'This link has expired');

  const payloadStr = JSON.stringify(link.payload);
  if (!verifyHmac(nonce, payloadStr, link.hmacSignature, config.capabilityLinkSecret)) {
    throw badRequest('LINK_INVALID', 'Invalid capability link signature');
  }

  return {
    id: link.id,
    action: link.action,
    payload: link.payload as Record<string, unknown>,
    senderUserId: link.senderUserId,
    shipmentId: link.shipmentId,
    expiresAt: link.expiresAt,
  };
}

export async function consumeCapabilityLink(
  db: Db,
  nonce: string,
  shipmentId: string,
): Promise<void> {
  const link = await db.query.capabilityLinks.findFirst({
    where: (capabilityLinks, { eq }) => eq(capabilityLinks.nonce, nonce),
  });

  if (!link) throw notFound('LINK_NOT_FOUND', 'Invalid capability link');
  if (link.usedAt) throw conflict('LINK_USED', 'This link has already been used');
  if (link.revokedAt) throw forbidden('LINK_REVOKED', 'This link has been revoked');
  if (link.expiresAt < new Date()) throw badRequest('LINK_EXPIRED', 'This link has expired');

  await db
    .update(capabilityLinks)
    .set({ usedAt: new Date(), shipmentId })
    .where(eq(capabilityLinks.id, link.id));
}

export async function revokeCapabilityLink(
  db: Db,
  linkId: string,
  revokedBy: string,
): Promise<void> {
  const [updated] = await db
    .update(capabilityLinks)
    .set({ revokedAt: new Date(), revokedBy })
    .where(and(eq(capabilityLinks.id, linkId), isNull(capabilityLinks.revokedAt)))
    .returning({ id: capabilityLinks.id });

  if (!updated) throw notFound('LINK_NOT_FOUND', 'Link not found or already revoked');

  await writeAudit(db, null, {
    action: 'identity.capability-revoke',
    entityType: 'capability_link',
    entityId: linkId,
    payload: { revokedBy },
  });
}
