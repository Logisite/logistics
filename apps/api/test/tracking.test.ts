import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupShipmentsTest } from './shipments.fixture.js';
import type { ShipmentsFixture } from './shipments.fixture.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

describe('tracking: auth-only visibility', () => {
  let f: ShipmentsFixture;
  let recipientToken: string;
  let strangerToken: string;

  beforeAll(async () => {
    f = await setupShipmentsTest(['ADMIN', 'MERCHANT', 'CUSTOMER1', 'CUSTOMER2']);

    // The fixture books with recipientEmail recipient-shipments@test.com.
    // Register a user owning that address so the recipient path has an account.
    await seedUserWithRoles(f.db, ['CUSTOMER'], 'recipient-shipments@test.com');
    const login = await request(f.app)
      .post('/api/v1/auth/login')
      .send({ email: 'recipient-shipments@test.com', password: TEST_PASSWORD });
    recipientToken = login.body.accessToken as string;

    await seedUserWithRoles(f.db, ['CUSTOMER'], 'stranger-tracking@example.com');
    const strangerLogin = await request(f.app)
      .post('/api/v1/auth/login')
      .send({ email: 'stranger-tracking@example.com', password: TEST_PASSWORD });
    strangerToken = strangerLogin.body.accessToken as string;

    // A second shipment where CUSTOMER2 is the sender.
    const res = await request(f.app)
      .post('/api/v1/pricing/book')
      .set('Authorization', `Bearer ${f.token('CUSTOMER2')}`)
      .send({
        recipientName: 'Other Sender',
        pickupLocationId: f.ids.pickupLocationId,
        destinationZoneId: f.ids.destZoneId,
        deliveryOptionId: f.ids.deliveryOptionId,
        packages: [{ sizeClass: 'SMALL', weightClass: 'LIGHT', quantity: 1 }],
      });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await f.cleanup();
  });

  it('lists shipments where the caller is the sender, tagged sender', async () => {
    const res = await request(f.app)
      .get('/api/v1/tracking/shipments')
      .set('Authorization', `Bearer ${f.token('CUSTOMER1')}`);
    expect(res.status).toBe(200);
    const mine = res.body.shipments.filter((s: { role: string }) => s.role === 'sender');
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.some((s: { shipment: { id: string } }) => s.shipment.id === f.ids.bookedShipmentId)).toBe(true);
  });

  it('lists shipments addressed to the caller email, tagged recipient', async () => {
    const res = await request(f.app)
      .get('/api/v1/tracking/shipments')
      .set('Authorization', `Bearer ${recipientToken}`);
    expect(res.status).toBe(200);
    expect(res.body.shipments.length).toBeGreaterThanOrEqual(1);
    for (const entry of res.body.shipments) {
      expect(entry.shipment.recipientEmail?.toLowerCase()).toBe('recipient-shipments@test.com');
    }
  });

  it('matches emails case-insensitively', async () => {
    // CUSTOMER2 books with a mixed-case senderEmail next.
    const res = await request(f.app)
      .post('/api/v1/pricing/book')
      .set('Authorization', `Bearer ${f.token('CUSTOMER2')}`)
      .send({
        recipientName: 'Case Test',
        senderEmail: 'CuStOmEr1-SHIPMENTS@example.com',
        pickupLocationId: f.ids.pickupLocationId,
        destinationZoneId: f.ids.destZoneId,
        deliveryOptionId: f.ids.deliveryOptionId,
        packages: [{ sizeClass: 'SMALL', weightClass: 'LIGHT', quantity: 1 }],
      });
    expect(res.status).toBe(201);

    const list = await request(f.app)
      .get('/api/v1/tracking/shipments')
      .set('Authorization', `Bearer ${f.token('CUSTOMER1')}`);
    const found = list.body.shipments.find(
      (s: { shipment: { id: string } }) => s.shipment.id === res.body.shipment.id,
    );
    expect(found).toBeTruthy();
    expect(found.role).toBe('sender');
  });

  it('returns nothing for users without visibility', async () => {
    const res = await request(f.app)
      .get('/api/v1/tracking/shipments')
      .set('Authorization', `Bearer ${strangerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.shipments).toHaveLength(0);
  });

  it('rejects unauthenticated list calls', async () => {
    const res = await request(f.app).get('/api/v1/tracking/shipments');
    expect(res.status).toBe(401);
  });

  it('lets the sender read their own timeline but stays silent for strangers', async () => {
    const own = await request(f.app)
      .get(`/api/v1/shipments/${f.ids.bookedShipmentId}/events`)
      .set('Authorization', `Bearer ${f.token('CUSTOMER1')}`);
    expect(own.status).toBe(200);
    expect(own.body.events.length).toBeGreaterThanOrEqual(1);

    const stranger = await request(f.app)
      .get(`/api/v1/shipments/${f.ids.bookedShipmentId}/events`)
      .set('Authorization', `Bearer ${strangerToken}`);
    expect(stranger.status).toBe(404);

    const staff = await request(f.app)
      .get(`/api/v1/shipments/${f.ids.bookedShipmentId}/events`)
      .set('Authorization', `Bearer ${f.token('ADMIN')}`);
    expect(staff.status).toBe(200);
  });
});
