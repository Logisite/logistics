import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './identity.js';
import { contactChannelEnum } from './enums.js';

export const contactIdentities = pgTable(
  'contact_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: contactChannelEnum('channel').notNull(),
    identifier: text('identifier').notNull(),
    country: text('country'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('contact_identities_user_channel_identifier_unique').on(t.userId, t.channel, t.identifier),
    index('contact_identities_user_id_idx').on(t.userId),
    index('contact_identities_channel_identifier_idx').on(t.channel, t.identifier),
  ],
);
