import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { notificationLogs, users } from '@logistics/db';

import { setupShipmentsTest } from './shipments.fixture.js';
import type { ShipmentsFixture } from './shipments.fixture.js';
import { TEST_PASSWORD, seedUserWithRoles } from './helpers.js';

describe('notifications: milestone fan-out', () => {
  let f: ShipmentsFixture;
  let recipientUserId: string;

  beforeAll(async () => {
    f = await setupShipmentsTest(['ADMIN', 'CUSTOMER1']);
    await seedUserWithRoles(f.db, ['CUSTOMER'], 'recipient-shipments@test.com');
    const [row] = await f.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'recipient-shipments@test.com'));
    recipientUserId = row!.id;
  });

  afterAll(async () => {
    await f.cleanup();
  });

  function emailRows(shipmentId: string, toStatus?: string) {
    return f.db
      .select()
      .from(notificationLogs)
      .where(
        toStatus
          ? and(
              eq(notificationLogs.channel, 'EMAIL'),
              eq(notificationLogs.type, `shipment.status:${shipmentId}:${toStatus}`),
            )
          : eq(notificationLogs.channel, 'EMAIL'),
      );
  }

  it('sends email + in-app rows for registered sender on a milestone', async () => {
    const res = await request(f.app)
      .post(`/shipments/${f.ids.bookedShipmentId}/pickup`)
      .set('Authorization', `Bearer ${f.token('ADMIN')}`);
    expect(res.status).toBe(200);

    const emails = await emailRows(f.ids.bookedShipmentId, 'PICKED_UP');
    expect(emails.length).toBeGreaterThanOrEqual(1);
    expect(emails.every((r) => r.status === 'SENT' && r.sentAt !== null)).toBe(true);

    const inApp = await f.db
      .select()
      .from(notificationLogs)
      .where(eq(notificationLogs.channel, 'IN_APP'));
    expect(inApp.length).toBeGreaterThanOrEqual(1);

    expect(f.mailer.notificationsTo('customer1-shipments@example.com').length).toBeGreaterThanOrEqual(1);
  });

  it('emails an unregistered recipient at the booking address with null userId', async () => {
    // A fresh booking whose recipient email has NO user account.
    const res = await request(f.app)
      .post('/pricing/book')
      .set('Authorization', `Bearer ${f.token('CUSTOMER1')}`)
      .send({
        recipientName: 'Ghost Recipient',
        recipientEmail: 'unregistered-notify@test.com',
        pickupLocationId: f.ids.pickupLocationId,
        destinationZoneId: f.ids.destZoneId,
        deliveryOptionId: f.ids.deliveryOptionId,
        packages: [{ sizeClass: 'SMALL', weightClass: 'LIGHT', quantity: 1 }],
      });
    expect(res.status).toBe(201);
    const ghostId = res.body.shipment.id as string;

    await request(f.app)
      .post(`/shipments/${ghostId}/pickup`)
      .set('Authorization', `Bearer ${f.token('ADMIN')}`);

    const emails = await emailRows(ghostId, 'PICKED_UP');
    const raw = emails.find((r) => r.userId === null);
    expect(raw).toBeTruthy();
    expect(f.mailer.notificationsTo('unregistered-notify@test.com').length).toBeGreaterThanOrEqual(1);
  });

  it('skips IN_TRANSIT entirely', async () => {
    const before = await emailRows(f.ids.bookedShipmentId).execute().then((r) => r.length);
    const res = await request(f.app)
      .post(`/shipments/${f.ids.bookedShipmentId}/transit`)
      .set('Authorization', `Bearer ${f.token('ADMIN')}`);
    expect(res.status).toBe(200);
    const after = await emailRows(f.ids.bookedShipmentId).execute().then((r) => r.length);
    expect(after).toBe(before);
  });

  it('never double-sends the same milestone', async () => {
    const id = await f.bookShipment('No Duplicate');
    const firstPost = await request(f.app)
      .post(`/shipments/${id}/pickup`)
      .set('Authorization', `Bearer ${f.token('ADMIN')}`);
    expect(firstPost.status).toBe(200);

    // Same-state replay is a no-op event=null.
    const res = await request(f.app)
      .post(`/shipments/${id}/pickup`)
      .set('Authorization', `Bearer ${f.token('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.event).toBeNull();

    const picks = f.mailer.sent.filter(
      (m) => m.kind === 'notification' && m.body.includes(id),
    );
    expect(picks.length).toBeLessThanOrEqual(2); // one per audience address at most
    const rowsForPickup = await emailRows(id, 'PICKED_UP');
    expect(rowsForPickup.length).toBeLessThanOrEqual(2);
  });

  it('notifies FAILED_ATTEMPT as an exception milestone', async () => {
    const id = await f.bookShipment('Failed Attempt Notify');
    await request(f.app).post(`/shipments/${id}/pickup`).set('Authorization', `Bearer ${f.token('ADMIN')}`);
    await request(f.app).post(`/shipments/${id}/transit`).set('Authorization', `Bearer ${f.token('ADMIN')}`);
    await request(f.app)
      .post(`/shipments/${id}/out-for-delivery`)
      .set('Authorization', `Bearer ${f.token('ADMIN')}`);

    const res = await request(f.app)
      .post(`/shipments/${id}/fail-attempt`)
      .set('Authorization', `Bearer ${f.token('ADMIN')}`)
      .send({ reason: 'recipient absent' });
    expect(res.status).toBe(200);

    const rows = await emailRows(id, 'FAILED_ATTEMPT');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.payload).toMatchObject({ shipmentId: id });
  });

  it('exposes the in-app feed via notifications module reads', async () => {
    const rows = await f.db
      .select()
      .from(notificationLogs)
      .where(and(eq(notificationLogs.channel, 'IN_APP'), eq(notificationLogs.userId, recipientUserId)));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
