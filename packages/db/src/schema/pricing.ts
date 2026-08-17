import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { zones } from './locations.js';
import { currencyEnum, deliveryOptionEnum, sizeClassEnum, weightClassEnum } from './enums.js';

export const deliveryOptions = pgTable(
  'delivery_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: deliveryOptionEnum('code').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const pricingRules = pgTable(
  'pricing_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    originZoneId: uuid('origin_zone_id')
      .notNull()
      .references(() => zones.id, { onDelete: 'restrict' }),
    destinationZoneId: uuid('destination_zone_id')
      .notNull()
      .references(() => zones.id, { onDelete: 'restrict' }),
    sizeClass: sizeClassEnum('size_class').notNull(),
    weightClass: weightClassEnum('weight_class').notNull(),
    deliveryOptionId: uuid('delivery_option_id')
      .notNull()
      .references(() => deliveryOptions.id, { onDelete: 'restrict' }),
    currency: currencyEnum('currency').notNull(),
    amountCents: integer('amount_cents').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pricing_rules_origin_zone_id_idx').on(t.originZoneId),
    index('pricing_rules_destination_zone_id_idx').on(t.destinationZoneId),
    index('pricing_rules_delivery_option_id_idx').on(t.deliveryOptionId),
  ],
);