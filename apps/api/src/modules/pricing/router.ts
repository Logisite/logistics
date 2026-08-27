import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../../shared/db.js';
import { badRequest } from '../../shared/errors.js';
import type { AuthContext } from '../auth/middleware.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PERMISSIONS } from '../auth/permissions.js';

import * as service from './service.js';
import { defineRoute } from '../../openapi/registry.js';
import { parse } from '../../shared/validate.js';

const PackageSchema = z.object({
  sizeClass: z.enum(['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE']),
  weightClass: z.enum(['LIGHT', 'MEDIUM', 'HEAVY', 'EXTRA_HEAVY']),
  quantity: z.number().int().min(1),
}).openapi('PricingPackageSchema');

const PricingQuoteRequest = z.object({
  originZoneId: z.string().uuid(),
  destinationZoneId: z.string().uuid(),
  packages: z.array(PackageSchema).min(1),
  deliveryOptionId: z.string().uuid(),
  currency: z.enum(['USD', 'EUR', 'GBP']),
}).openapi('PricingQuoteRequest');

const PricingBookRequest = z.object({
  senderName: z.string().max(200).optional(),
  senderEmail: z.string().email().max(200).optional(),
  senderPhone: z.string().max(50).optional(),
  recipientName: z.string().min(1).max(200),
  recipientEmail: z.string().email().max(200).optional(),
  recipientPhone: z.string().max(50).optional(),
  pickupLocationId: z.string().uuid(),
  destinationZoneId: z.string().uuid(),
  deliveryOptionId: z.string().uuid(),
  packages: z.array(PackageSchema).min(1),
  currency: z.enum(['USD', 'EUR', 'GBP']).optional().default('GBP'),
  category: z.string().max(200).optional(),
  specialInstructions: z.string().max(2000).optional(),
  scheduledFor: z.string().datetime().optional(),
  customPriceCents: z.number().int().min(0).optional(),
  idempotencyKey: z.string().max(200).optional(),
}).openapi('PricingBookRequest');

const PricingRuleRequest = z.object({
  originZoneId: z.string().uuid(),
  destinationZoneId: z.string().uuid(),
  sizeClass: z.enum(['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE']),
  weightClass: z.enum(['LIGHT', 'MEDIUM', 'HEAVY', 'EXTRA_HEAVY']),
  deliveryOptionId: z.string().uuid(),
  currency: z.enum(['USD', 'EUR', 'GBP']),
  amountCents: z.number().int().min(0),
  validFrom: z.string().datetime(),
  validTo: z.string().datetime().nullable().optional(),
}).openapi('PricingRuleRequest');

const PricingRuleUpdateRequest = z.object({
  amountCents: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().nullable().optional(),
}).openapi('PricingRuleUpdateRequest');

const DeliveryOptionRequest = z.object({
  code: z.enum(['STANDARD', 'EXPRESS', 'SAME_DAY', 'SCHEDULED', 'PICKUP_AT_LOCATION', 'DROP_OFF_AT_LOCATION']),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
}).openapi('DeliveryOptionRequest');

const DeliveryOptionUpdateRequest = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  isActive: z.boolean().optional(),
}).openapi('DeliveryOptionUpdateRequest');

const PricingRuleResponse = z.object({ rule: z.object({ id: z.string().uuid(), originZoneId: z.string().uuid(), destinationZoneId: z.string().uuid(), sizeClass: z.enum(['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE']), weightClass: z.enum(['LIGHT', 'MEDIUM', 'HEAVY', 'EXTRA_HEAVY']), deliveryOptionId: z.string().uuid(), currency: z.enum(['USD', 'EUR', 'GBP']), amountCents: z.number().int(), validFrom: z.string().datetime(), validTo: z.string().datetime().nullable(), isActive: z.boolean(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }) }).openapi('PricingRuleResponse');

const PricingRuleListResponse = z.object({ rules: z.array(z.object({ id: z.string().uuid(), originZoneId: z.string().uuid(), destinationZoneId: z.string().uuid(), sizeClass: z.enum(['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE']), weightClass: z.enum(['LIGHT', 'MEDIUM', 'HEAVY', 'EXTRA_HEAVY']), deliveryOptionId: z.string().uuid(), currency: z.enum(['USD', 'EUR', 'GBP']), amountCents: z.number().int(), validFrom: z.string().datetime(), validTo: z.string().datetime().nullable(), isActive: z.boolean(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() })) }).openapi('PricingRuleListResponse');

const DeliveryOptionResponse = z.object({ deliveryOption: z.object({ id: z.string().uuid(), code: z.enum(['STANDARD', 'EXPRESS', 'SAME_DAY', 'SCHEDULED', 'PICKUP_AT_LOCATION', 'DROP_OFF_AT_LOCATION']), name: z.string(), description: z.string().optional(), isActive: z.boolean(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }) }).openapi('DeliveryOptionResponse');

const DeliveryOptionListResponse = z.object({ deliveryOptions: z.array(z.object({ id: z.string().uuid(), code: z.enum(['STANDARD', 'EXPRESS', 'SAME_DAY', 'SCHEDULED', 'PICKUP_AT_LOCATION', 'DROP_OFF_AT_LOCATION']), name: z.string(), description: z.string().optional(), isActive: z.boolean(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() })) }).openapi('DeliveryOptionListResponse');

const PricingQuoteResponse = z.object({ quote: z.object({ originZoneId: z.string().uuid(), destinationZoneId: z.string().uuid(), packages: z.array(z.object({ sizeClass: z.enum(['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE']), weightClass: z.enum(['LIGHT', 'MEDIUM', 'HEAVY', 'EXTRA_HEAVY']), quantity: z.number().int().min(1) })), amountCents: z.number().int(), currency: z.enum(['USD', 'EUR', 'GBP']), deliveryOptionId: z.string().uuid(), validUntil: z.string().datetime() }) }).openapi('PricingQuoteResponse');

const PricingBookResponse = z.object({ shipment: z.object({ id: z.string().uuid(), status: z.string(), senderName: z.string().optional(), recipientName: z.string(), pickupLocationId: z.string().uuid(), destinationZoneId: z.string().uuid(), deliveryOptionId: z.string().uuid(), quoteAmountCents: z.number().int(), currency: z.string(), createdAt: z.string().datetime() }) }).openapi('PricingBookResponse');

const IdParam = z.object({ id: z.string().uuid() });

defineRoute({ method: 'post', path: '/pricing/quote', request: { body: { content: { 'application/json': { schema: PricingQuoteRequest } } } }, responses: { 200: { description: 'Quote computed', content: { 'application/json': { schema: PricingQuoteResponse } } } } });
defineRoute({ method: 'post', path: '/pricing/book', request: { body: { content: { 'application/json': { schema: PricingBookRequest } } } }, responses: { 201: { description: 'Booking created', content: { 'application/json': { schema: PricingBookResponse } } } } });
defineRoute({ method: 'get', path: '/pricing/rules', responses: { 200: { description: 'Pricing rules', content: { 'application/json': { schema: PricingRuleListResponse } } } } });
defineRoute({ method: 'post', path: '/pricing/rules', request: { body: { content: { 'application/json': { schema: PricingRuleRequest } } } }, responses: { 201: { description: 'Rule created', content: { 'application/json': { schema: PricingRuleResponse } } } } });
defineRoute({ method: 'put', path: '/pricing/rules/{id}', request: { params: IdParam, body: { content: { 'application/json': { schema: PricingRuleUpdateRequest } } } }, responses: { 200: { description: 'Rule updated', content: { 'application/json': { schema: PricingRuleResponse } } } } });
defineRoute({ method: 'get', path: '/pricing/delivery-options', responses: { 200: { description: 'Delivery options', content: { 'application/json': { schema: DeliveryOptionListResponse } } } } });
defineRoute({ method: 'post', path: '/pricing/delivery-options', request: { body: { content: { 'application/json': { schema: DeliveryOptionRequest } } } }, responses: { 201: { description: 'Option created', content: { 'application/json': { schema: DeliveryOptionResponse } } } } });
defineRoute({ method: 'put', path: '/pricing/delivery-options/{id}', request: { params: IdParam, body: { content: { 'application/json': { schema: DeliveryOptionUpdateRequest } } } }, responses: { 200: { description: 'Option updated', content: { 'application/json': { schema: DeliveryOptionResponse } } } } });

export function pricingRouter(db: Db): Router {
  const router = Router();

  router.post(
    '/quote',
    requireAuth(db),
    requirePermission(PERMISSIONS.QUOTE_CREATE),
    async (req, res) => {
      const input = parse(PricingQuoteRequest, req.body);
      const quote = await service.computeQuote(db, input);
      res.json({ quote });
    },
  );

  router.post(
    '/book',
    requireAuth(db),
    requirePermission(PERMISSIONS.BOOKING_CREATE),
    async (req, res) => {
      const ctx = res.locals.auth as AuthContext;
      const input = parse(PricingBookRequest, req.body);
      const shipment = await service.createBooking(db, ctx, {
        ...input,
        senderUserId: ctx.userId,
        scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : undefined,
      });
      res.status(201).json({ shipment });
    },
  );

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
    const input = parse(PricingRuleRequest, req.body);
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
    const input = parse(PricingRuleUpdateRequest, req.body);
    const rule = await service.updatePricingRule(db, ctx, id, {
      ...input,
      validFrom: input.validFrom ? new Date(input.validFrom) : undefined,
      validTo: input.validTo !== undefined ? (input.validTo ? new Date(input.validTo) : null) : undefined,
    });
    res.json({ rule });
  });

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
    const input = parse(DeliveryOptionRequest, req.body);
    const option = await service.createDeliveryOption(db, ctx, input);
    res.status(201).json({ deliveryOption: option });
  });

  router.put('/delivery-options/:id', ...requireAdmin, async (req, res) => {
    const ctx = res.locals.auth as AuthContext;
    const { id } = req.params;
    if (typeof id !== 'string') throw badRequest('VALIDATION', 'Invalid delivery option id');
    const input = parse(DeliveryOptionUpdateRequest, req.body);
    const option = await service.updateDeliveryOption(db, ctx, id, input);
    res.json({ deliveryOption: option });
  });

  return router;
}
