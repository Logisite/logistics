import { and, eq, inArray, lt, sql } from 'drizzle-orm';

import {
  collections,
  deposits,
  disputes,
  fxRates,
  merchantProfiles,
  reconciliations,
  settlementLines,
  settlements,
  shipments,
} from '@logistics/db';

import { getConfig } from '../../config.js';
import { writeAudit } from '../../auth/audit.js';
import type { AuthContext } from '../../auth/middleware.js';
import type { Db } from '../../db.js';
import { badRequest, conflict, notFound } from '../../errors.js';

import { convertCents } from './fx.js';

type Currency = 'USD' | 'EUR' | 'GBP';

// one functional currency per deployment, ADR 0004
export const FUNCTIONAL_CURRENCY: Currency = getConfig().functionalCurrency;

type Queryable = Pick<Db, 'select'>;

async function latestRate(
  q: Queryable,
  from: Currency,
  to: Currency,
  at: Date,
): Promise<{ rate: string; rateDate: Date }> {
  const [row] = await q
    .select({ rate: fxRates.rate, rateDate: fxRates.rateDate })
    .from(fxRates)
    .where(and(eq(fxRates.fromCurrency, from), eq(fxRates.toCurrency, to), lt(fxRates.rateDate, at)))
    .orderBy(sql`${fxRates.rateDate} desc`)
    .limit(1);
  if (!row) throw badRequest('FX_RATE_MISSING', `No ${from}->${to} rate on or before ${at.toISOString()}`);
  return row;
}

function toFunctional(amountCents: number, currency: Currency, rate: string): number {
  return currency === FUNCTIONAL_CURRENCY ? amountCents : convertCents(amountCents, rate);
}

export interface RecordCollectionInput {
  shipmentId: string;
  driverUserId?: string;
  amountCents: number;
  currency: Currency;
  paymentMethod: 'CASH' | 'CARD';
  collectedAt?: string;
}

export async function recordCollection(db: Db, ctx: AuthContext, input: RecordCollectionInput) {
  const [shipment] = await db.select().from(shipments).where(eq(shipments.id, input.shipmentId));
  if (!shipment) throw notFound('NOT_FOUND', 'Shipment not found');
  if (shipment.status !== 'DELIVERED') {
    throw conflict('NOT_DELIVERED', 'Collections are captured on DELIVERED shipments only');
  }

  const driverUserId = input.driverUserId ?? ctx.userId;
  const [row] = await db
    .insert(collections)
    .values({
      shipmentId: input.shipmentId,
      driverUserId,
      amountCents: input.amountCents,
      currency: input.currency,
      paymentMethod: input.paymentMethod,
      collectedAt: input.collectedAt ? new Date(input.collectedAt) : new Date(),
    })
    .returning();

  await writeAudit(db, ctx, {
    action: 'cod.collection.create',
    entityType: 'collection',
    entityId: row!.id,
    payload: { shipmentId: input.shipmentId },
  });
  return row!;
}

export interface RecordDepositInput {
  hubId: string;
  driverUserId: string;
  amountCents: number;
  currency: Currency;
  depositedAt?: string;
  notes?: string;
}

export async function recordDeposit(db: Db, ctx: AuthContext, input: RecordDepositInput) {
  const [row] = await db
    .insert(deposits)
    .values({
      hubId: input.hubId,
      driverUserId: input.driverUserId,
      branchOperatorUserId: ctx.userId,
      amountCents: input.amountCents,
      currency: input.currency,
      depositedAt: input.depositedAt ? new Date(input.depositedAt) : new Date(),
      notes: input.notes ?? null,
    })
    .returning();

  await writeAudit(db, ctx, {
    action: 'cod.deposit.create',
    entityType: 'deposit',
    entityId: row!.id,
  });
  return row!;
}

export async function reconcile(
  db: Db,
  ctx: AuthContext,
  depositId: string,
  collectionIds: string[],
) {
  if (collectionIds.length === 0) throw badRequest('VALIDATION', 'No collections supplied');
  if (new Set(collectionIds).size !== collectionIds.length) {
    throw badRequest('VALIDATION', 'Duplicate collection ids');
  }

  const result = await db.transaction(async (tx) => {
    const [deposit] = await tx.select().from(deposits).where(eq(deposits.id, depositId)).for('update');
    if (!deposit) throw notFound('NOT_FOUND', 'Deposit not found');

    const cols = await tx
      .select()
      .from(collections)
      .where(inArray(collections.id, collectionIds));
    if (cols.length !== collectionIds.length) {
      throw badRequest('VALIDATION', 'One or more collections do not exist');
    }
    for (const c of cols) {
      if (c.status !== 'COLLECTED') {
        throw conflict('NOT_COLLECTED', `Collection ${c.id} is ${c.status}, not COLLECTED`);
      }
    }

    const openDisputes = await tx
      .select({ collectionId: disputes.collectionId })
      .from(disputes)
      .where(and(inArray(disputes.collectionId, collectionIds), eq(disputes.status, 'OPEN')));
    if (openDisputes.length > 0) {
      throw conflict('DISPUTED', `${openDisputes.length} collection(s) have OPEN disputes`);
    }

    const alreadyReconciled = await tx
      .select({ collectionId: reconciliations.collectionId })
      .from(reconciliations)
      .where(inArray(reconciliations.collectionId, collectionIds));
    if (alreadyReconciled.length > 0) {
      throw conflict('ALREADY_RECONCILED', `${alreadyReconciled.length} collection(s) already reconciled`);
    }

    // conversion point is the deposit time
    const depositedAt = deposit.depositedAt;
    const rates = new Map<string, { rate: string }>();
    async function rateFor(from: Currency): Promise<string> {
      if (from === FUNCTIONAL_CURRENCY) return '1';
      if (!rates.has(from)) {
        rates.set(from, await latestRate(tx, from, FUNCTIONAL_CURRENCY, depositedAt));
      }
      return rates.get(from)!.rate;
    }

    let sumFunctional = 0;
    const lines: Array<{ collectionId: string; fxRate: string; functionalAmountCents: number }> = [];
    for (const c of cols) {
      const rate = await rateFor(c.currency);
      const functionalAmountCents = toFunctional(c.amountCents, c.currency, rate);
      sumFunctional += functionalAmountCents;
      lines.push({ collectionId: c.id, fxRate: rate, functionalAmountCents });
    }

    const depositFunctional = toFunctional(deposit.amountCents, deposit.currency, await rateFor(deposit.currency));
    if (sumFunctional !== depositFunctional) {
      throw conflict(
        'RECON_MISMATCH',
        `Collections convert to ${sumFunctional} ${FUNCTIONAL_CURRENCY} but the deposit is ${depositFunctional}`,
      );
    }

    const rows = [];
    for (const line of lines) {
      const [recon] = await tx
        .insert(reconciliations)
        .values({
          depositId,
          collectionId: line.collectionId,
          fxRate: line.fxRate,
          functionalCurrency: FUNCTIONAL_CURRENCY,
          functionalAmountCents: line.functionalAmountCents,
          reconciledByUserId: ctx.userId,
          reconciledAt: new Date(),
        })
        .returning();
      rows.push(recon!);
    }
    return rows;
  });

  await writeAudit(db, ctx, {
    action: 'cod.reconcile',
    entityType: 'deposit',
    entityId: depositId,
    payload: { collectionIds },
  });
  return result;
}

export async function computeSettlements(
  db: Db,
  ctx: AuthContext,
  periodStart: Date,
  periodEnd: Date,
) {
  const rows = await db
    .select({
      reconciliation: reconciliations,
      senderUserId: shipments.senderUserId,
      openDispute: sql<boolean>`exists (
        select 1 from ${disputes}
        where ${disputes.collectionId} = ${reconciliations.collectionId}
          and ${disputes.status} = 'OPEN'
      )`,
      settledLineId: settlementLines.id,
    })
    .from(reconciliations)
    .innerJoin(collections, eq(collections.id, reconciliations.collectionId))
    .innerJoin(shipments, eq(shipments.id, collections.shipmentId))
    .leftJoin(settlementLines, eq(settlementLines.reconciliationId, reconciliations.id))
    .where(and(eq(reconciliations.status, 'MATCHED'), lt(reconciliations.reconciledAt, periodEnd)));

  const eligible = rows.filter(
    (r) =>
      !r.openDispute &&
      !r.settledLineId &&
      r.reconciliation.reconciledAt >= periodStart &&
      r.reconciliation.functionalCurrency === FUNCTIONAL_CURRENCY,
  );

  const groups = new Map<string | null, typeof eligible>();
  for (const row of eligible) {
    let profileId: string | null = null;
    if (row.senderUserId) {
      const [profile] = await db
        .select({ id: merchantProfiles.id })
        .from(merchantProfiles)
        .where(eq(merchantProfiles.userId, row.senderUserId));
      profileId = profile?.id ?? null;
    }
    const bucket = groups.get(profileId) ?? [];
    bucket.push(row);
    groups.set(profileId, bucket);
  }

  const created = [];
  for (const [merchantProfileId, groupRows] of groups) {
    const total = groupRows.reduce((sum, r) => sum + r.reconciliation.functionalAmountCents, 0);
    const [settlement] = await db
      .insert(settlements)
      .values({
        merchantProfileId,
        functionalCurrency: FUNCTIONAL_CURRENCY,
        functionalAmountCents: total,
        periodStart,
        periodEnd,
      })
      .returning();
    for (const r of groupRows) {
      await db
        .insert(settlementLines)
        .values({ settlementId: settlement!.id, reconciliationId: r.reconciliation.id });
    }
    created.push(settlement!);
  }

  await writeAudit(db, ctx, {
    action: 'cod.settlement.compute',
    entityType: 'settlement',
    payload: { periodStart, periodEnd, created: created.map((s) => s.id) },
  });
  return created;
}

export async function markSettled(db: Db, ctx: AuthContext, settlementId: string) {
  const [updated] = await db
    .update(settlements)
    .set({ status: 'SETTLED', settledAt: new Date() })
    .where(eq(settlements.id, settlementId))
    .returning();
  if (!updated) throw notFound('NOT_FOUND', 'Settlement not found');

  await writeAudit(db, ctx, {
    action: 'cod.settlement.mark_settled',
    entityType: 'settlement',
    entityId: settlementId,
  });
  return updated;
}

export async function openDispute(
  db: Db,
  ctx: AuthContext,
  input: { collectionId: string; reason: string; amountCents: number; currency: Currency },
) {
  const [collection] = await db
    .select()
    .from(collections)
    .where(eq(collections.id, input.collectionId));
  if (!collection) throw notFound('NOT_FOUND', 'Collection not found');

  const open = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(and(eq(disputes.collectionId, input.collectionId), eq(disputes.status, 'OPEN')));
  if (open.length > 0) throw conflict('DISPUTE_OPEN', 'An OPEN dispute already exists');

  const [row] = await db
    .insert(disputes)
    .values({
      collectionId: input.collectionId,
      reason: input.reason,
      amountCents: input.amountCents,
      currency: input.currency,
    })
    .returning();

  await writeAudit(db, ctx, {
    action: 'cod.dispute.open',
    entityType: 'dispute',
    entityId: row!.id,
    payload: { collectionId: input.collectionId },
  });
  return row!;
}

export async function resolveDispute(
  db: Db,
  ctx: AuthContext,
  disputeId: string,
  resolution: 'RESOLVED' | 'REJECTED',
) {
  const [updated] = await db
    .update(disputes)
    .set({ status: resolution, resolvedByUserId: ctx.userId, resolvedAt: new Date() })
    .where(and(eq(disputes.id, disputeId), eq(disputes.status, 'OPEN')))
    .returning();
  if (!updated) throw notFound('NOT_FOUND', 'Open dispute not found');

  await writeAudit(db, ctx, {
    action: 'cod.dispute.resolve',
    entityType: 'dispute',
    entityId: disputeId,
    payload: { resolution },
  });
  return updated;
}

export async function addFxRate(
  db: Db,
  ctx: AuthContext,
  input: { fromCurrency: Currency; toCurrency: Currency; rate: string; rateDate: string },
) {
  if (!/^-?\d+(\.\d{1,8})?$/.test(input.rate)) {
    throw badRequest('VALIDATION', 'rate must be a decimal with at most 8 fractional digits');
  }
  const rateDate = new Date(input.rateDate);

  const [row] = await db
    .insert(fxRates)
    .values({
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      rate: input.rate,
      rateDate,
      createdByUserId: ctx.userId,
    })
    .onConflictDoUpdate({
      target: [fxRates.fromCurrency, fxRates.toCurrency, fxRates.rateDate],
      set: { rate: input.rate, createdByUserId: ctx.userId },
    })
    .returning();

  await writeAudit(db, ctx, {
    action: 'cod.fx_rate.upsert',
    entityType: 'fx_rate',
    entityId: row!.id,
    payload: { ...input },
  });
  return row!;
}

/** unreconciled COLLECTED totals per currency */
export async function pendingSummary(db: Db) {
  return db
    .select({
      currency: collections.currency,
      count: sql<number>`count(*)::int`,
      total: sql<number>`coalesce(sum(${collections.amountCents}), 0)::int`,
    })
    .from(collections)
    .where(
      and(
        eq(collections.status, 'COLLECTED'),
        sql`not exists (
          select 1 from ${reconciliations}
          where ${reconciliations.collectionId} = ${collections.id}
        )`,
      ),
    )
    .groupBy(collections.currency);
}
