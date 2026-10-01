import { and, eq } from 'drizzle-orm';

import { notificationLogs, users } from '@logistics/db';

import type { Mailer } from '../auth/emails.js';
import type { Db } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';

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
  if (!MILESTONES.has(event.toStatus)) {
    logger.info(
      { shipmentId: shipment.id, toStatus: event.toStatus, eventId: event.id },
      'notifications.milestone-skipped',
    );
    return;
  }

  const key = `shipment.status:${shipment.id}:${event.id}`;
  const shortId = shipment.id.slice(0, 8);
  const subject = `Shipment ${shortId} is ${event.toStatus}`;
  const where = event.locationLabel ? ` at ${event.locationLabel}` : '';
  const body = `Shipment ${shipment.id} moved to ${event.toStatus}${where}.`;

  const audience = new Map<string, string | null>();
  if (shipment.senderUserId) {
    const sender = await db.query.users.findFirst({
      where: (t, { eq: eql }) => eql(t.id, shipment.senderUserId!),
    });
    if (sender?.email) {
      audience.set(sender.email.toLowerCase(), sender.id);
    } else {
      logger.warn(
        {
          shipmentId: shipment.id,
          senderUserId: shipment.senderUserId,
          reason: sender ? 'email-missing' : 'user-not-found',
        },
        'notifications.sender-unresolved',
      );
    }
  }
  if (shipment.recipientEmail) {
    const lower = shipment.recipientEmail.toLowerCase();
    if (!audience.has(lower)) {
      const recipient = await db.query.users.findFirst({
        where: (_t, { sql: rawSql }) => rawSql`lower(${users.email}) = ${lower}`,
      });
      audience.set(lower, recipient?.id ?? null);
    } else {
      logger.info(
        { email: lower, shipmentId: shipment.id, toStatus: event.toStatus },
        'notifications.recipient-merged',
      );
    }
  }

  if (audience.size === 0) {
    logger.warn(
      {
        shipmentId: shipment.id,
        toStatus: event.toStatus,
        hasSenderUserId: Boolean(shipment.senderUserId),
        hasRecipientEmail: Boolean(shipment.recipientEmail),
      },
      'notifications.empty-audience',
    );
    return;
  }

  const entries = [...audience];
  for (const [index, [email, userId]] of entries.entries()) {
    const context = {
      email,
      shipmentId: shipment.id,
      toStatus: event.toStatus,
      channel: 'EMAIL' as const,
      recipientIndex: index,
      audienceSize: entries.length,
    };

    let logId: string | undefined;
    try {
      const claimed = await db
        .insert(notificationLogs)
        .values({
          userId,
          channel: 'EMAIL',
          type: key,
          subject,
          body,
          status: 'PENDING',
          payload: { shipmentId: shipment.id, toStatus: event.toStatus },
        })
        .onConflictDoNothing({ target: [notificationLogs.channel, notificationLogs.type] })
        .returning({ id: notificationLogs.id });
      logId = claimed[0]?.id;

      if (!logId) {
        const [existing] = await db
          .select({ id: notificationLogs.id, status: notificationLogs.status })
          .from(notificationLogs)
          .where(and(eq(notificationLogs.channel, 'EMAIL'), eq(notificationLogs.type, key)))
          .limit(1);
        if (!existing || existing.status === 'PENDING' || existing.status === 'SENT') {
          logger.info({ ...context, type: key }, 'notifications.dedup-skipped');
          continue;
        }
        await db
          .update(notificationLogs)
          .set({ status: 'PENDING' })
          .where(eq(notificationLogs.id, existing.id));
        logId = existing.id;
        logger.info({ ...context, type: key }, 'notifications.retry-claimed');
      }
    } catch (err) {
      logger.error({ ...context, err }, 'notifications.log-write-failed');
      continue;
    }

    let delivered = false;
    try {
      await mailer.sendNotificationEmail(email, subject, body);
      delivered = true;
    } catch (err) {
      logger.error({ ...context, err, notificationLogId: logId }, 'notifications.email-failed');
    }

    try {
      await db
        .update(notificationLogs)
        .set(delivered ? { status: 'SENT', sentAt: new Date() } : { status: 'FAILED' })
        .where(eq(notificationLogs.id, logId));
    } catch (err) {
      logger.error({ ...context, err, notificationLogId: logId }, 'notifications.log-write-failed');
    }

    if (delivered) {
      logger.info({ ...context, notificationLogId: logId }, 'notifications.email-sent');
    }

    if (userId) {
      try {
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
      } catch (err) {
        logger.error({ ...context, err, channel: 'IN_APP' }, 'notifications.log-write-failed');
      }
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
