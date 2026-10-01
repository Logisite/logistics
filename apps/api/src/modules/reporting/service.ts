import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import { collections, fxRates, reconciliations, settlements, shipmentEvents, shipments, zones } from '@logistics/db';
import { getConfig } from '../../shared/config.js';
import type { Db } from '../../shared/db.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { convertCents } from '../cod/index.js';

type RateMap = Map<string, string>;

// ::float8, not ::int, on every money aggregate in this module: sum(int) is bigint
// and ::int overflows past 2,147,483,647 cents (GBP 21,474,836.47), turning a large
// tenant's report into a 500. float8 stays a JSON number and is exact to 2^53 cents.
// Do not cast back to int. Guarded by test/cod.money.test.ts.

async function loadRates(db: Db, currencies: string[], at: Date): Promise<RateMap> {
  const functional = getConfig().functionalCurrency;
  const distinct = [...new Set(currencies.filter((c) => c !== functional))];
  const map: RateMap = new Map();
  if (distinct.length === 0) return map;
  const rows = await db
    .select({ fromCurrency: fxRates.fromCurrency, rate: fxRates.rate, rateDate: fxRates.rateDate })
    .from(fxRates)
    .where(and(inArray(fxRates.fromCurrency, distinct as never), eq(fxRates.toCurrency, functional as never), lte(fxRates.rateDate, at)))
    .orderBy(sql`${fxRates.rateDate} desc`.mapWith(String));
  for (const c of distinct) {
    const hit = rows.find((r) => r.fromCurrency === c);
    if (!hit) throw badRequest('FX_RATE_MISSING', `Missing FX rate ${c}->${functional}`);
    map.set(c, hit.rate);
  }
  return map;
}

export async function revenueVolume(db: Db, from?: string, to?: string, zoneId?: string, route?: string) {
  if (from && to && new Date(from).getTime() > new Date(to).getTime()) throw badRequest('VALIDATION', 'from must be before to');
  if (zoneId) {
    const [z] = await db.select().from(zones).where(eq(zones.id, zoneId));
    if (!z) throw notFound('NOT_FOUND', 'Zone not found');
  }
  const where = [];
  if (from) where.push(gte(shipments.createdAt, new Date(from)));
  if (to) where.push(lte(shipments.createdAt, new Date(to)));
  if (zoneId) where.push(eq(shipments.destinationZoneId, zoneId));
  if (route) where.push(eq(shipments.destinationZoneId, route));
  const clause = where.length ? and(...where) : undefined;
  const rows = await db
    .select({ currency: shipments.quoteCurrency, count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${shipments.quoteAmountCents}),0)::float8` })
    .from(shipments)
    .where(clause)
    .groupBy(shipments.quoteCurrency);
  const at = to ? new Date(to) : new Date();
  const currencies = rows.map((r) => r.currency).filter(Boolean) as string[];
  const rates = await loadRates(db, currencies, at);
  const functional = getConfig().functionalCurrency;
  return rows
    .filter((r) => r.currency)
    .map((r) => {
      const rate = rates.get(r.currency!) ?? '1.00000000';
      return { currency: r.currency!, count: r.count, totalMinor: r.total, functionalCurrency: functional, functionalTotalMinor: convertCents(r.total, rate) };
    });
}

export async function codReconciliationReport(db: Db, periodStart?: string, periodEnd?: string) {
  if (periodStart && periodEnd && new Date(periodStart).getTime() > new Date(periodEnd).getTime()) throw badRequest('VALIDATION', 'periodStart must be before periodEnd');
  const where = [];
  if (periodStart) where.push(gte(collections.createdAt, new Date(periodStart)));
  if (periodEnd) where.push(lte(collections.createdAt, new Date(periodEnd)));
  const clause = where.length ? and(...where) : undefined;
  const reconWhere = [];
  if (periodStart) reconWhere.push(gte(reconciliations.createdAt, new Date(periodStart)));
  if (periodEnd) reconWhere.push(lte(reconciliations.createdAt, new Date(periodEnd)));
  const reconClause = reconWhere.length ? and(...reconWhere) : undefined;
  // A settlement is scoped by its own period, not by the timestamp of a reconciliation row.
  // Count the settlements whose period overlaps the requested window.
  const settlementWhere = [];
  if (periodStart) settlementWhere.push(gte(settlements.periodEnd, new Date(periodStart)));
  if (periodEnd) settlementWhere.push(lte(settlements.periodStart, new Date(periodEnd)));
  const settlementClause = settlementWhere.length ? and(...settlementWhere) : undefined;
  const [cols, recons, sets, reconFunctionalRows, reconciledIdsRows, allCols] = await Promise.all([
    db.select({ currency: collections.currency, count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${collections.amountCents}),0)::float8` }).from(collections).where(clause).groupBy(collections.currency),
    db.select({ count: sql<number>`count(*)::int` }).from(reconciliations).where(reconClause),
    db.select({ count: sql<number>`count(*)::int` }).from(settlements).where(settlementClause),
    db.select({ amount: reconciliations.functionalAmountCents }).from(reconciliations).where(reconClause),
    db.select({ id: reconciliations.collectionId }).from(reconciliations).where(reconClause),
    db.select({ id: collections.id, currency: collections.currency, amountCents: collections.amountCents }).from(collections).where(clause),
  ]);
  const at = periodEnd ? new Date(periodEnd) : new Date();
  const currencies = [...new Set([...cols.map((c) => c.currency), ...allCols.map((c) => c.currency)])];
  const rates = await loadRates(db, currencies, at);
  const sumFunctional = (list: Array<{ currency: string; amountCents?: number; total?: number }>) =>
    list.reduce((s, r) => {
      const amt = (r as { amountCents?: number; total?: number }).amountCents ?? (r as { total?: number }).total ?? 0;
      return s + convertCents(amt, rates.get(r.currency) ?? '1.00000000');
    }, 0);
  const functionalCollections = sumFunctional(cols.map((c) => ({ currency: c.currency, total: c.total })));
  const reconFunctional = reconFunctionalRows.reduce((s, r) => s + r.amount, 0);
  const reconciledIds = new Set(reconciledIdsRows.map((r) => r.id));
  const unreconciledRows = allCols.filter((c) => !reconciledIds.has(c.id));
  const unreconciledFunctional = sumFunctional(unreconciledRows.map((u) => ({ currency: u.currency, amountCents: u.amountCents })));
  const shortfall = functionalCollections - reconFunctional;
  return {
    collections: cols,
    reconciliations: recons[0]?.count ?? 0,
    settlements: sets[0]?.count ?? 0,
    unreconciled: { count: unreconciledRows.length, totalFunctionalMinor: unreconciledFunctional },
    shortfall,
    functionalCurrency: getConfig().functionalCurrency,
  };
}

export async function driverPerformance(db: Db, periodStart?: string, periodEnd?: string) {
  const where = [];
  if (periodStart) where.push(gte(collections.collectedAt, new Date(periodStart)));
  if (periodEnd) where.push(lte(collections.collectedAt, new Date(periodEnd)));
  const clause = where.length ? and(...where) : undefined;
  const base = await db.select({ driverUserId: collections.driverUserId, deliveries: sql<number>`count(*)::int`, avgEpoch: sql<number | null>`avg(extract(epoch from ${collections.collectedAt}))` }).from(collections).where(clause).groupBy(collections.driverUserId);
  const failedRows = await db.select({ driverUserId: shipmentEvents.actorUserId, count: sql<number>`count(*)::int` }).from(shipmentEvents).where(eq(shipmentEvents.toStatus, 'FAILED_ATTEMPT')).groupBy(shipmentEvents.actorUserId);
  const returnedRows = await db.select({ driverUserId: shipmentEvents.actorUserId, count: sql<number>`count(*)::int` }).from(shipmentEvents).where(eq(shipmentEvents.toStatus, 'RETURNED')).groupBy(shipmentEvents.actorUserId);
  const failedByDriver = new Map(failedRows.map((r) => [r.driverUserId, r.count]));
  const returnedByDriver = new Map(returnedRows.map((r) => [r.driverUserId, r.count]));
  return base.map((r) => ({
    driverUserId: r.driverUserId,
    deliveries: r.deliveries,
    failedAttempts: failedByDriver.get(r.driverUserId) ?? 0,
    returns: returnedByDriver.get(r.driverUserId) ?? 0,
    avgSeconds: r.avgEpoch !== null ? Math.round(r.avgEpoch) : null,
  }));
}

export async function exceptionsAging(db: Db, ageDays = 7) {
  const cutoff = sql`${shipments.updatedAt} < now() - (${ageDays}::int * interval '1 day')`;
  const stuckRows = await db
    .select()
    .from(shipments)
    .where(and(inArray(shipments.status, ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'FAILED_ATTEMPT', 'RETURNED'] as never), cutoff));
  const now = Date.now();
  const stuck = stuckRows.map((s) => ({ shipmentId: s.id, status: s.status, ageDays: Math.floor((now - new Date(s.updatedAt).getTime()) / (24 * 60 * 60 * 1000)) }));
  const buckets = { '7-14': 0, '14-30': 0, '30+': 0 };
  for (const s of stuck) {
    if (s.ageDays >= 7 && s.ageDays < 14) buckets['7-14']++;
    else if (s.ageDays >= 14 && s.ageDays < 30) buckets['14-30']++;
    else if (s.ageDays >= 30) buckets['30+']++;
  }
  const failed = await db.select({ count: sql<number>`count(*)::int` }).from(shipmentEvents).where(eq(shipmentEvents.toStatus, 'FAILED_ATTEMPT'));
  const returned = await db.select({ count: sql<number>`count(*)::int` }).from(shipments).where(eq(shipments.status, 'RETURNED'));
  return { stuck, failedAttempts: failed[0]?.count ?? 0, returned: returned[0]?.count ?? 0, agingBuckets: buckets, ageDays };
}
