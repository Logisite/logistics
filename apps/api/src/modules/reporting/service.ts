import { and, eq, gte, lte, sql } from 'drizzle-orm';

import { collections, reconciliations, settlements, shipmentEvents, shipments } from '@logistics/db';
import type { Db } from '../../db.js';

export async function revenueVolume(db: Db, from?: string, to?: string) {
  const where = [];
  if (from) where.push(gte(shipments.createdAt, new Date(from)));
  if (to) where.push(lte(shipments.createdAt, new Date(to)));
  const clause = where.length ? and(...where) : undefined;
  const rows = await db.select({ currency: shipments.quoteCurrency, count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${shipments.quoteAmountCents}),0)::int` }).from(shipments).where(clause).groupBy(shipments.quoteCurrency);
  return rows;
}

export async function codReconciliationReport(db: Db) {
  const cols = await db.select({ currency: collections.currency, count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${collections.amountCents}),0)::int` }).from(collections).groupBy(collections.currency);
  const recons = await db.select({ count: sql<number>`count(*)::int` }).from(reconciliations);
  const sets = await db.select({ count: sql<number>`count(*)::int` }).from(settlements);
  return { collections: cols, reconciliations: recons[0]?.count ?? 0, settlements: sets[0]?.count ?? 0 };
}

export async function driverPerformance(db: Db) {
  return db.select({ driverUserId: collections.driverUserId, deliveries: sql<number>`count(*)::int` }).from(collections).groupBy(collections.driverUserId);
}

export async function exceptionsAging(db: Db) {
  const stuck = await db.select().from(shipments).where(and(eq(shipments.status, 'IN_TRANSIT'), sql`${shipments.updatedAt} < now() - interval '7 days'`));
  const failed = await db.select().from(shipmentEvents).where(eq(shipmentEvents.toStatus, 'FAILED_ATTEMPT'));
  return { stuck, failedAttempts: failed.length };
}
