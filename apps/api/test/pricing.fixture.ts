import request from 'supertest';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/modules/auth/seed.js';
import type { Db } from '../src/shared/db.js';

import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

export type PricingRole = 'ADMIN' | 'MERCHANT' | 'CUSTOMER' | 'DISPATCHER';

const ROLE_EMAILS: Record<PricingRole, string> = {
  ADMIN: 'admin-pricing@example.com',
  MERCHANT: 'merchant-pricing@example.com',
  CUSTOMER: 'customer-pricing@example.com',
  DISPATCHER: 'dispatcher-pricing@example.com',
};

export interface PricingIds {
  hubId: string;
  originZoneId: string;
  destZoneId: string;
  pickupLocationId: string;
  deliveryOptionId: string;
}

export interface PricingFixture {
  db: Db;
  app: ReturnType<typeof createApp>;
  ids: PricingIds;
  token(role: PricingRole): string;
  createRule(overrides?: Record<string, unknown>): Promise<{ id: string; amountCents: number }>;
  cleanup(): Promise<void>;
}

export async function setupPricingTest(roles: PricingRole[]): Promise<PricingFixture> {
  const testDb = await createTestDb({ postgis: true });
  const db = testDb.db;
  await seedAuthData(db);
  const app = createApp({ db, mailer: new FakeMailer() } satisfies AppDeps);

  const tokens = new Map<PricingRole, string>();
  for (const role of roles) {
    const email = ROLE_EMAILS[role];
    await seedUserWithRoles(db, [role], email);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD });
    if (!login.body.accessToken) {
      throw new Error(`setupPricingTest: login failed for ${role} (${email})`);
    }
    tokens.set(role, login.body.accessToken as string);
  }

  const adminToken = tokens.get('ADMIN');
  if (!adminToken) throw new Error('setupPricingTest: ADMIN role is required');

  const hubRes = await request(app)
    .post('/api/v1/locations/hubs')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Test Hub', code: 'TST-01', address: '1 Test Street, London' });
  const hubId = hubRes.body.hub.id as string;

  const originZoneRes = await request(app)
    .post('/api/v1/locations/zones')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ hubId, name: 'Origin Zone' });
  const originZoneId = originZoneRes.body.zone.id as string;

  const destZoneRes = await request(app)
    .post('/api/v1/locations/zones')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ hubId, name: 'Dest Zone' });
  const destZoneId = destZoneRes.body.zone.id as string;

  const pickupRes = await request(app)
    .post('/api/v1/locations/pickup-points')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ hubId, zoneId: originZoneId, name: 'Test Pickup', address: '2 Pickup Road, London' });
  const pickupLocationId = pickupRes.body.pickupLocation.id as string;

  const deliveryOptRes = await request(app)
    .post('/api/v1/pricing/delivery-options')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ code: 'STANDARD', name: 'Standard Delivery' });
  const deliveryOptionId = deliveryOptRes.body.deliveryOption.id as string;

  return {
    db,
    app,
    ids: { hubId, originZoneId, destZoneId, pickupLocationId, deliveryOptionId },
    token(role) {
      const t = tokens.get(role);
      if (!t) throw new Error(`setupPricingTest: ${role} was not seeded`);
      return t;
    },
    async createRule(overrides: Record<string, unknown> = {}) {
      const res = await request(app)
        .post('/api/v1/pricing/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          originZoneId,
          destinationZoneId: destZoneId,
          sizeClass: 'SMALL',
          weightClass: 'LIGHT',
          deliveryOptionId,
          currency: 'GBP',
          amountCents: 1500,
          validFrom: new Date().toISOString(),
          ...overrides,
        });
      if (res.status !== 201) {
        throw new Error(`setupPricingTest.createRule failed: ${JSON.stringify(res.body)}`);
      }
      return res.body.rule as { id: string; amountCents: number };
    },
    cleanup() {
      return testDb.cleanup();
    },
  };
}
