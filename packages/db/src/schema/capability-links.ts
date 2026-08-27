import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './identity.js';
import { shipments } from './shipments.js';
import { capabilityActionEnum } from './enums.js';

export const capabilityLinks = pgTable(
  'capability_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nonce: text('nonce').notNull().unique(),
    action: capabilityActionEnum('action').notNull(),
    hmacSignature: text('hmac_signature').notNull(),
    senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
    recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'set null' }),
    shipmentId: uuid('shipment_id').references(() => shipments.id, { onDelete: 'set null' }),
    payload: jsonb('payload').notNull().default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('capability_links_sender_user_id_idx').on(t.senderUserId),
    index('capability_links_recipient_user_id_idx').on(t.recipientUserId),
    index('capability_links_expires_at_idx').on(t.expiresAt),
  ],
);
