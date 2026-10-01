import { and, eq, lt, sql } from 'drizzle-orm';

import {
  collections,
  disputes,
  fxRates,
  merchantProfiles,
  reconciliations,
  settlementLines,
  settlements,
  shipments,
} from '@logistics/db';

import { writeAudit } from '../auth/audit.js';
import type { AuthContext } from '../auth/middleware.js';
import type { Db } from '../../shared/db.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

import { FUNCTIONAL_CURRENCY } from './fx.js';

import type { Currency } from './fx.js';

// ---------------------------------------------------------------------------
// Settlements, disputes, FX maintenance, reporting
// ---------------------------------------------------------------------------

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

  let excludedOpenDispute = 0;
  let excludedAlreadySettled = 0;
  let excludedOutOfPeriod = 0;
  let excludedWrongCurrency = 0;
  const eligible = rows.filter((r) => {
    if (r.openDispute) {
      excludedOpenDispute += 1;
      return false;
    }
    if (r.settledLineId) {
      excludedAlreadySettled += 1;
      return false;
    }
    if (!(r.reconciliation.reconciledAt >= periodStart)) {
      excludedOutOfPeriod += 1;
      return false;
    }
    if (r.reconciliation.functionalCurrency !== FUNCTIONAL_CURRENCY) {
      excludedWrongCurrency += 1;
      return false;
    }
    return true;
  });

  const groups = new Map<string, typeof eligible>();
  const unattributed: typeof eligible = [];
  const profileByUser = new Map<string, string | null>();
  for (const row of eligible) {
    if (!row.senderUserId) {
      unattributed.push(row);
      continue;
    }
    if (!profileByUser.has(row.senderUserId)) {
      const [profile] = await db
        .select({ id: merchantProfiles.id })
        .from(merchantProfiles)
        .where(eq(merchantProfiles.userId, row.senderUserId));
      profileByUser.set(row.senderUserId, profile?.id ?? null);
    }
    const profileId = profileByUser.get(row.senderUserId) ?? null;
    if (!profileId) {
      logger.warn(
        {
          senderUserId: row.senderUserId,
          reconciliationId: row.reconciliation.id,
          functionalAmountCents: row.reconciliation.functionalAmountCents,
          functionalCurrency: row.reconciliation.functionalCurrency,
        },
        'cod.settlement-unmatched-merchant',
      );
      unattributed.push(row);
      continue;
    }
    const bucket = groups.get(profileId) ?? [];
    bucket.push(row);
    groups.set(profileId, bucket);
  }

  if (unattributed.length > 0) {
    logger.error(
      {
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        count: unattributed.length,
        functionalAmountCents: unattributed.reduce(
          (sum, r) => sum + r.reconciliation.functionalAmountCents,
          0,
        ),
        functionalCurrency: FUNCTIONAL_CURRENCY,
      },
      'cod.settlement-unattributable',
    );
  }

  const created = [];
  for (const [merchantProfileId, groupRows] of groups) {
    const total = groupRows.reduce((sum, r) => sum + r.reconciliation.functionalAmountCents, 0);
    const settlementCtx = {
      merchantProfileId,
      functionalAmountCents: total,
      functionalCurrency: FUNCTIONAL_CURRENCY,
      lineCount: groupRows.length,
    };
    try {
      const settlement = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(settlements)
          .values({
            merchantProfileId,
            functionalCurrency: FUNCTIONAL_CURRENCY,
            functionalAmountCents: total,
            periodStart,
            periodEnd,
          })
          .returning();
        if (!row) throw new Error('computeSettlements: settlement insert returned nothing');
        await tx.insert(settlementLines).values(
          groupRows.map((r) => ({
            settlementId: row.id,
            reconciliationId: r.reconciliation.id,
          })),
        );
        return row;
      });
      created.push(settlement!);
      logger.info({ ...settlementCtx, settlementId: settlement!.id }, 'cod.settlement-created');
    } catch (err) {
      logger.error({ err, ...settlementCtx }, 'cod.settlement-failed');
      throw err;
    }
  }

  logger.info(
    {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      eligibleCount: eligible.length,
      excludedOpenDispute,
      excludedAlreadySettled,
      excludedOutOfPeriod,
      excludedWrongCurrency,
      createdCount: created.length,
    },
    'cod.settlement-computed',
  );

  await writeAudit(db, ctx, {
    action: 'cod.settlement.compute',
    entityType: 'settlement',
    payload: { periodStart, periodEnd, created: created.map((s) => s.id) },
  });
  return created;
}

export async function markSettled(db: Db, ctx: AuthContext, settlementId: string) {
  const [existing] = await db
    .select({ status: settlements.status, merchantProfileId: settlements.merchantProfileId })
    .from(settlements)
    .where(eq(settlements.id, settlementId))
    .limit(1);
  if (!existing) {
    logger.warn({ reason: 'not-found', settlementId }, 'cod.settlement-rejected');
    throw notFound('NOT_FOUND', 'Settlement not found');
  }
  if (existing.status !== 'PENDING') {
    logger.warn(
      { reason: 'already-settled', settlementId, previousStatus: existing.status },
      'cod.settlement-rejected',
    );
    throw conflict('ALREADY_SETTLED', `Settlement is already ${existing.status}`);
  }

  const [updated] = await db
    .update(settlements)
    .set({ status: 'SETTLED', settledAt: new Date() })
    .where(and(eq(settlements.id, settlementId), eq(settlements.status, 'PENDING')))
    .returning();
  if (!updated) {
    logger.warn({ reason: 'lost-race', settlementId }, 'cod.settlement-rejected');
    throw conflict('ALREADY_SETTLED', 'Settlement was settled concurrently');
  }

  logger.info(
    {
      settlementId,
      merchantProfileId: updated.merchantProfileId,
      functionalAmountCents: updated.functionalAmountCents,
      functionalCurrency: updated.functionalCurrency,
    },
    'cod.settlement-settled',
  );

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
  if (!collection) {
    logger.warn(
      { reason: 'collection-not-found', collectionId: input.collectionId },
      'cod.dispute-rejected',
    );
    throw notFound('NOT_FOUND', 'Collection not found');
  }

  const open = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(and(eq(disputes.collectionId, input.collectionId), eq(disputes.status, 'OPEN')));
  if (open.length > 0) {
    logger.warn(
      { reason: 'already-open', collectionId: input.collectionId },
      'cod.dispute-rejected',
    );
    throw conflict('DISPUTE_OPEN', 'An OPEN dispute already exists');
  }

  const [row] = await db
    .insert(disputes)
    .values({
      collectionId: input.collectionId,
      reason: input.reason,
      amountCents: input.amountCents,
      currency: input.currency,
    })
    .returning();

  logger.info(
    {
      disputeId: row!.id,
      collectionId: input.collectionId,
      amountCents: input.amountCents,
      currency: input.currency,
    },
    'cod.dispute-opened',
  );
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
  if (!updated) {
    logger.warn({ disputeId, resolution }, 'cod.dispute-resolve-rejected');
    throw notFound('NOT_FOUND', 'Open dispute not found');
  }

  logger.info(
    { disputeId, collectionId: updated.collectionId, resolution },
    'cod.dispute-resolved',
  );

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
    logger.warn(
      { fromCurrency: input.fromCurrency, toCurrency: input.toCurrency, rateDate: input.rateDate },
      'cod.fx-rate-rejected',
    );
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

  logger.info(
    {
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      rate: input.rate,
      rateDate: input.rateDate,
    },
    'cod.fx-rate-upserted',
  );
  await writeAudit(db, ctx, {
    action: 'cod.fx_rate.upsert',
    entityType: 'fx_rate',
    entityId: row!.id,
    payload: { ...input },
  });
  return row!;
}

/** unreconciled COLLECTED totals per currency */
// ::float8, not ::int: sum(int) is bigint and ::int overflows past 2,147,483,647
// cents (GBP 21,474,836.47), which turned a large tenant's summary into a 500.
// float8 stays a JSON number and is exact to 2^53 cents. Do not cast back to int.
export async function pendingSummary(db: Db) {
  return db
    .select({
      currency: collections.currency,
      count: sql<number>`count(*)::int`,
      total: sql<number>`coalesce(sum(${collections.amountCents}), 0)::float8`,
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
