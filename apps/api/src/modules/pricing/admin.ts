import { and, eq } from 'drizzle-orm';

import { deliveryOptions, pricingRules } from '@logistics/db';

import { writeAudit } from '../auth/audit.js';
import type { AuthContext } from '../auth/middleware.js';
import type { Db } from '../../shared/db.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';

// ---------------------------------------------------------------------------
// Admin: pricing rules and delivery options
// ---------------------------------------------------------------------------

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
