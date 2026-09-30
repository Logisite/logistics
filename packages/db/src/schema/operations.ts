import {
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './identity.js';
import { hubs } from './locations.js';
import { shipments } from './shipments.js';

export const runStatusEnum = pgEnum('run_status', ['PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED']);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    driverUserId: uuid('driver_user_id').references(() => users.id, { onDelete: 'set null' }),
    hubId: uuid('hub_id').references(() => hubs.id, { onDelete: 'set null' }),
    status: runStatusEnum('status').notNull().default('PLANNED'),
    scheduledDate: timestamp('scheduled_date', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('runs_driver_user_id_idx').on(t.driverUserId),
    index('runs_hub_id_idx').on(t.hubId),
  ],
);

export const runSheetEntries = pgTable(
  'run_sheet_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    status: text('status').notNull().default('PENDING'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('run_sheet_entries_run_id_idx').on(t.runId),
    index('run_sheet_entries_shipment_id_idx').on(t.shipmentId),
    unique('run_sheet_entries_run_shipment_unique').on(t.runId, t.shipmentId),
    unique('run_sheet_entries_shipment_unique').on(t.shipmentId),
  ],
);

export const gpsPositions = pgTable(
  'gps_positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    driverUserId: uuid('driver_user_id').references(() => users.id, { onDelete: 'set null' }),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('gps_positions_run_id_idx').on(t.runId),
    index('gps_positions_driver_user_id_idx').on(t.driverUserId),
  ],
);