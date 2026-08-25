import { and, eq, gte, lte, sql } from 'drizzle-orm';

import { collections, fxRates, reconciliations, settlements, shipmentEvents, shipments } from '@logistics/db';
import { getConfig } from '../../config.js';
import type { Db } from '../../db.js';
import { convertCents } from '../cod/fx.js';

async function functionalRate(db: Db, from: string, to: string, at: Date) {
  if (from === to) return '1.00000000';
  const [row] = await db
    .select({ rate: fxRates.rate })
    .from(fxRates)
    .where(and(eq(fxRates.fromCurrency, from as never), eq(fxRates.toCurrency, to as never), lte(fxRates.rateDate, at)))
    .orderBy(sql`${fxRates.rateDate} desc`)
    .limit(1);
  return row?.rate ?? '1.00000000';
}

export async function revenueVolume(db: Db, from?: string, to?: string, zoneId?: string) {
  const where = [];
  if (from) where.push(gte(shipments.createdAt, new Date(from)));
  if (to) where.push(lte(shipments.createdAt, new Date(to)));
  if (zoneId) where.push(eq(shipments.destinationZoneId, zoneId));
  const clause = where.length ? and(...where) : undefined;
  const rows = await db
    .select({ currency: shipments.quoteCurrency, count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${shipments.quoteAmountCents}),0)::int` })
    .from(shipments)
    .where(clause)
    .groupBy(shipments.quoteCurrency);
  const functional = getConfig().functionalCurrency;
  const at = to ? new Date(to) : new Date();
  const out = [];
  for (const r of rows) {
    if (!r.currency) continue;
    const rate = await functionalRate(db, r.currency, functional, at);
    out.push({ currency: r.currency, count: r.count, totalMinor: r.total, functionalCurrency: functional, functionalTotalMinor: convertCents(r.total, rate) });
  }
  return out;
}

export async function codReconciliationReport(db: Db) {
  const cols = await db
    .select({ currency: collections.currency, count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${collections.amountCents}),0)::int` })
    .from(collections)
    .groupBy(collections.currency);
  const recons = await db.select({ count: sql<number>`count(*)::int` }).from(reconciliations);
  const sets = await db.select({ count: sql<number>`count(*)::int` }).from(settlements);
  const functional = getConfig().functionalCurrency;
  let functionalCollections = 0;
  for (const c of cols) {
    const rate = await functionalRate(db, c.currency, functional, new Date());
    functionalCollections += convertCents(c.total, rate);
  }
  const reconFunctionalRows = await db.select({ amount: reconciliations.functionalAmountCents }).from(reconciliations);
  const reconFunctional = reconFunctionalRows.reduce((s, r) => s + r.amount, 0);
  const shortfall = functionalCollections - reconFunctional;
  return { collections: cols, reconciliations: recons[0]?.count ?? 0, settlements: sets[0]?.count ?? 0, shortfall, functionalCurrency: functional };
}

export async function driverPerformance(db: Db) {
  const base = await db.select({ driverUserId: collections.driverUserId, deliveries: sql<number>`count(*)::int` }).from(collections).groupBy(collections.driverUserId);
  const failedRows = await db.select({ driverUserId: shipmentEvents.actorUserId, count: sql<number>`count(*)::int` }).from(shipmentEvents).where(eq(shipmentEvents.toStatus, 'FAILED_ATTEMPT')).groupBy(shipmentEvents.actorUserId);
  const failedByDriver = new Map(failedRows.map((r) => [r.driverUserId, r.count]));
  return base.map((r) => ({ driverUserId: r.driverUserId, deliveries: r.deliveries, failedAttempts: failedByDriver.get(r.driverUserId) ?? 0 }));
}

export async function exceptionsAging(db: Db, ageDays = 7) {
  const cutoff = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  const stuck = await db
    .select()
    .from(shipments)
    .where(and(sql`${shipments.status} IN ('IN_TRANSIT','OUT_FOR_DELIVERY','FAILED_ATTEMPT','RETURNED')`, sql`${shipments.updatedAt} < ${cutoff}`));
  const failed = await db.select({ count: sql<number>`count(*)::int` }).from(shipmentEvents).where(eq(shipmentEvents.toStatus, 'FAILED_ATTEMPT'));
  const returned = await db.select({ count: sql<number>`count(*)::int` }).from(shipments).where(eq(shipments.status, 'RETURNED'));
  return { stuck, failedAttempts: failed[0]?.count ?? 0, returned: returned[0]?.count ?? 0, ageDays };
}
