import {
  index,
  integer,
  numeric,
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
import { currencyEnum } from './enums.js';
import { runs } from './operations.js';

export const paymentMethodEnum = pgEnum('payment_method', ['CASH', 'CARD']);

export const collections = pgTable(
  'collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'restrict' }),
    driverUserId: uuid('driver_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    amountCents: integer('amount_cents').notNull(),
    currency: currencyEnum('currency').notNull(),
    paymentMethod: paymentMethodEnum('payment_method').notNull(),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('COLLECTED'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('collections_shipment_id_idx').on(t.shipmentId),
    index('collections_driver_user_id_idx').on(t.driverUserId),
  ],
);

export const deposits = pgTable(
  'deposits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    branchOperatorUserId: uuid('branch_operator_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    hubId: uuid('hub_id')
      .notNull()
      .references(() => hubs.id, { onDelete: 'restrict' }),
    driverUserId: uuid('driver_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    amountCents: integer('amount_cents').notNull(),
    currency: currencyEnum('currency').notNull(),
    depositedAt: timestamp('deposited_at', { withTimezone: true }).notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('deposits_hub_id_idx').on(t.hubId),
    index('deposits_driver_user_id_idx').on(t.driverUserId),
  ],
);

export const reconciliations = pgTable(
  'reconciliations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    depositId: uuid('deposit_id')
      .notNull()
      .references(() => deposits.id, { onDelete: 'restrict' }),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'restrict' }),
    fxRate: numeric('fx_rate').notNull(),
    functionalCurrency: currencyEnum('functional_currency').notNull(),
    functionalAmountCents: integer('functional_amount_cents').notNull(),
    reconciledByUserId: uuid('reconciled_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('MATCHED'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reconciliations_deposit_id_idx').on(t.depositId),
    index('reconciliations_collection_id_idx').on(t.collectionId),
  ],
);

export const settlements = pgTable('settlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantProfileId: uuid('merchant_profile_id'),
  functionalCurrency: currencyEnum('functional_currency').notNull(),
  functionalAmountCents: integer('functional_amount_cents').notNull(),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('PENDING'),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const disputes = pgTable(
  'disputes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('OPEN'),
    amountCents: integer('amount_cents').notNull(),
    currency: currencyEnum('currency').notNull(),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('disputes_collection_id_idx').on(t.collectionId)],
);
export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromCurrency: currencyEnum('from_currency').notNull(),
    toCurrency: currencyEnum('to_currency').notNull(),
    // decimal string like 0.85528000, never a float
    rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
    rateDate: timestamp('rate_date', { withTimezone: true }).notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('fx_rates_pair_date_unique').on(t.fromCurrency, t.toCurrency, t.rateDate)],
);

export const settlementLines = pgTable(
  'settlement_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    settlementId: uuid('settlement_id')
      .notNull()
      .references(() => settlements.id, { onDelete: 'cascade' }),
    reconciliationId: uuid('reconciliation_id')
      .notNull()
      .references(() => reconciliations.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('settlement_lines_reconciliation_unique').on(t.reconciliationId),
    index('settlement_lines_settlement_id_idx').on(t.settlementId),
  ],
);
