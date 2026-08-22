import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupPricingTest } from './pricing.fixture.js';
import type { PricingFixture } from './pricing.fixture.js';

describe('pricing quote', () => {
  let f: PricingFixture;

  beforeAll(async () => {
    f = await setupPricingTest(['ADMIN', 'CUSTOMER', 'DISPATCHER']);
    // SMALL/LIGHT -> 1800, MEDIUM/LIGHT -> 2500 (GBP, STANDARD)
    await f.createRule({ amountCents: 1800 });
    await f.createRule({ sizeClass: 'MEDIUM', amountCents: 2500 });
  });

  afterAll(async () => {
    await f.cleanup();
  });

  const customer = () => `Bearer ${f.token('CUSTOMER')}`;
  const dispatcher = () => `Bearer ${f.token('DISPATCHER')}`;

  const quotePayload = (overrides: Record<string, unknown> = {}) => ({
    originZoneId: f.ids.originZoneId,
    destinationZoneId: f.ids.destZoneId,
    packages: [{ sizeClass: 'SMALL', weightClass: 'LIGHT', quantity: 1 }],
    deliveryOptionId: f.ids.deliveryOptionId,
    currency: 'GBP',
    ...overrides,
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(f.app).post('/pricing/quote').send(quotePayload());
    expect(res.status).toBe(401);
  });

  it('rejects without QUOTE_CREATE permission', async () => {
    const res = await request(f.app)
      .post('/pricing/quote')
      .set('Authorization', dispatcher())
      .send(quotePayload());
    expect(res.status).toBe(403);
  });

  it('computes quote for single package', async () => {
    const res = await request(f.app)
      .post('/pricing/quote')
      .set('Authorization', customer())
      .send(quotePayload());
    expect(res.status).toBe(200);
    expect(res.body.quote).toMatchObject({
      amountCents: 1800,
      currency: 'GBP',
    });
    expect(res.body.quote.breakdown).toHaveLength(1);
  });

  it('computes quote with multiple packages', async () => {
    const res = await request(f.app)
      .post('/pricing/quote')
      .set('Authorization', customer())
      .send(
        quotePayload({
          packages: [
            { sizeClass: 'SMALL', weightClass: 'LIGHT', quantity: 2 },
            { sizeClass: 'MEDIUM', weightClass: 'LIGHT', quantity: 1 },
          ],
        }),
      );
    expect(res.status).toBe(200);
    // SMALL: 1800 * 2 = 3600, MEDIUM: 2500 * 1 = 2500, total = 6100
    expect(res.body.quote.amountCents).toBe(6100);
    expect(res.body.quote.breakdown).toHaveLength(2);
  });

  it('rejects when no pricing rule matches', async () => {
    const res = await request(f.app)
      .post('/pricing/quote')
      .set('Authorization', customer())
      .send(
        quotePayload({
          packages: [{ sizeClass: 'EXTRA_LARGE', weightClass: 'EXTRA_HEAVY', quantity: 1 }],
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_PRICING_RULE');
  });

  it('rejects invalid zone IDs', async () => {
    const res = await request(f.app)
      .post('/pricing/quote')
      .set('Authorization', customer())
      .send(
        quotePayload({
          originZoneId: '00000000-0000-0000-0000-000000000000',
        }),
      );
    expect(res.status).toBe(400);
  });

  it('rejects empty packages', async () => {
    const res = await request(f.app)
      .post('/pricing/quote')
      .set('Authorization', customer())
      .send(quotePayload({ packages: [] }));
    expect(res.status).toBe(400);
  });

  it('rejects invalid currency', async () => {
    const res = await request(f.app)
      .post('/pricing/quote')
      .set('Authorization', customer())
      .send(quotePayload({ currency: 'XYZ' }));
    expect(res.status).toBe(400);
  });
});
