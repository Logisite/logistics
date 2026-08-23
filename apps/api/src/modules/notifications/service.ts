import { and, eq } from 'drizzle-orm';

import { notificationLogs, users } from '@logistics/db';

import type { Mailer } from '../../auth/emails.js';
import type { Db } from '../../db.js';

import type { ShipmentStatus } from '../shipments/index.js';
import type { shipmentEvents, shipments } from '@logistics/db';

const MILESTONES: ReadonlySet<ShipmentStatus> = new Set([
  'BOOKED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'FAILED_ATTEMPT',
  'DELIVERED',
  'RETURNED',
  'CANCELLED',
]);

type ShipmentRow = typeof shipments.$inferSelect;
type EventRow = typeof shipmentEvents.$inferSelect;

/**
 * fan out to everyone with visibility
 * dedup key lives in the type column so replays never double send
 */
export async function notifyTransition(
  db: Db,
  mailer: Mailer,
  shipment: ShipmentRow,
  event: EventRow,
): Promise<void> {
  if (!MILESTONES.has(event.toStatus)) return;

  const key = `shipment.status:${shipment.id}:${event.toStatus}`;
  const already = await db
    .select({ id: notificationLogs.id })
    .from(notificationLogs)
    .where(and(eq(notificationLogs.channel, 'EMAIL'), eq(notificationLogs.type, key)))
    .limit(1);
  if (already.length > 0) return;

  const shortId = shipment.id.slice(0, 8);
  const subject = `Shipment ${shortId} is ${event.toStatus}`;
  const where = event.locationLabel ? ` at ${event.locationLabel}` : '';
  const body = `Shipment ${shipment.id} moved to ${event.toStatus}${where}.`;

  const audience = new Map<string, string | null>();
  if (shipment.senderUserId) {
    const sender = await db.query.users.findFirst({
      where: (t, { eq: eql }) => eql(t.id, shipment.senderUserId!),
    });
    if (sender?.email) audience.set(sender.email.toLowerCase(), sender.id);
  }
  if (shipment.recipientEmail) {
    const lower = shipment.recipientEmail.toLowerCase();
    if (!audience.has(lower)) {
      const recipient = await db.query.users.findFirst({
        where: (_t, { sql: rawSql }) => rawSql`lower(${users.email}) = ${lower}`,
      });
      audience.set(lower, recipient?.id ?? null);
    }
  }

  for (const [email, userId] of audience) {
    const [row] = await db
      .insert(notificationLogs)
      .values({
        userId,
        channel: 'EMAIL',
        type: key,
        subject,
        body,
        payload: { shipmentId: shipment.id, toStatus: event.toStatus },
      })
      .returning();
    try {
      await mailer.sendNotificationEmail(email, subject, body);
      await db
        .update(notificationLogs)
        .set({ status: 'SENT', sentAt: new Date() })
        .where(eq(notificationLogs.id, row!.id));
    } catch {
      await db
        .update(notificationLogs)
        .set({ status: 'FAILED' })
        .where(eq(notificationLogs.id, row!.id));
    }

    if (userId) {
      await db.insert(notificationLogs).values({
        userId,
        channel: 'IN_APP',
        type: key,
        subject,
        body,
        status: 'SENT',
        sentAt: new Date(),
        payload: { shipmentId: shipment.id, toStatus: event.toStatus },
      });
    }
  }
}

export async function listInApp(db: Db, userId: string) {
  return db.query.notificationLogs.findMany({
    where: (t, { eq: eql, and: both }) =>
      both(eql(t.userId, userId), eql(t.channel, 'IN_APP')),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}
