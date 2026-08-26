import request from 'supertest';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/auth/seed.js';
import type { Db } from '../src/db.js';

import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

export type CodRole = 'ADMIN' | 'BRANCH_OPERATOR' | 'DRIVER' | 'CUSTOMER' | 'MERCHANT';

const ROLE_EMAILS: Record<CodRole, string> = {
  ADMIN: 'admin-cod@example.com',
  BRANCH_OPERATOR: 'branch-cod@example.com',
  DRIVER: 'driver-cod@example.com',
  CUSTOMER: 'customer-cod@example.com',
  MERCHANT: 'merchant-cod@example.com',
};

export interface CodFixture {
  db: Db;
  app: ReturnType<typeof createApp>;
  ids: {
    originZoneId: string;
    destZoneId: string;
    pickupLocationId: string;
    deliveryOptionId: string;
    hubId: string;
  };
  driverUserId: Promise<string>;
  token(role: CodRole): string;
  /** Books + walks a shipment to DELIVERED, returns its id. */
  deliveredShipment(): Promise<string>;
  cleanup(): Promise<void>;
}

export async function setupCodTest(roles: CodRole[]): Promise<CodFixture> {
  const testDb = await createTestDb({ postgis: true });
  const db = testDb.db;
  await seedAuthData(db);
  const app = createApp({ db, mailer: new FakeMailer() } satisfies AppDeps);

  for (const role of roles) {
    await seedUserWithRoles(db, [role], ROLE_EMAILS[role]);
  }
  // The stand-in driver user collections reference.
  await seedUserWithRoles(db, ['DRIVER'], 'standin-driver-cod@example.com');

  const tokens = new Map<CodRole, string>();
  for (const role of roles) {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ROLE_EMAILS[role], password: TEST_PASSWORD });
    if (!login.body.accessToken) throw new Error(`setupCodTest: login failed for ${role}`);
    tokens.set(role, login.body.accessToken as string);
  }

  const adminToken = tokens.get('ADMIN');
  if (!adminToken) throw new Error('setupCodTest: ADMIN role is required');
  const admin = () => `Bearer ${adminToken}`;

  const hubRes = await request(app)
    .post('/api/v1/locations/hubs')
    .set('Authorization', admin())
    .send({ name: 'COD Hub', code: 'COD-01', address: '3 Cash Street, London' });
  const hubId = hubRes.body.hub.id as string;

  const zoneRes = await request(app)
    .post('/api/v1/locations/zones')
    .set('Authorization', admin())
    .send({ hubId, name: 'COD Origin' });
  const originZoneId = zoneRes.body.zone.id as string;

  const destRes = await request(app)
    .post('/api/v1/locations/zones')
    .set('Authorization', admin())
    .send({ hubId, name: 'COD Dest' });
  const destZoneId = destRes.body.zone.id as string;

  const pickupRes = await request(app)
    .post('/api/v1/locations/pickup-points')
    .set('Authorization', admin())
    .send({ hubId, zoneId: originZoneId, name: 'COD Pickup', address: '4 Pickup Way, London' });
  const pickupLocationId = pickupRes.body.pickupLocation.id as string;

  const optRes = await request(app)
    .post('/api/v1/pricing/delivery-options')
    .set('Authorization', admin())
    .send({ code: 'STANDARD', name: 'Standard Delivery' });
  const deliveryOptionId = optRes.body.deliveryOption.id as string;

  await request(app)
    .post('/api/v1/pricing/rules')
    .set('Authorization', admin())
    .send({
      originZoneId,
      destinationZoneId: destZoneId,
      sizeClass: 'SMALL',
      weightClass: 'LIGHT',
      deliveryOptionId,
      currency: 'GBP',
      amountCents: 1800,
      validFrom: new Date().toISOString(),
    });

  async function bookAs(role: CodRole): Promise<string> {
    const res = await request(app)
      .post('/api/v1/pricing/book')
      .set('Authorization', `Bearer ${tokens.get(role)}`)
      .send({
        recipientName: 'COD Recipient',
        pickupLocationId,
        destinationZoneId: destZoneId,
        deliveryOptionId,
        packages: [{ sizeClass: 'SMALL', weightClass: 'LIGHT', quantity: 1 }],
      });
    if (res.status !== 201) throw new Error(`setupCodTest.book failed: ${JSON.stringify(res.body)}`);
    return res.body.shipment.id as string;
  }

  async function walkToDelivered(id: string): Promise<void> {
    for (const path of ['pickup', 'transit', 'out-for-delivery', 'deliver']) {
      const res = await request(app)
        .post(`/api/v1/shipments/${id}/${path}`)
        .set('Authorization', admin());
      if (res.status !== 200) throw new Error(`walkToDelivered failed at ${path}`);
    }
  }

  return {
    db,
    app,
    ids: { originZoneId, destZoneId, pickupLocationId, deliveryOptionId, hubId },
    driverUserId: (async () => {
      const pg = await import('@logistics/db');
      const row = await db.query.users.findFirst({
        where: (t, { eq }) => eq(t.email, 'standin-driver-cod@example.com'),
      });
      void pg;
      return row!.id;
    })(),
    token(role) {
      const t = tokens.get(role);
      if (!t) throw new Error(`setupCodTest: ${role} was not seeded`);
      return t;
    },
    async deliveredShipment() {
      const id = await bookAs(roles.includes('CUSTOMER') ? 'CUSTOMER' : 'ADMIN');
      await walkToDelivered(id);
      return id;
    },
    cleanup() {
      return testDb.cleanup();
    },
  };
}
