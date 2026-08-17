import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const hubs = pgTable(
  'hubs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    code: text('code').notNull().unique(),
    address: text('address').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const pickupLocations = pgTable(
  'pickup_locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hubId: uuid('hub_id').references(() => hubs.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    address: text('address').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('pickup_locations_hub_id_idx').on(t.hubId)],
);

export const zones = pgTable(
  'zones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hubId: uuid('hub_id')
      .notNull()
      .references(() => hubs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('zones_hub_name_unique').on(t.hubId, t.name)],
);