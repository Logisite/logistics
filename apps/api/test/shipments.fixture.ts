import request from 'supertest';

import { shipments } from '@logistics/db';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { seedAuthData } from '../src/auth/seed.js';
import type { Db } from '../src/db.js';

import { createTestDb } from './db.js';
import { FakeMailer } from './fakes.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

export type ShipmentsRole = 'ADMIN' | 'DISPATCHER' | 'MERCHANT' | 'CUSTOMER1' | 'CUSTOMER2';

const ROLE_EMAILS: Record<ShipmentsRole, string> = {
  ADMIN: 'admin-shipments@example.com',
  DISPATCHER: 'dispatcher-shipments@example.com',
  MERCHANT: 'merchant-shipments@example.com',
  CUSTOMER1: 'customer1-shipments@example.com',
  CUSTOMER2: 'customer2-shipments@example.com',
};

export interface ShipmentsFixture {
  db: Db;
  app: ReturnType<typeof createApp>;
  ids: {
    originZoneId: string;
    destZoneId: string;
    pickupLocationId: string;
    deliveryOptionId: string;
    bookedShipmentId: string;
  };
  token(role: ShipmentsRole): string;
  /** Books another shipment as CUSTOMER1 and returns its id. */
  bookShipment(recipientName?: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function setupShipmentsTest(roles: ShipmentsRole[]): Promise<ShipmentsFixture> {
  const testDb = await createTestDb({ postgis: true });
  const db = testDb.db;
  await seedAuthData(db);
  const app = createApp({ db, mailer: new FakeMailer() } satisfies AppDeps);

  for (const role of roles) {
    await seedUserWithRoles(
      db,
      [role === 'CUSTOMER1' || role === 'CUSTOMER2' ? 'CUSTOMER' : role],
      ROLE_EMAILS[role],
    );
  }

  const tokens = new Map<ShipmentsRole, string>();
  for (const role of roles) {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: ROLE_EMAILS[role], password: TEST_PASSWORD });
    if (!login.body.accessToken) {
      throw new Error(`setupShipmentsTest: login failed for ${role}`);
    }
    tokens.set(role, login.body.accessToken as string);
  }

  const adminToken = tokens.get('ADMIN');
  if (!adminToken) throw new Error('setupShipmentsTest: ADMIN role is required');

  const hubRes = await request(app)
    .post('/locations/hubs')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Shipments Hub', code: 'SHP-01', address: '9 Hub Lane, London' });
  const hubId = hubRes.body.hub.id as string;

  const originZoneRes = await request(app)
    .post('/locations/zones')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ hubId, name: 'Origin Zone' });
  const originZoneId = originZoneRes.body.zone.id as string;

  const destZoneRes = await request(app)
    .post('/locations/zones')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ hubId, name: 'Dest Zone' });
  const destZoneId = destZoneRes.body.zone.id as string;

  const pickupRes = await request(app)
    .post('/locations/pickup-points')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      hubId,
      zoneId: originZoneId,
      name: 'Shipments Pickup',
      address: '10 Pickup Road, London',
    });
  const pickupLocationId = pickupRes.body.pickupLocation.id as string;

  const deliveryOptRes = await request(app)
    .post('/pricing/delivery-options')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ code: 'STANDARD', name: 'Standard Delivery' });
  const deliveryOptionId = deliveryOptRes.body.deliveryOption.id as string;

  const ruleRes = await request(app)
    .post('/pricing/rules')
    .set('Authorization', `Bearer ${adminToken}`)
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
  if (ruleRes.status !== 201) {
    throw new Error(`setupShipmentsTest: pricing rule seed failed: ${JSON.stringify(ruleRes.body)}`);
  }

  async function bookShipment(recipientName = 'Test Recipient'): Promise<string> {
    const res = await request(app)
      .post('/pricing/book')
      .set('Authorization', `Bearer ${tokens.get('CUSTOMER1')}`)
      .send({
        recipientName,
        recipientEmail: 'recipient-shipments@test.com',
        pickupLocationId,
        destinationZoneId: destZoneId,
        deliveryOptionId,
        packages: [{ sizeClass: 'SMALL', weightClass: 'LIGHT', quantity: 1 }],
      });
    if (res.status !== 201) {
      throw new Error(`setupShipmentsTest.bookShipment failed: ${JSON.stringify(res.body)}`);
    }
    return res.body.shipment.id as string;
  }

  const bookedShipmentId = roles.includes('CUSTOMER1') ? await bookShipment() : '';

  return {
    db,
    app,
    ids: { originZoneId, destZoneId, pickupLocationId, deliveryOptionId, bookedShipmentId },
    token(role) {
      const t = tokens.get(role);
      if (!t) throw new Error(`setupShipmentsTest: ${role} was not seeded`);
      return t;
    },
    bookShipment,
    cleanup() {
      return testDb.cleanup();
    },
  };
}

/** Inserts a shipment row directly at the given status, bypassing the API. */
export async function seedShipmentAt(
  db: Db,
  status: (typeof shipments.$inferSelect)['status'],
): Promise<string> {
  const [row] = await db
    .insert(shipments)
    .values({ status, recipientName: `Seeded ${status}`, senderName: 'Seeder' })
    .returning();
  return row!.id;
}
