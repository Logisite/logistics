import { and, eq } from 'drizzle-orm';
import { createHash } from 'crypto';

import {
  deliveryOptions,
  idempotencyKeys,
  packages as packagesTable,
  pricingRules,
  shipments,
  shipmentEvents,
} from '@logistics/db';

import { writeAudit } from '../auth/audit.js';
import type { AuthContext } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';

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

function hashRequest(input: Record<string, unknown>): string {
  const sorted = JSON.stringify(input, Object.keys(input).sort());
  return createHash('sha256').update(sorted).digest('hex');
}

export async function createBooking(db: Db, ctx: AuthContext, input: BookingInput) {
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
    const hashPayload = {
      originZoneId,
      destinationZoneId: input.destinationZoneId,
      deliveryOptionId: input.deliveryOptionId,
      packages: input.packages,
      recipientName: input.recipientName,
    };
    const requestHash = hashRequest(hashPayload);

    const existing = await db.query.idempotencyKeys.findFirst({
      where: (t, { eq }) => eq(t.key, input.idempotencyKey!),
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency key reused with different payload');
      }
      if (existing.response) {
        return existing.response as Record<string, unknown>;
      }
    } else {
      const [entry] = await db
        .insert(idempotencyKeys)
        .values({
          key: input.idempotencyKey,
          requestHash,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
        })
        .returning({ id: idempotencyKeys.id, requestHash: idempotencyKeys.requestHash });
      idempotencyEntry = entry ?? null;
    }
  }

  // Compute quote (or use custom price)
  let quote: QuoteResult;
  let pricingSource: 'computed' | 'custom' = 'computed';

  if (input.customPriceCents !== undefined) {
    // Only MERCHANT and ADMIN can use custom pricing
    if (ctx.roleName !== 'MERCHANT' && ctx.roleName !== 'ADMIN') {
      throw badRequest('INVALID_CUSTOM_PRICE', 'Only merchants and admins can set custom prices');
    }

    // Compute the normal price for comparison
    const computedQuote = await computeQuote(db, {
      originZoneId,
      destinationZoneId: input.destinationZoneId,
      packages: input.packages,
      deliveryOptionId: input.deliveryOptionId,
      currency: input.currency ?? 'GBP',
    });

    // Warn if custom price deviates significantly
    const deviation =
      Math.abs(input.customPriceCents - computedQuote.amountCents) / computedQuote.amountCents;
    if (deviation > 0.5) {
      await writeAudit(db, ctx, {
        action: 'pricing.custom_price_warning',
        entityType: 'shipment',
        payload: {
          computedAmountCents: computedQuote.amountCents,
          customAmountCents: input.customPriceCents,
          deviation: Math.round(deviation * 100),
        },
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

  // Create shipment
  const [shipment] = await db
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

  // Create package rows
  for (const pkg of input.packages) {
    await db.insert(packagesTable).values({
      shipmentId: shipment.id,
      sizeClass: pkg.sizeClass,
      weightClass: pkg.weightClass,
      quantity: pkg.quantity,
    });
  }

  // Append shipment event
  const now = new Date();
  await db.insert(shipmentEvents).values({
    shipmentId: shipment.id,
    fromStatus: null,
    toStatus: 'BOOKED',
    actorUserId: ctx.userId,
    occurredAt: now,
  });

  // Update idempotency entry with response
  if (idempotencyEntry) {
    await db
      .update(idempotencyKeys)
      .set({ shipmentId: shipment.id, response: shipment })
      .where(eq(idempotencyKeys.id, idempotencyEntry.id));
  }

  await writeAudit(db, ctx, {
    action: 'booking.create',
    entityType: 'shipment',
    entityId: shipment.id,
    payload: { quoteSnapshot },
  });

  return shipment;
}

// ---------------------------------------------------------------------------
// Cancel booking
// ---------------------------------------------------------------------------

export async function cancelBooking(db: Db, ctx: AuthContext, shipmentId: string) {
  const shipment = await db.query.shipments.findFirst({
    where: (t, { eq }) => eq(t.id, shipmentId),
  });
  if (!shipment) throw notFound('NOT_FOUND', 'Shipment not found');

  if (shipment.status !== 'BOOKED' && shipment.status !== 'DRAFT') {
    throw badRequest('INVALID_STATUS', 'Only BOOKED or DRAFT shipments can be cancelled');
  }

  const [updated] = await db
    .update(shipments)
    .set({ status: 'CANCELLED', updatedAt: new Date() })
    .where(eq(shipments.id, shipmentId))
    .returning();
  if (!updated) throw new Error('cancelBooking: update returned nothing');

  await db.insert(shipmentEvents).values({
    shipmentId: shipment.id,
    fromStatus: shipment.status,
    toStatus: 'CANCELLED',
    actorUserId: ctx.userId,
    occurredAt: new Date(),
  });

  await writeAudit(db, ctx, {
    action: 'booking.cancel',
    entityType: 'shipment',
    entityId: shipment.id,
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Admin: Pricing rules CRUD
// ---------------------------------------------------------------------------

export async function listPricingRules(
  db: Db,
  filters?: {
    originZoneId?: string;
    destinationZoneId?: string;
    deliveryOptionId?: string;
    currency?: string;
    isActive?: boolean;
    sizeClass?: string;
    weightClass?: string;
  },
) {
  const conditions = [];
  if (filters?.originZoneId) {
    conditions.push(eq(pricingRules.originZoneId, filters.originZoneId));
  }
  if (filters?.destinationZoneId) {
    conditions.push(eq(pricingRules.destinationZoneId, filters.destinationZoneId));
  }
  if (filters?.deliveryOptionId) {
    conditions.push(eq(pricingRules.deliveryOptionId, filters.deliveryOptionId));
  }
  if (filters?.currency) {
    conditions.push(eq(pricingRules.currency, filters.currency as 'USD' | 'EUR' | 'GBP'));
  }
  if (filters?.isActive !== undefined) {
    conditions.push(eq(pricingRules.isActive, filters.isActive));
  }
  if (filters?.sizeClass) {
    conditions.push(
      eq(pricingRules.sizeClass, filters.sizeClass as 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE'),
    );
  }
  if (filters?.weightClass) {
    conditions.push(
      eq(
        pricingRules.weightClass,
        filters.weightClass as 'LIGHT' | 'MEDIUM' | 'HEAVY' | 'EXTRA_HEAVY',
      ),
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  return db.query.pricingRules.findMany({
    where,
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
}

export async function createPricingRule(
  db: Db,
  ctx: AuthContext,
  input: {
    originZoneId: string;
    destinationZoneId: string;
    sizeClass: string;
    weightClass: string;
    deliveryOptionId: string;
    currency: string;
    amountCents: number;
    validFrom: Date;
    validTo?: Date | null;
  },
) {
  // Validate zones
  const originZone = await db.query.zones.findFirst({
    where: (t, { eq }) => eq(t.id, input.originZoneId),
  });
  if (!originZone) throw badRequest('VALIDATION', 'Origin zone not found');

  const destZone = await db.query.zones.findFirst({
    where: (t, { eq }) => eq(t.id, input.destinationZoneId),
  });
  if (!destZone) throw badRequest('VALIDATION', 'Destination zone not found');

  // Validate delivery option
  const deliveryOption = await db.query.deliveryOptions.findFirst({
    where: (t, { eq }) => eq(t.id, input.deliveryOptionId),
  });
  if (!deliveryOption) throw badRequest('VALIDATION', 'Delivery option not found');

  // Check for duplicate active rule
  const now = new Date();
  const existingRule = await db.query.pricingRules.findFirst({
    where: (t, { and, eq, gt, lte, or, isNull }) =>
      and(
        eq(t.originZoneId, input.originZoneId),
        eq(t.destinationZoneId, input.destinationZoneId),
        eq(t.sizeClass, input.sizeClass as 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE'),
        eq(t.weightClass, input.weightClass as 'LIGHT' | 'MEDIUM' | 'HEAVY' | 'EXTRA_HEAVY'),
        eq(t.deliveryOptionId, input.deliveryOptionId),
        eq(t.currency, input.currency as 'USD' | 'EUR' | 'GBP'),
        eq(t.isActive, true),
        lte(t.validFrom, now),
        or(isNull(t.validTo), gt(t.validTo, now)),
      ),
  });

  if (existingRule) {
    throw conflict(
      'DUPLICATE_RULE',
      'An active pricing rule already exists for this configuration',
    );
  }

  const [rule] = await db
    .insert(pricingRules)
    .values({
      originZoneId: input.originZoneId,
      destinationZoneId: input.destinationZoneId,
      sizeClass: input.sizeClass as 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE',
      weightClass: input.weightClass as 'LIGHT' | 'MEDIUM' | 'HEAVY' | 'EXTRA_HEAVY',
      deliveryOptionId: input.deliveryOptionId,
      currency: input.currency as 'USD' | 'EUR' | 'GBP',
      amountCents: input.amountCents,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
    })
    .returning();
  if (!rule) throw new Error('createPricingRule: insert returned nothing');

  await writeAudit(db, ctx, {
    action: 'pricing_rule.create',
    entityType: 'pricing_rule',
    entityId: rule.id,
  });

  return rule;
}

export async function updatePricingRule(
  db: Db,
  ctx: AuthContext,
  ruleId: string,
  input: {
    amountCents?: number;
    isActive?: boolean;
    validFrom?: Date;
    validTo?: Date | null;
  },
) {
  const existing = await db.query.pricingRules.findFirst({
    where: (t, { eq }) => eq(t.id, ruleId),
  });
  if (!existing) throw notFound('NOT_FOUND', 'Pricing rule not found');

  const [rule] = await db
    .update(pricingRules)
    .set({
      ...(input.amountCents !== undefined && { amountCents: input.amountCents }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.validFrom !== undefined && { validFrom: input.validFrom }),
      ...(input.validTo !== undefined && { validTo: input.validTo }),
    })
    .where(eq(pricingRules.id, ruleId))
    .returning();
  if (!rule) throw new Error('updatePricingRule: update returned nothing');

  await writeAudit(db, ctx, {
    action: 'pricing_rule.update',
    entityType: 'pricing_rule',
    entityId: rule.id,
  });

  return rule;
}

// ---------------------------------------------------------------------------
// Admin: Delivery options CRUD
// ---------------------------------------------------------------------------

export async function listDeliveryOptions(db: Db) {
  return db.query.deliveryOptions.findMany({
    orderBy: (t, { asc }) => [asc(t.code)],
  });
}

export async function createDeliveryOption(
  db: Db,
  ctx: AuthContext,
  input: { code: string; name: string; description?: string },
) {
  const existing = await db.query.deliveryOptions.findFirst({
    where: (t, { eq }) => eq(t.code, input.code as 'STANDARD' | 'EXPRESS' | 'SAME_DAY' | 'SCHEDULED' | 'PICKUP_AT_LOCATION' | 'DROP_OFF_AT_LOCATION'),
  });
  if (existing) throw conflict('CONFLICT', 'Delivery option code already exists');

  const [option] = await db
    .insert(deliveryOptions)
    .values({
      code: input.code as 'STANDARD' | 'EXPRESS' | 'SAME_DAY' | 'SCHEDULED' | 'PICKUP_AT_LOCATION' | 'DROP_OFF_AT_LOCATION',
      name: input.name,
      description: input.description ?? null,
    })
    .returning();
  if (!option) throw new Error('createDeliveryOption: insert returned nothing');

  await writeAudit(db, ctx, {
    action: 'delivery_option.create',
    entityType: 'delivery_option',
    entityId: option.id,
  });

  return option;
}

export async function updateDeliveryOption(
  db: Db,
  ctx: AuthContext,
  optionId: string,
  input: { name?: string; description?: string; isActive?: boolean },
) {
  const existing = await db.query.deliveryOptions.findFirst({
    where: (t, { eq }) => eq(t.id, optionId),
  });
  if (!existing) throw notFound('NOT_FOUND', 'Delivery option not found');

  const [option] = await db
    .update(deliveryOptions)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    })
    .where(eq(deliveryOptions.id, optionId))
    .returning();
  if (!option) throw new Error('updateDeliveryOption: update returned nothing');

  await writeAudit(db, ctx, {
    action: 'delivery_option.update',
    entityType: 'delivery_option',
    entityId: option.id,
  });

  return option;
}
