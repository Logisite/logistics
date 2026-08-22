import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupPricingTest } from './pricing.fixture.js';
import type { PricingFixture } from './pricing.fixture.js';

describe('pricing admin: delivery options + rules', () => {
  let f: PricingFixture;
  let pricingRuleId: string;

  beforeAll(async () => {
    f = await setupPricingTest(['ADMIN', 'MERCHANT', 'CUSTOMER']);
  });

  afterAll(async () => {
    await f.cleanup();
  });

  const admin = () => `Bearer ${f.token('ADMIN')}`;
  const merchant = () => `Bearer ${f.token('MERCHANT')}`;
  const customer = () => `Bearer ${f.token('CUSTOMER')}`;

  // ── Delivery options ─────────────────────────────────────────────────────

  describe('delivery options', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await request(f.app).get('/pricing/delivery-options');
      expect(res.status).toBe(401);
    });

    it('lists delivery options (any authenticated user)', async () => {
      const res = await request(f.app)
        .get('/pricing/delivery-options')
        .set('Authorization', customer());
      expect(res.status).toBe(200);
      expect(res.body.deliveryOptions).toHaveLength(1);
    });

    it('creates a delivery option (admin only)', async () => {
      const res = await request(f.app)
        .post('/pricing/delivery-options')
        .set('Authorization', admin())
        .send({ code: 'EXPRESS', name: 'Express Delivery' });
      expect(res.status).toBe(201);
      expect(res.body.deliveryOption).toMatchObject({
        code: 'EXPRESS',
        name: 'Express Delivery',
      });
    });

    it('rejects non-admin on create', async () => {
      const res = await request(f.app)
        .post('/pricing/delivery-options')
        .set('Authorization', merchant())
        .send({ code: 'SAME_DAY', name: 'Same Day' });
      expect(res.status).toBe(403);
    });

    it('rejects duplicate code', async () => {
      const res = await request(f.app)
        .post('/pricing/delivery-options')
        .set('Authorization', admin())
        .send({ code: 'EXPRESS', name: 'Another Express' });
      expect(res.status).toBe(409);
    });

    it('updates a delivery option', async () => {
      const listRes = await request(f.app)
        .get('/pricing/delivery-options')
        .set('Authorization', admin());
      const optionId = listRes.body.deliveryOptions[1].id;

      const res = await request(f.app)
        .put(`/pricing/delivery-options/${optionId}`)
        .set('Authorization', admin())
        .send({ name: 'Express 2-Day' });
      expect(res.status).toBe(200);
      expect(res.body.deliveryOption.name).toBe('Express 2-Day');
    });
  });

  // ── Pricing rules ────────────────────────────────────────────────────────

  describe('pricing rules', () => {
    it('rejects non-admin on list', async () => {
      const res = await request(f.app)
        .get('/pricing/rules')
        .set('Authorization', merchant());
      expect(res.status).toBe(403);
    });

    it('returns empty list initially', async () => {
      const res = await request(f.app)
        .get('/pricing/rules')
        .set('Authorization', admin());
      expect(res.status).toBe(200);
      expect(res.body.rules).toEqual([]);
    });

    it('creates a pricing rule', async () => {
      const res = await request(f.app)
        .post('/pricing/rules')
        .set('Authorization', admin())
        .send({
          originZoneId: f.ids.originZoneId,
          destinationZoneId: f.ids.destZoneId,
          sizeClass: 'SMALL',
          weightClass: 'LIGHT',
          deliveryOptionId: f.ids.deliveryOptionId,
          currency: 'GBP',
          amountCents: 1500,
          validFrom: new Date().toISOString(),
        });
      expect(res.status).toBe(201);
      expect(res.body.rule).toMatchObject({
        sizeClass: 'SMALL',
        weightClass: 'LIGHT',
        currency: 'GBP',
        amountCents: 1500,
      });
      pricingRuleId = res.body.rule.id;
    });

    it('rejects duplicate active rule for same tuple', async () => {
      const res = await request(f.app)
        .post('/pricing/rules')
        .set('Authorization', admin())
        .send({
          originZoneId: f.ids.originZoneId,
          destinationZoneId: f.ids.destZoneId,
          sizeClass: 'SMALL',
          weightClass: 'LIGHT',
          deliveryOptionId: f.ids.deliveryOptionId,
          currency: 'GBP',
          amountCents: 2000,
          validFrom: new Date().toISOString(),
        });
      expect(res.status).toBe(409);
    });

    it('allows same config with different size class', async () => {
      const res = await request(f.app)
        .post('/pricing/rules')
        .set('Authorization', admin())
        .send({
          originZoneId: f.ids.originZoneId,
          destinationZoneId: f.ids.destZoneId,
          sizeClass: 'MEDIUM',
          weightClass: 'LIGHT',
          deliveryOptionId: f.ids.deliveryOptionId,
          currency: 'GBP',
          amountCents: 2500,
          validFrom: new Date().toISOString(),
        });
      expect(res.status).toBe(201);
    });

    it('lists pricing rules', async () => {
      const res = await request(f.app)
        .get('/pricing/rules')
        .set('Authorization', admin());
      expect(res.status).toBe(200);
      expect(res.body.rules).toHaveLength(2);
    });

    it('lists pricing rules with filters', async () => {
      const res = await request(f.app)
        .get(`/pricing/rules?sizeClass=SMALL`)
        .set('Authorization', admin());
      expect(res.status).toBe(200);
      expect(res.body.rules).toHaveLength(1);
    });

    it('updates a pricing rule', async () => {
      const res = await request(f.app)
        .put(`/pricing/rules/${pricingRuleId}`)
        .set('Authorization', admin())
        .send({ amountCents: 1800 });
      expect(res.status).toBe(200);
      expect(res.body.rule.amountCents).toBe(1800);
    });

    it('rejects non-admin on create', async () => {
      const res = await request(f.app)
        .post('/pricing/rules')
        .set('Authorization', merchant())
        .send({
          originZoneId: f.ids.originZoneId,
          destinationZoneId: f.ids.destZoneId,
          sizeClass: 'LARGE',
          weightClass: 'HEAVY',
          deliveryOptionId: f.ids.deliveryOptionId,
          currency: 'GBP',
          amountCents: 5000,
          validFrom: new Date().toISOString(),
        });
      expect(res.status).toBe(403);
    });

    it('rejects invalid zone ID', async () => {
      const res = await request(f.app)
        .post('/pricing/rules')
        .set('Authorization', admin())
        .send({
          originZoneId: '00000000-0000-0000-0000-000000000000',
          destinationZoneId: f.ids.destZoneId,
          sizeClass: 'SMALL',
          weightClass: 'LIGHT',
          deliveryOptionId: f.ids.deliveryOptionId,
          currency: 'GBP',
          amountCents: 1500,
          validFrom: new Date().toISOString(),
        });
      expect(res.status).toBe(400);
    });
  });
});
