import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupPricingTest } from './pricing.fixture.js';
import type { PricingFixture } from './pricing.fixture.js';

describe('pricing booking + cancel + immutability', () => {
  let f: PricingFixture;
  let pricingRuleId: string;

  beforeAll(async () => {
    f = await setupPricingTest(['ADMIN', 'MERCHANT', 'CUSTOMER']);
    // SMALL/LIGHT -> 1800 (GBP, STANDARD)
    const rule = await f.createRule({ amountCents: 1800 });
    pricingRuleId = rule.id;
  });

  afterAll(async () => {
    await f.cleanup();
  });

  const admin = () => `Bearer ${f.token('ADMIN')}`;
  const merchant = () => `Bearer ${f.token('MERCHANT')}`;
  const customer = () => `Bearer ${f.token('CUSTOMER')}`;

  const bookingPayload = (overrides: Record<string, unknown> = {}) => ({
    recipientName: 'Test Recipient',
    pickupLocationId: f.ids.pickupLocationId,
    destinationZoneId: f.ids.destZoneId,
    deliveryOptionId: f.ids.deliveryOptionId,
    packages: [{ sizeClass: 'SMALL', weightClass: 'LIGHT', quantity: 1 }],
    ...overrides,
  });

  // ── Booking ──────────────────────────────────────────────────────────────

  describe('booking', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await request(f.app).post('/pricing/book').send(bookingPayload());
      expect(res.status).toBe(401);
    });

    it('creates a booking', async () => {
      const res = await request(f.app)
        .post('/pricing/book')
        .set('Authorization', customer())
        .send(
          bookingPayload({
            recipientEmail: 'recipient@test.com',
          }),
        );
      expect(res.status).toBe(201);
      expect(res.body.shipment).toMatchObject({
        status: 'BOOKED',
        recipientName: 'Test Recipient',
        quoteAmountCents: 1800,
        quoteCurrency: 'GBP',
      });
      expect(res.body.shipment.quoteSnapshot).toBeDefined();
      expect(res.body.shipment.id).toBeDefined();
    });

    it('booking has correct quote snapshot', async () => {
      const res = await request(f.app)
        .post('/pricing/book')
        .set('Authorization', customer())
        .send(
          bookingPayload({
            recipientName: 'Snapshot Test',
            packages: [{ sizeClass: 'SMALL', weightClass: 'LIGHT', quantity: 2 }],
          }),
        );
      expect(res.status).toBe(201);
      const snapshot = res.body.shipment.quoteSnapshot;
      expect(snapshot.totalAmountCents).toBe(3600);
      expect(snapshot.currency).toBe('GBP');
      expect(snapshot.packages).toHaveLength(1);
      expect(snapshot.packages[0].quantity).toBe(2);
      expect(snapshot.computedAt).toBeDefined();
    });

    it('booking with custom price from merchant', async () => {
      const res = await request(f.app)
        .post('/pricing/book')
        .set('Authorization', merchant())
        .send(bookingPayload({ customPriceCents: 1000 }));
      expect(res.status).toBe(201);
      expect(res.body.shipment.quoteAmountCents).toBe(1000);
      expect(res.body.shipment.quoteSnapshot.pricingSource).toBe('custom');
    });

    it('rejects custom price from customer', async () => {
      const res = await request(f.app)
        .post('/pricing/book')
        .set('Authorization', customer())
        .send(bookingPayload({ customPriceCents: 100 }));
      expect(res.status).toBe(400);
    });

    it('rejects booking with invalid pickup location', async () => {
      const res = await request(f.app)
        .post('/pricing/book')
        .set('Authorization', customer())
        .send(
          bookingPayload({
            pickupLocationId: '00000000-0000-0000-0000-000000000000',
          }),
        );
      expect(res.status).toBe(400);
    });

    it('idempotency: same key returns same response', async () => {
      const idempotencyKey = `test-key-${Date.now()}`;
      const payload = bookingPayload({ idempotencyKey });

      const res1 = await request(f.app)
        .post('/pricing/book')
        .set('Authorization', customer())
        .send(payload);
      expect(res1.status).toBe(201);
      const shipmentId1 = res1.body.shipment.id;

      const res2 = await request(f.app)
        .post('/pricing/book')
        .set('Authorization', customer())
        .send(payload);
      expect(res2.status).toBe(201);
      expect(res2.body.shipment.id).toBe(shipmentId1);
    });

    it('idempotency: same key with different payload returns 409', async () => {
      const idempotencyKey = `test-conflict-${Date.now()}`;

      await request(f.app)
        .post('/pricing/book')
        .set('Authorization', customer())
        .send(bookingPayload({ idempotencyKey }));

      const res = await request(f.app)
        .post('/pricing/book')
        .set('Authorization', customer())
        .send(
          bookingPayload({
            recipientName: 'Second',
            packages: [{ sizeClass: 'SMALL', weightClass: 'LIGHT', quantity: 2 }],
            idempotencyKey,
          }),
        );
      expect(res.status).toBe(409);
    });
  });

  // ── Cancel ───────────────────────────────────────────────────────────────

  describe('cancel', () => {
    let cancelShipmentId: string;

    beforeAll(async () => {
      const res = await request(f.app)
        .post('/pricing/book')
        .set('Authorization', customer())
        .send(bookingPayload({ recipientName: 'Cancel Test' }));
      cancelShipmentId = res.body.shipment.id;
    });

    it('cancels a BOOKED shipment', async () => {
      const res = await request(f.app)
        .patch(`/pricing/bookings/${cancelShipmentId}/cancel`)
        .set('Authorization', customer());
      expect(res.status).toBe(200);
      expect(res.body.shipment.status).toBe('CANCELLED');
    });

    it('rejects cancel of already cancelled shipment', async () => {
      const res = await request(f.app)
        .patch(`/pricing/bookings/${cancelShipmentId}/cancel`)
        .set('Authorization', customer());
      expect(res.status).toBe(400);
    });

    it('rejects cancel of non-existent shipment', async () => {
      const res = await request(f.app)
        .patch('/pricing/bookings/00000000-0000-0000-0000-000000000000/cancel')
        .set('Authorization', customer());
      expect(res.status).toBe(404);
    });
  });

  // ── Immutability ─────────────────────────────────────────────────────────

  describe('quote snapshot immutability', () => {
    it('booking snapshot unchanged after rule update', async () => {
      // Create a booking
      const bookRes = await request(f.app)
        .post('/pricing/book')
        .set('Authorization', customer())
        .send(bookingPayload({ recipientName: 'Immutability Test' }));
      const originalSnapshot = bookRes.body.shipment.quoteSnapshot;

      // Update the pricing rule
      await request(f.app)
        .put(`/pricing/rules/${pricingRuleId}`)
        .set('Authorization', admin())
        .send({ amountCents: 9999 });

      // A NEW booking gets the new price; the old snapshot is untouched
      const newBookRes = await request(f.app)
        .post('/pricing/book')
        .set('Authorization', customer())
        .send(bookingPayload({ recipientName: 'After Update' }));
      expect(newBookRes.body.shipment.quoteAmountCents).toBe(9999);
      expect(newBookRes.body.shipment.quoteSnapshot.totalAmountCents).toBe(9999);
      expect(originalSnapshot.totalAmountCents).toBe(1800);
    });
  });
});
