import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../db.js';
import { badRequest } from '../errors.js';
import type { AuthContext } from '../auth/middleware.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PERMISSIONS } from '../auth/permissions.js';

import * as service from './service.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const packageSchema = z.object({
  sizeClass: z.enum(['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE']),
  weightClass: z.enum(['LIGHT', 'MEDIUM', 'HEAVY', 'EXTRA_HEAVY']),
  quantity: z.number().int().min(1),
});

const quoteSchema = z.object({
  originZoneId: z.string().uuid(),
  destinationZoneId: z.string().uuid(),
  packages: z.array(packageSchema).min(1),
  deliveryOptionId: z.string().uuid(),
  currency: z.enum(['USD', 'EUR', 'GBP']),
});

const bookingSchema = z.object({
  senderName: z.string().max(200).optional(),
  senderEmail: z.string().email().max(200).optional(),
  senderPhone: z.string().max(50).optional(),
  recipientName: z.string().min(1).max(200),
  recipientEmail: z.string().email().max(200).optional(),
  recipientPhone: z.string().max(50).optional(),
  pickupLocationId: z.string().uuid(),
  destinationZoneId: z.string().uuid(),
  deliveryOptionId: z.string().uuid(),
  packages: z.array(packageSchema).min(1),
  currency: z.enum(['USD', 'EUR', 'GBP']).optional().default('GBP'),
  category: z.string().max(200).optional(),
  specialInstructions: z.string().max(2000).optional(),
  scheduledFor: z.string().datetime().optional(),
  customPriceCents: z.number().int().min(0).optional(),
  idempotencyKey: z.string().max(200).optional(),
});

const createPricingRuleSchema = z.object({
  originZoneId: z.string().uuid(),
  destinationZoneId: z.string().uuid(),
  sizeClass: z.enum(['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE']),
  weightClass: z.enum(['LIGHT', 'MEDIUM', 'HEAVY', 'EXTRA_HEAVY']),
  deliveryOptionId: z.string().uuid(),
  currency: z.enum(['USD', 'EUR', 'GBP']),
  amountCents: z.number().int().min(0),
  validFrom: z.string().datetime(),
  validTo: z.string().datetime().nullable().optional(),
});

const updatePricingRuleSchema = z.object({
  amountCents: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().nullable().optional(),
});

const createDeliveryOptionSchema = z.object({
  code: z.enum([
    'STANDARD',
    'EXPRESS',
    'SAME_DAY',
    'SCHEDULED',
    'PICKUP_AT_LOCATION',
    'DROP_OFF_AT_LOCATION',
  ]),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});

const updateDeliveryOptionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  isActive: z.boolean().optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw badRequest('VALIDATION', 'Invalid request payload');
  return result.data;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function pricingRouter(db: Db): Router {
  const router = Router();

  // ── Quote ─────────────────────────────────────────────────────────────────

  router.post(
    '/quote',
    requireAuth(db),
    requirePermission(PERMISSIONS.QUOTE_CREATE),
    async (req, res) => {
      const input = parse(quoteSchema, req.body);
      const quote = await service.computeQuote(db, input);
      res.json({ quote });
    },
  );

  // ── Booking ───────────────────────────────────────────────────────────────

  router.post(
    '/book',
    requireAuth(db),
    requirePermission(PERMISSIONS.BOOKING_CREATE),
    async (req, res) => {
      const ctx = res.locals.auth as AuthContext;
      const input = parse(bookingSchema, req.body);
      const shipment = await service.createBooking(db, ctx, {
        ...input,
        senderUserId: ctx.userId,
        scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : undefined,
      });
      res.status(201).json({ shipment });
    },
  );

  // ── Cancel booking ────────────────────────────────────────────────────────

  router.patch(
    '/bookings/:id/cancel',
    requireAuth(db),
    requirePermission(PERMISSIONS.BOOKING_CREATE),
    async (req, res) => {
      const ctx = res.locals.auth as AuthContext;
      const { id } = req.params;
      if (typeof id !== 'string') throw badRequest('VALIDATION', 'Invalid shipment id');
      const shipment = await service.cancelBooking(db, ctx, id);
      res.json({ shipment });
    },
  );

  // ── Admin: Pricing rules ──────────────────────────────────────────────────

  const requireAdmin = [requireAuth(db), requirePermission(PERMISSIONS.PRICING_MANAGE)];

  router.get('/rules', ...requireAdmin, async (req, res) => {
    const filters = {
      originZoneId: req.query.originZoneId as string | undefined,
      destinationZoneId: req.query.destinationZoneId as string | undefined,
      deliveryOptionId: req.query.deliveryOptionId as string | undefined,
      currency: req.query.currency as string | undefined,
      isActive: req.query.isActive !== undefined ? req.query.isActive === 'true' : undefined,
      sizeClass: req.query.sizeClass as string | undefined,
      weightClass: req.query.weightClass as string | undefined,
    };
    const rules = await service.listPricingRules(db, filters);
    res.json({ rules });
  });

  router.post('/rules', ...requireAdmin, async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const input = parse(createPricingRuleSchema, req.body);
    const rule = await service.createPricingRule(db, ctx, {
      ...input,
      validFrom: new Date(input.validFrom),
      validTo: input.validTo ? new Date(input.validTo) : null,
    });
    res.status(201).json({ rule });
  });

  router.put('/rules/:id', ...requireAdmin, async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const { id } = req.params;
    if (typeof id !== 'string') throw badRequest('VALIDATION', 'Invalid pricing rule id');
    const input = parse(updatePricingRuleSchema, req.body);
    const rule = await service.updatePricingRule(db, ctx, id, {
      ...input,
      validFrom: input.validFrom ? new Date(input.validFrom) : undefined,
      validTo: input.validTo !== undefined ? (input.validTo ? new Date(input.validTo) : null) : undefined,
    });
    res.json({ rule });
  });

  // ── Delivery options ──────────────────────────────────────────────────────

  router.get(
    '/delivery-options',
    requireAuth(db),
    requirePermission(PERMISSIONS.QUOTE_CREATE),
    async (_req, res) => {
      const options = await service.listDeliveryOptions(db);
      res.json({ deliveryOptions: options });
    },
  );

  router.post('/delivery-options', ...requireAdmin, async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const input = parse(createDeliveryOptionSchema, req.body);
    const option = await service.createDeliveryOption(db, ctx, input);
    res.status(201).json({ deliveryOption: option });
  });

  router.put('/delivery-options/:id', ...requireAdmin, async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const { id } = req.params;
    if (typeof id !== 'string') throw badRequest('VALIDATION', 'Invalid delivery option id');
    const input = parse(updateDeliveryOptionSchema, req.body);
    const option = await service.updateDeliveryOption(db, ctx, id, input);
    res.json({ deliveryOption: option });
  });

  return router;
}
