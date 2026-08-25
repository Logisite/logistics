import { and, eq, gte, lte, sql } from 'drizzle-orm';

import { collections, fxRates, reconciliations, settlements, shipmentEvents, shipments, zones } from '@logistics/db';
import { getConfig } from '../../config.js';
import type { Db } from '../../db.js';
import { badRequest, notFound } from '../../errors.js';
import { convertCents } from '../cod/index.js';

async function functionalRate(db: Db, from: string, to: string, at: Date) {
  if (from === to) return '1.00000000';
  const [row] = await db
    .select({ rate: fxRates.rate })
    .from(fxRates)
    .where(and(eq(fxRates.fromCurrency, from as never), eq(fxRates.toCurrency, to as never), lte(fxRates.rateDate, at)))
    .orderBy(sql`${fxRates.rateDate} desc`)
    .limit(1);
  if (!row) throw badRequest('FX_RATE_MISSING', `Missing FX rate ${from}->${to} at ${at.toISOString()}`);
  return row.rate;
}

async function toFunctional(db: Db, amount: number, currency: string, at: Date) {
  const functional = getConfig().functionalCurrency;
  const rate = await functionalRate(db, currency, functional, at);
  return { functional, total: convertCents(amount, rate) };
}

export async function revenueVolume(db: Db, from?: string, to?: string, zoneId?: string) {
  if (zoneId) {
    const [z] = await db.select().from(zones).where(eq(zones.id, zoneId));
    if (!z) throw notFound('NOT_FOUND', 'Zone not found');
  }
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
  const at = to ? new Date(to) : new Date();
  const out = [];
  for (const r of rows) {
    if (!r.currency) continue;
    const conv = await toFunctional(db, r.total, r.currency, at);
    out.push({ currency: r.currency, count: r.count, totalMinor: r.total, functionalCurrency: conv.functional, functionalTotalMinor: conv.total });
  }
  return out;
}

export async function codReconciliationReport(db: Db, periodStart?: string, periodEnd?: string) {
  const where = [];
  if (periodStart) where.push(gte(collections.createdAt, new Date(periodStart)));
  if (periodEnd) where.push(lte(collections.createdAt, new Date(periodEnd)));
  const clause = where.length ? and(...where) : undefined;
  const cols = await db
    .select({ currency: collections.currency, count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${collections.amountCents}),0)::int` })
    .from(collections)
    .where(clause)
    .groupBy(collections.currency);
  const recons = await db.select({ count: sql<number>`count(*)::int` }).from(reconciliations);
  const sets = await db.select({ count: sql<number>`count(*)::int` }).from(settlements);
  const at = periodEnd ? new Date(periodEnd) : new Date();
  let functionalCollections = 0;
  for (const c of cols) {
    const conv = await toFunctional(db, c.total, c.currency, at);
    functionalCollections += conv.total;
  }
  const reconFunctionalRows = await db.select({ amount: reconciliations.functionalAmountCents }).from(reconciliations);
  const reconFunctional = reconFunctionalRows.reduce((s, r) => s + r.amount, 0);
  const reconciledIds = new Set((await db.select({ id: reconciliations.collectionId }).from(reconciliations)).map((r) => r.id));
  const allCols = await db.select({ id: collections.id, currency: collections.currency, amountCents: collections.amountCents }).from(collections).where(clause);
  const unreconciledRows = allCols.filter((c) => !reconciledIds.has(c.id));
  let unreconciledFunctional = 0;
  for (const u of unreconciledRows) {
    const conv = await toFunctional(db, u.amountCents, u.currency, at);
    unreconciledFunctional += conv.total;
  }
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

export async function driverPerformance(db: Db) {
  const base = await db.select({ driverUserId: collections.driverUserId, deliveries: sql<number>`count(*)::int` }).from(collections).groupBy(collections.driverUserId);
  const failedRows = await db.select({ driverUserId: shipmentEvents.actorUserId, count: sql<number>`count(*)::int` }).from(shipmentEvents).where(eq(shipmentEvents.toStatus, 'FAILED_ATTEMPT')).groupBy(shipmentEvents.actorUserId);
  const returnedRows = await db.select({ driverUserId: shipmentEvents.actorUserId, count: sql<number>`count(*)::int` }).from(shipmentEvents).where(eq(shipmentEvents.toStatus, 'RETURNED')).groupBy(shipmentEvents.actorUserId);
  const failedByDriver = new Map(failedRows.map((r) => [r.driverUserId, r.count]));
  const returnedByDriver = new Map(returnedRows.map((r) => [r.driverUserId, r.count]));
  return base.map((r) => ({
    driverUserId: r.driverUserId,
    deliveries: r.deliveries,
    failedAttempts: failedByDriver.get(r.driverUserId) ?? 0,
    returns: returnedByDriver.get(r.driverUserId) ?? 0,
    avgSeconds: null as number | null,
  }));
}

export async function exceptionsAging(db: Db, ageDays = 7) {
  const cutoff = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  const stuckRows = await db
    .select()
    .from(shipments)
    .where(and(sql`${shipments.status} IN ('IN_TRANSIT','OUT_FOR_DELIVERY','FAILED_ATTEMPT','RETURNED')`, sql`${shipments.updatedAt} < ${cutoff}`));
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
