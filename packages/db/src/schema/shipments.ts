import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './identity.js';
import { zones, pickupLocations } from './locations.js';
import {
  currencyEnum,
  shipmentStatusEnum,
  sizeClassEnum,
  weightClassEnum,
} from './enums.js';
import { deliveryOptions } from './pricing.js';

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: shipmentStatusEnum('status').notNull().default('DRAFT'),
    fieldLock: boolean('field_lock').notNull().default(false),
    senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
    senderName: text('sender_name'),
    senderEmail: text('sender_email'),
    senderPhone: text('sender_phone'),
    recipientName: text('recipient_name'),
    recipientEmail: text('recipient_email'),
    recipientPhone: text('recipient_phone'),
    pickupLocationId: uuid('pickup_location_id').references(() => pickupLocations.id, {
      onDelete: 'set null',
    }),
    destinationZoneId: uuid('destination_zone_id').references(() => zones.id, {
      onDelete: 'set null',
    }),
    deliveryOptionId: uuid('delivery_option_id').references(() => deliveryOptions.id, {
      onDelete: 'set null',
    }),
    quoteAmountCents: integer('quote_amount_cents'),
    quoteCurrency: currencyEnum('quote_currency'),
    quoteSnapshot: jsonb('quote_snapshot'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    specialInstructions: text('special_instructions'),
    category: text('category'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shipments_sender_user_id_idx').on(t.senderUserId),
    index('shipments_destination_zone_id_idx').on(t.destinationZoneId),
  ],
);

export const packages = pgTable(
  'packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    sizeClass: sizeClassEnum('size_class').notNull(),
    weightClass: weightClassEnum('weight_class').notNull(),
    weightGrams: integer('weight_grams'),
    quantity: integer('quantity').notNull().default(1),
    customDimensions: jsonb('custom_dimensions'),
    category: text('category'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('packages_shipment_id_idx').on(t.shipmentId)],
);

export const shipmentEvents = pgTable(
  'shipment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    fromStatus: shipmentStatusEnum('from_status'),
    toStatus: shipmentStatusEnum('to_status').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    locationLabel: text('location_label'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    metadata: jsonb('metadata'),
    deviceId: uuid('device_id'),
    opId: uuid('op_id'),
    operatorId: text('operator_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shipment_events_shipment_id_idx').on(t.shipmentId),
    index('shipment_events_shipment_occurred_idx').on(t.shipmentId, t.occurredAt),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull().unique(),
    requestHash: text('request_hash').notNull(),
    shipmentId: uuid('shipment_id').references(() => shipments.id, { onDelete: 'set null' }),
    response: jsonb('response'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);