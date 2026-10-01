import { and, eq, inArray } from 'drizzle-orm';

import {
  collections,
  deposits,
  disputes,
  reconciliations,
  roleGrants,
  roles,
  shipments,
  users,
} from '@logistics/db';

import { writeAudit } from '../auth/audit.js';
import type { AuthContext } from '../auth/middleware.js';
import type { Db } from '../../shared/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

import { FUNCTIONAL_CURRENCY, latestRate, toFunctional } from './fx.js';

import type { Currency } from './fx.js';

function resolveSelfOrAdmin(ctx: AuthContext, requested?: string): string {
  if (!requested || requested === ctx.userId) return ctx.userId;
  if (ctx.roleName !== 'ADMIN') {
    logger.warn(
      { actorUserId: ctx.userId, roleName: ctx.roleName, requestedDriverUserId: requested },
      'cod.driver-mismatch-rejected',
    );
    throw forbidden('FORBIDDEN', 'Only an admin can record a collection for another driver');
  }
  return requested;
}

async function assertDriver(db: Db, userId: string): Promise<void> {
  const [driver] = await db
    .select({ isActive: users.isActive })
    .from(users)
    .innerJoin(roleGrants, eq(roleGrants.userId, users.id))
    .innerJoin(roles, eq(roles.id, roleGrants.roleId))
    .where(and(eq(users.id, userId), eq(roles.name, 'DRIVER')))
    .limit(1);
  if (!driver) {
    logger.warn({ driverUserId: userId }, 'cod.driver-mismatch-rejected');
    throw notFound('NOT_FOUND', 'Driver not found');
  }
  if (!driver.isActive) throw badRequest('VALIDATION', 'Driver account is inactive');
}

// ---------------------------------------------------------------------------
// Collections, deposits, reconciliation
// ---------------------------------------------------------------------------

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
  if (!shipment) {
    logger.warn(
      { reason: 'shipment-not-found', shipmentId: input.shipmentId, actorUserId: ctx.userId },
      'cod.collection-rejected',
    );
    throw notFound('NOT_FOUND', 'Shipment not found');
  }
  if (shipment.status !== 'DELIVERED') {
    logger.warn(
      {
        reason: 'not-delivered',
        shipmentId: input.shipmentId,
        shipmentStatus: shipment.status,
        amountCents: input.amountCents,
        currency: input.currency,
      },
      'cod.collection-rejected',
    );
    throw conflict('NOT_DELIVERED', 'Collections are captured on DELIVERED shipments only');
  }

  const driverUserId = resolveSelfOrAdmin(ctx, input.driverUserId);
  const claimed = await db
    .insert(collections)
    .values({
      shipmentId: input.shipmentId,
      driverUserId,
      amountCents: input.amountCents,
      currency: input.currency,
      paymentMethod: input.paymentMethod,
      collectedAt: input.collectedAt ? new Date(input.collectedAt) : new Date(),
    })
    .onConflictDoNothing({ target: collections.shipmentId })
    .returning();

  if (!claimed[0]) {
    const [existing] = await db
      .select()
      .from(collections)
      .where(eq(collections.shipmentId, input.shipmentId))
      .limit(1);
    logger.info(
      { shipmentId: input.shipmentId, collectionId: existing?.id, actorUserId: ctx.userId },
      'cod.collection-deduped',
    );
    if (!existing) throw conflict('DUPLICATE_COLLECTION', 'Shipment already collected');
    return existing;
  }

  const row = claimed[0];
  logger.info(
    {
      collectionId: row.id,
      shipmentId: input.shipmentId,
      driverUserId,
      amountCents: input.amountCents,
      currency: input.currency,
      paymentMethod: input.paymentMethod,
    },
    'cod.collection-recorded',
  );
  await writeAudit(db, ctx, {
    action: 'cod.collection.create',
    entityType: 'collection',
    entityId: row.id,
    payload: { shipmentId: input.shipmentId },
  });
  return row;
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
  await assertDriver(db, input.driverUserId);
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

  logger.info(
    {
      depositId: row!.id,
      hubId: input.hubId,
      driverUserId: input.driverUserId,
      amountCents: input.amountCents,
      currency: input.currency,
    },
    'cod.deposit-recorded',
  );
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
  if (collectionIds.length === 0) {
    logger.warn({ reason: 'empty', depositId, collectionCount: 0 }, 'cod.reconcile-rejected');
    throw badRequest('VALIDATION', 'No collections supplied');
  }
  if (new Set(collectionIds).size !== collectionIds.length) {
    logger.warn(
      { reason: 'duplicates', depositId, collectionCount: collectionIds.length },
      'cod.reconcile-rejected',
    );
    throw badRequest('VALIDATION', 'Duplicate collection ids');
  }

  const result = await db.transaction(async (tx) => {
    const [deposit] = await tx.select().from(deposits).where(eq(deposits.id, depositId)).for('update');
    if (!deposit) {
      logger.warn({ reason: 'deposit-not-found', depositId }, 'cod.reconcile-rejected');
      throw notFound('NOT_FOUND', 'Deposit not found');
    }

    const cols = await tx
      .select()
      .from(collections)
      .where(inArray(collections.id, collectionIds));
    if (cols.length !== collectionIds.length) {
      logger.warn(
        {
          reason: 'collections-missing',
          depositId,
          requestedCount: collectionIds.length,
          foundCount: cols.length,
        },
        'cod.reconcile-rejected',
      );
      throw badRequest('VALIDATION', 'One or more collections do not exist');
    }
    for (const c of cols) {
        if (c.driverUserId !== deposit.driverUserId) {
          logger.warn(
            {
              reason: 'driver-mismatch',
              depositId,
              collectionId: c.id,
              collectionDriverUserId: c.driverUserId,
              depositDriverUserId: deposit.driverUserId,
            },
            'cod.reconcile-rejected',
          );
          throw badRequest(
            'VALIDATION',
            'Collection does not belong to the driver who made this deposit',
          );
        }
      }
      for (const c of cols) {
        if (c.status !== 'COLLECTED') {
        logger.warn(
          { reason: 'not-collected', depositId, collectionId: c.id, collectionStatus: c.status },
          'cod.reconcile-rejected',
        );
        throw conflict('NOT_COLLECTED', `Collection ${c.id} is ${c.status}, not COLLECTED`);
      }
    }

    const openDisputes = await tx
      .select({ collectionId: disputes.collectionId })
      .from(disputes)
      .where(and(inArray(disputes.collectionId, collectionIds), eq(disputes.status, 'OPEN')));
    if (openDisputes.length > 0) {
      logger.warn(
        {
          depositId,
          blockedCount: openDisputes.length,
          collectionIds: openDisputes.map((d) => d.collectionId),
        },
        'cod.reconcile-blocked-by-dispute',
      );
      throw conflict('DISPUTED', `${openDisputes.length} collection(s) have OPEN disputes`);
    }

    const alreadyReconciled = await tx
      .select({ collectionId: reconciliations.collectionId })
      .from(reconciliations)
      .where(inArray(reconciliations.collectionId, collectionIds));
    if (alreadyReconciled.length > 0) {
      logger.warn(
        {
          reason: 'already-reconciled',
          depositId,
          count: alreadyReconciled.length,
          collectionIds: alreadyReconciled.map((r) => r.collectionId),
        },
        'cod.reconcile-rejected',
      );
      throw conflict('ALREADY_RECONCILED', `${alreadyReconciled.length} collection(s) already reconciled`);
    }

    // conversion point is the deposit time
    const depositedAt = deposit.depositedAt;
    const rates = new Map<string, { rate: string }>();
    async function rateFor(from: Currency): Promise<string> {
      if (from === FUNCTIONAL_CURRENCY) return '1';
      if (!rates.has(from)) {
        try {
          rates.set(from, await latestRate(tx, from, FUNCTIONAL_CURRENCY, depositedAt));
        } catch (err) {
          logger.warn(
            { from, to: FUNCTIONAL_CURRENCY, before: depositedAt.toISOString(), depositId },
            'cod.fx-rate-missing',
          );
          throw err;
        }
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
      logger.warn(
        {
          depositId,
          sumFunctionalCents: sumFunctional,
          depositFunctionalCents: depositFunctional,
          functionalCurrency: FUNCTIONAL_CURRENCY,
          collectionCount: cols.length,
        },
        'cod.reconcile-mismatch',
      );
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

  logger.info(
    {
      depositId,
      reconciliationIds: result.map((r) => r!.id),
      collectionCount: result.length,
      sumFunctionalCents: result.reduce((sum, r) => sum + r!.functionalAmountCents, 0),
      functionalCurrency: FUNCTIONAL_CURRENCY,
    },
    'cod.reconciled',
  );
  await writeAudit(db, ctx, {
    action: 'cod.reconcile',
    entityType: 'deposit',
    entityId: depositId,
    payload: { collectionIds },
  });
  return result;
}
