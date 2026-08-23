import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './identity.js';

export const notificationChannelEnum = pgEnum('notification_channel', ['EMAIL', 'IN_APP']);

export const notificationLogs = pgTable(
  'notification_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // nullable, unregistered recipients get email at their booking address
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    channel: notificationChannelEnum('channel').notNull(),
    type: text('type').notNull(),
    subject: text('subject'),
    body: text('body'),
    payload: jsonb('payload'),
    status: text('status').notNull().default('QUEUED'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notification_logs_user_id_idx').on(t.userId),
    index('notification_logs_status_idx').on(t.status),
  ],
);