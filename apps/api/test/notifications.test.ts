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
    // bookedShipmentId recipient has no user yet -> EMAIL row with null userId.
    const emails = await emailRows(f.ids.bookedShipmentId, 'PICKED_UP');
    const raw = emails.find((r) => r.userId === null);
    expect(raw).toBeTruthy();
    expect(f.mailer.notificationsTo('recipient-shipments@test.com').length).toBeGreaterThanOrEqual(1);
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
    // PICKED_UP already fired once; a same-state replay is a no-op event=null.
    const res = await request(f.app)
      .post(`/shipments/${f.ids.bookedShipmentId}/pickup`)
      .set('Authorization', `Bearer ${f.token('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.event).toBeNull();

    const picks = f.mailer.sent.filter(
      (m) => m.kind === 'notification' && m.subject?.includes('PICKED_UP'),
    );
    expect(picks.length).toBeLessThanOrEqual(2); // one per audience address at most
    const rowsForPickup = await emailRows(f.ids.bookedShipmentId, 'PICKED_UP');
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
