import { eq } from 'drizzle-orm';
import { createHash } from 'crypto';

import {
  idempotencyKeys,
  packages as packagesTable,
  shipments,
  shipmentEvents,
} from '@logistics/db';

import { writeAudit } from '../auth/audit.js';
import type { AuthContext } from '../auth/middleware.js';
import type { Db } from '../../shared/db.js';
import { badRequest, conflict } from '../../shared/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PackageInput {
  sizeClass: 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE';
  weightClass: 'LIGHT' | 'MEDIUM' | 'HEAVY' | 'EXTRA_HEAVY';
  quantity: number;
}

export interface QuoteBreakdownItem {
  sizeClass: string;
  weightClass: string;
  quantity: number;
  amountCentsPerUnit: number;
  subtotalCents: number;
  ruleId: string;
}

export interface QuoteResult {
  amountCents: number;
  currency: string;
  breakdown: QuoteBreakdownItem[];
}

export interface BookingInput {
  senderUserId: string;
  senderName?: string;
  senderEmail?: string;
  senderPhone?: string;
  recipientName: string;
  recipientEmail?: string;
  recipientPhone?: string;
  pickupLocationId: string;
  destinationZoneId: string;
  deliveryOptionId: string;
  packages: PackageInput[];
  currency?: string;
  category?: string;
  specialInstructions?: string;
  scheduledFor?: Date;
  customPriceCents?: number;
  idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Quote computation
// ---------------------------------------------------------------------------

export async function computeQuote(
  db: Db,
  input: {
    originZoneId: string;
    destinationZoneId: string;
    packages: PackageInput[];
    deliveryOptionId: string;
    currency: string;
  },
): Promise<QuoteResult> {
  // Validate origin zone
  const originZone = await db.query.zones.findFirst({
    where: (t, { eq }) => eq(t.id, input.originZoneId),
  });
  if (!originZone) throw badRequest('VALIDATION', 'Origin zone not found');

  // Validate destination zone
  const destZone = await db.query.zones.findFirst({
    where: (t, { eq }) => eq(t.id, input.destinationZoneId),
  });
  if (!destZone) throw badRequest('VALIDATION', 'Destination zone not found');

  // Validate delivery option
  const deliveryOption = await db.query.deliveryOptions.findFirst({
    where: (t, { eq, and }) => and(eq(t.id, input.deliveryOptionId), eq(t.isActive, true)),
  });
  if (!deliveryOption) throw badRequest('VALIDATION', 'Delivery option not found or inactive');

  // Validate currency
  const validCurrencies = ['USD', 'EUR', 'GBP'];
  if (!validCurrencies.includes(input.currency)) {
    throw badRequest('VALIDATION', 'Invalid currency');
  }

  if (input.packages.length === 0) {
    throw badRequest('VALIDATION', 'At least one package is required');
  }

  const now = new Date();
  const breakdown: QuoteBreakdownItem[] = [];
  let totalAmountCents = 0;

  for (const pkg of input.packages) {
    if (pkg.quantity < 1) {
      throw badRequest('VALIDATION', 'Package quantity must be at least 1');
    }

    // Find matching active pricing rule
    const rule = await db.query.pricingRules.findFirst({
      where: (t, { and, eq, gt, lte, or, isNull }) =>
        and(
          eq(t.originZoneId, input.originZoneId),
          eq(t.destinationZoneId, input.destinationZoneId),
          eq(t.sizeClass, pkg.sizeClass),
          eq(t.weightClass, pkg.weightClass),
          eq(t.deliveryOptionId, input.deliveryOptionId),
          eq(t.currency, input.currency as 'USD' | 'EUR' | 'GBP'),
          eq(t.isActive, true),
          lte(t.validFrom, now),
          or(isNull(t.validTo), gt(t.validTo, now)),
        ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });

    if (!rule) {
      throw badRequest(
        'NO_PRICING_RULE',
        `No active pricing rule for ${pkg.sizeClass}/${pkg.weightClass} on this route`,
      );
    }

    const subtotalCents = rule.amountCents * pkg.quantity;
    totalAmountCents += subtotalCents;

    breakdown.push({
      sizeClass: pkg.sizeClass,
      weightClass: pkg.weightClass,
      quantity: pkg.quantity,
      amountCentsPerUnit: rule.amountCents,
      subtotalCents,
      ruleId: rule.id,
    });
  }

  return {
    amountCents: totalAmountCents,
    currency: input.currency,
    breakdown,
  };
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((k) => [k, canonicalize(source[k])]),
    );
  }
  return value;
}

function hashRequest(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(input))).digest('hex');
}

export async function createBooking(db: Db, ctx: AuthContext, input: BookingInput) {
  let quote: QuoteResult;
  let pricingSource: 'computed' | 'custom' = 'computed';

  // Resolve origin zone from pickup location
  const pickupLoc = await db.query.pickupLocations.findFirst({
    where: (t, { eq }) => eq(t.id, input.pickupLocationId),
  });
  if (!pickupLoc) throw badRequest('VALIDATION', 'Pickup location not found');
  if (!pickupLoc.zoneId) {
    throw badRequest('VALIDATION', 'Pickup location has no associated zone');
  }
  const originZoneId = pickupLoc.zoneId;

  // Validate destination zone
  const destZone = await db.query.zones.findFirst({
    where: (t, { eq }) => eq(t.id, input.destinationZoneId),
  });
  if (!destZone) throw badRequest('VALIDATION', 'Destination zone not found');

  // Validate delivery option
  const deliveryOption = await db.query.deliveryOptions.findFirst({
    where: (t, { eq, and }) => and(eq(t.id, input.deliveryOptionId), eq(t.isActive, true)),
  });
  if (!deliveryOption) throw badRequest('VALIDATION', 'Delivery option not found or inactive');

  // Idempotency check
  let idempotencyEntry: { id: string; requestHash: string } | null = null;
  if (input.idempotencyKey) {
    const requestHash = hashRequest({
      originZoneId,
      destinationZoneId: input.destinationZoneId,
      deliveryOptionId: input.deliveryOptionId,
      packages: input.packages,
      recipientName: input.recipientName,
    });

    const existing = await db.query.idempotencyKeys.findFirst({
      where: (t, { and: both, eq: eql }) =>
        both(eql(t.userId, ctx.userId), eql(t.key, input.idempotencyKey!)),
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency key reused with different payload');
      }
      if (existing.response) {
        return existing.response as Record<string, unknown>;
      }
      if (existing.shipmentId) {
        const [claimed] = await db
          .select()
          .from(shipments)
          .where(eq(shipments.id, existing.shipmentId));
        if (claimed) return claimed as unknown as Record<string, unknown>;
      }
      idempotencyEntry = { id: existing.id, requestHash };
    } else {
      const [entry] = await db
        .insert(idempotencyKeys)
        .values({
          userId: ctx.userId,
          key: input.idempotencyKey,
          requestHash,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        })
        .onConflictDoNothing({ target: [idempotencyKeys.userId, idempotencyKeys.key] })
        .returning({ id: idempotencyKeys.id, requestHash: idempotencyKeys.requestHash });
      if (entry) {
        idempotencyEntry = entry;
      } else {
        throw conflict('IDEMPOTENCY_IN_FLIGHT', 'A request with this idempotency key is in flight');
      }
    }
  }

  if (input.customPriceCents !== undefined) {
    if (ctx.roleName !== 'MERCHANT' && ctx.roleName !== 'ADMIN') {
      throw badRequest('INVALID_CUSTOM_PRICE', 'Only merchants and admins can set custom prices');
    }

    const computedQuote = await computeQuote(db, {
      originZoneId,
      destinationZoneId: input.destinationZoneId,
      packages: input.packages,
      deliveryOptionId: input.deliveryOptionId,
      currency: input.currency ?? 'GBP',
    });

    const deviation =
      computedQuote.amountCents > 0
        ? Math.abs(input.customPriceCents - computedQuote.amountCents) / computedQuote.amountCents
        : null;
    if (deviation !== null && deviation > 0.5) {
      await writeAudit(db, ctx, {
        action: 'pricing.custom_price_warning',
        entityType: 'shipment',
        payload: {
          computedAmountCents: computedQuote.amountCents,
          customAmountCents: input.customPriceCents,
          deviation: Math.round(deviation * 100),
        },
      });
    } else if (deviation === null) {
      await writeAudit(db, ctx, {
        action: 'pricing.custom_price_unpriced',
        entityType: 'shipment',
        payload: { customAmountCents: input.customPriceCents },
      });
    }

    quote = {
      amountCents: input.customPriceCents,
      currency: computedQuote.currency,
      breakdown: computedQuote.breakdown,
    };
    pricingSource = 'custom';
  } else {
    quote = await computeQuote(db, {
      originZoneId,
      destinationZoneId: input.destinationZoneId,
      packages: input.packages,
      deliveryOptionId: input.deliveryOptionId,
      currency: input.currency ?? 'GBP',
    });
  }

  // Build immutable quote snapshot
  const quoteSnapshot = {
    totalAmountCents: quote.amountCents,
    currency: quote.currency,
    deliveryOptionId: input.deliveryOptionId,
    deliveryOptionCode: deliveryOption.code,
    originZoneId,
    destinationZoneId: input.destinationZoneId,
    packages: quote.breakdown,
    pricingSource,
    computedAt: new Date().toISOString(),
  };

return db.transaction(async (tx) => {
    const [shipment] = await tx
      .insert(shipments)
      .values({
        status: 'BOOKED' as const,
        senderUserId: ctx.userId,
        senderName: input.senderName ?? null,
        senderEmail: input.senderEmail ?? null,
        senderPhone: input.senderPhone ?? null,
        recipientName: input.recipientName,
        recipientEmail: input.recipientEmail ?? null,
        recipientPhone: input.recipientPhone ?? null,
        pickupLocationId: input.pickupLocationId,
        destinationZoneId: input.destinationZoneId,
        deliveryOptionId: input.deliveryOptionId,
        quoteAmountCents: quote.amountCents,
        quoteCurrency: quote.currency as 'USD' | 'EUR' | 'GBP',
        quoteSnapshot,
        scheduledFor: input.scheduledFor ?? null,
        specialInstructions: input.specialInstructions ?? null,
        category: input.category ?? null,
        createdByUserId: ctx.userId,
      })
      .returning();
    if (!shipment) throw new Error('createBooking: insert returned nothing');

    await tx.insert(packagesTable).values(
      input.packages.map((pkg) => ({
        shipmentId: shipment.id,
        sizeClass: pkg.sizeClass,
        weightClass: pkg.weightClass,
        quantity: pkg.quantity,
      })),
    );

    await tx.insert(shipmentEvents).values({
      shipmentId: shipment.id,
      fromStatus: null,
      toStatus: 'BOOKED',
      actorUserId: ctx.userId,
      occurredAt: new Date(),
    });

    if (idempotencyEntry) {
      await tx
        .update(idempotencyKeys)
        .set({ shipmentId: shipment.id, response: shipment })
        .where(eq(idempotencyKeys.id, idempotencyEntry.id));
    }

    await writeAudit(tx as unknown as Db, ctx, {
      action: 'booking.create',
      entityType: 'shipment',
      entityId: shipment.id,
      payload: { quoteSnapshot },
    });

    return shipment;
  });
}
