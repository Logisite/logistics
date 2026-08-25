import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './identity.js';

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('devices_user_id_idx').on(t.userId)],
);

export const syncLedger = pgTable(
  'sync_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    opId: uuid('op_id').notNull(),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id'),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sync_ledger_device_seq_unique').on(t.deviceId, t.seq),
    unique('sync_ledger_device_op_unique').on(t.deviceId, t.opId),
    index('sync_ledger_device_id_idx').on(t.deviceId),
  ],
);

export const syncOps = pgTable(
  'sync_ops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    opId: uuid('op_id').notNull(),
    opType: text('op_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('QUEUED'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sync_ops_device_op_id_unique').on(t.deviceId, t.opId),
    unique('sync_ops_device_seq_unique').on(t.deviceId, t.seq),
    index('sync_ops_device_id_idx').on(t.deviceId),
  ],
);

export const staticReferences = pgTable('static_references', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull().unique(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  payload: jsonb('payload').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});