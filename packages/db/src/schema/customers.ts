import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './identity.js';
import { zones, hubs, pickupLocations } from './locations.js';

export const customerProfiles = pgTable(
  'customer_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    phone: text('phone'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('customer_profiles_user_id_unique').on(t.userId)],
);

export const addresses = pgTable(
  'addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customerProfiles.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city').notNull(),
    zoneId: uuid('zone_id').references(() => zones.id, { onDelete: 'set null' }),
    hubId: uuid('hub_id').references(() => hubs.id, { onDelete: 'set null' }),
    pickupLocationId: uuid('pickup_location_id').references(() => pickupLocations.id, {
      onDelete: 'set null',
    }),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('addresses_customer_id_idx').on(t.customerId)],
);

export const emergencyContacts = pgTable(
  'emergency_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customerProfiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    relationship: text('relationship').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('emergency_contacts_customer_id_idx').on(t.customerId)],
);