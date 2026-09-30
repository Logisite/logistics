import { and, eq, inArray, sql } from 'drizzle-orm';

import { devices, runSheetEntries, runs, shipmentEvents, shipments, syncLedger } from '@logistics/db';

import { writeAudit } from '../auth/audit.js';
import type { AuthContext } from '../auth/middleware.js';
import { getConfig } from '../../shared/config.js';
import type { Db } from '../../shared/db.js';
import { badRequest } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

import { applyTransitionTx } from '../shipments/index.js';
import { syncEmitter } from './events.js';
import type { ShipmentStatusEvent } from './events.js';
import { canTransition } from '../shipments/index.js';
import type { ShipmentStatus } from '../shipments/index.js';
import type { TxHandle } from '../shipments/service.js';

const LOCKED_FIELDS = ['destinationZoneId', 'recipientName', 'recipientEmail', 'recipientPhone', 'deliveryOptionId', 'pickupLocationId'] as const;

async function reject(tx: Parameters<Parameters<Db['transaction']>[0]>[0], rowId: string, code: string) {
  await tx.update(syncLedger).set({ status: `REJECTED:${code}` }).where(eq(syncLedger.id, rowId));
  return { status: `REJECTED:${code}` } as const;
}

export async function ensureDevice(db: Db, userId: string, deviceId?: string) {
  if (deviceId) {
    const [d] = await db.select().from(devices).where(eq(devices.id, deviceId));
    if (d) {
      logger.info({ deviceId: d.id, userId }, 'sync.device-reused');
      return d;
    }
  }
  const [d] = await db.insert(devices).values({ userId, name: 'driver-device' }).returning();
  logger.info({ deviceId: d!.id, userId }, 'sync.device-provisioned');
  return d!;
}

export async function pushLedger(
  db: Db,
  ctx: AuthContext,
  deviceId: string,
  ops: Array<{ seq: number; opId: string; action: string; entity: string; entityId?: string; payload?: unknown }>,
) {
  const [device] = await db.select().from(devices).where(and(eq(devices.id, deviceId), eq(devices.userId, ctx.userId)));
  if (!device) {
    logger.warn({ deviceId, userId: ctx.userId, opCount: ops.length }, 'sync.device-mismatch');
    throw badRequest('DEVICE_MISMATCH', 'Device not owned by user');
  }

  const opIds = ops.map((o) => o.opId);
  const seqsIn = ops.map((o) => o.seq);
  const existingByOp = opIds.length
    ? await db.select({ opId: syncLedger.opId, seq: syncLedger.seq }).from(syncLedger).where(and(eq(syncLedger.deviceId, deviceId), inArray(syncLedger.opId, opIds)))
    : [];
  const existingBySeq = seqsIn.length
    ? await db.select({ opId: syncLedger.opId, seq: syncLedger.seq }).from(syncLedger).where(and(eq(syncLedger.deviceId, deviceId), inArray(syncLedger.seq, seqsIn)))
    : [];
  const seenOp = new Set(existingByOp.map((r) => r.opId));
  const seqToOp = new Map(existingBySeq.map((r) => [r.seq, r.opId] as const));

  const toInsert = ops.filter((o) => {
    if (seenOp.has(o.opId)) return false;
    const claimedOp = seqToOp.get(o.seq);
    if (claimedOp !== undefined && claimedOp !== o.opId) return false;
    return true;
  });
  const deduped = ops
    .filter((o) => !toInsert.includes(o))
    .map((o) => ({
      opId: o.opId,
      seq: o.seq,
      reason: seenOp.has(o.opId) ? ('DUPLICATE_OP_ID' as const) : ('SEQ_CONFLICT' as const),
    }));
  if (deduped.length > 0) {
    logger.info({ deviceId, userId: ctx.userId, deduped }, 'sync.op-deduped');
  }
  if (toInsert.length > 0) {
    await db
      .insert(syncLedger)
      .values(
        toInsert.map((o) => ({
          deviceId,
          seq: o.seq,
          opId: o.opId,
          action: o.action,
          entity: o.entity,
          entityId: o.entityId ?? null,
          payload: o.payload as object,
          status: 'PENDING',
        })),
      )
      .onConflictDoNothing();
  }

  const pending = await db
    .select()
    .from(syncLedger)
    .where(and(eq(syncLedger.deviceId, deviceId), eq(syncLedger.status, 'PENDING')))
    .orderBy(syncLedger.seq);

  const skewMs = getConfig().syncSkewMs;
  const operatorId = undefined;
  const results: Array<{ seq: number; opId: string; status: string }> = [];
  logger.info(
    { deviceId, userId: ctx.userId, receivedCount: ops.length, pendingCount: pending.length, insertedCount: toInsert.length },
    'sync.push-started',
  );
  for (const row of pending) {
    let outcome: { status: string; liveEvent?: ShipmentStatusEvent };
    try {
      outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${deviceId}::text))`);
      await tx.select().from(devices).where(eq(devices.id, deviceId)).for('update');
      const [locked] = await tx
        .select()
        .from(syncLedger)
        .where(and(eq(syncLedger.id, row.id), eq(syncLedger.status, 'PENDING')))
        .for('update');
      if (!locked) {
        logger.info({ deviceId, userId: ctx.userId, opId: row.opId, seq: row.seq }, 'sync.op-skipped');
        return { status: 'SKIPPED' };
      }

      if (locked.entity === 'shipment' && locked.entityId) {
        const payload = locked.payload as Record<string, unknown> | null;

        if (payload && locked.action === 'shipment.transition' && typeof payload.toStatus === 'string') {
          const toStatus = payload.toStatus as string;
          const occurredAtRaw = payload.occurredAt as string | undefined;
          let occurredAt = new Date();
          if (occurredAtRaw) {
            const parsed = new Date(occurredAtRaw);
            if (Number.isNaN(parsed.getTime()) || Math.abs(Date.now() - parsed.getTime()) > skewMs) {
              logger.warn(
                { code: 'BAD_OCCURRED_AT', deviceId, userId: ctx.userId, opId: locked.opId, seq: locked.seq, action: locked.action, entityId: locked.entityId },
                'sync.op-rejected',
              );
              return reject(tx, row.id, 'BAD_OCCURRED_AT');
            }
            const last = await tx
              .select({ occurredAt: shipmentEvents.occurredAt })
              .from(shipmentEvents)
              .where(eq(shipmentEvents.shipmentId, locked.entityId))
              .orderBy(sql`${shipmentEvents.occurredAt} desc`)
              .limit(1);
            if (last[0] && parsed.getTime() < last[0].occurredAt.getTime()) {
              logger.warn(
                { code: 'STALE_OCCURRED_AT', deviceId, userId: ctx.userId, opId: locked.opId, seq: locked.seq, action: locked.action, entityId: locked.entityId },
                'sync.op-rejected',
              );
              return reject(tx, row.id, 'STALE_OCCURRED_AT');
            }
            occurredAt = parsed;
          }

          const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, locked.entityId)).for('update');
          if (!shipment) {
            logger.warn(
              { code: 'NOT_FOUND', deviceId, userId: ctx.userId, opId: locked.opId, seq: locked.seq, action: locked.action, entityId: locked.entityId },
              'sync.op-rejected',
            );
            return reject(tx, row.id, 'NOT_FOUND');
          }
          if (!canTransition(shipment.status as ShipmentStatus, toStatus as ShipmentStatus)) {
            logger.warn(
              { code: 'INVALID_TRANSITION', source: 'PRECHECK', deviceId, userId: ctx.userId, opId: locked.opId, seq: locked.seq, action: locked.action, entityId: locked.entityId, toStatus },
              'sync.op-rejected',
            );
            return reject(tx, row.id, 'INVALID_TRANSITION');
          }

          const [existingEvent] = await tx
            .select({ id: shipmentEvents.id })
            .from(shipmentEvents)
            .where(and(eq(shipmentEvents.deviceId, deviceId), eq(shipmentEvents.opId, locked.opId)))
            .limit(1);
          if (existingEvent) {
            await tx.update(syncLedger).set({ status: 'APPLIED' }).where(eq(syncLedger.id, row.id));
            logger.info({ deviceId, userId: ctx.userId, opId: locked.opId, seq: locked.seq, entityId: locked.entityId }, 'sync.op-replayed-idempotent');
            return { status: 'APPLIED' };
          }

          const outcome = await applyTransitionTx(tx as TxHandle, ctx, locked.entityId, toStatus as ShipmentStatus, {
            locationLabel: payload.locationLabel as string | undefined,
            metadata: payload.metadata as Record<string, unknown> | undefined,
            occurredAt,
            deviceId,
            opId: locked.opId,
            operatorId,
          });
          if (outcome.kind === 'rejected') {
            logger.warn(
              { code: 'INVALID_TRANSITION', source: 'APPLY', deviceId, userId: ctx.userId, opId: locked.opId, seq: locked.seq, action: locked.action, entityId: locked.entityId, toStatus },
              'sync.op-rejected',
            );
            return reject(tx, row.id, 'INVALID_TRANSITION');
          }
          if (outcome.kind === 'missing' || outcome.kind === 'not_visible') {
            logger.warn(
              { code: 'NOT_FOUND', source: 'APPLY', deviceId, userId: ctx.userId, opId: locked.opId, seq: locked.seq, action: locked.action, entityId: locked.entityId },
              'sync.op-rejected',
            );
            return reject(tx, row.id, 'NOT_FOUND');
          }
          await tx.update(syncLedger).set({ status: 'APPLIED' }).where(eq(syncLedger.id, row.id));
          logger.info(
            { deviceId, userId: ctx.userId, opId: locked.opId, seq: locked.seq, action: locked.action, entityId: locked.entityId, toStatus },
            'sync.op-applied',
          );
          if (outcome.kind !== 'applied') {
            // Concurrent apply won the race: no state change, so no broadcast.
            return { status: 'APPLIED' };
          }
          return { status: 'APPLIED', liveEvent: outcome.liveEvent };
        }

        const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, locked.entityId)).for('update');
        let isLocked = !!shipment?.fieldLock;
        if (!isLocked) {
          const [active] = await tx
            .select({ id: runSheetEntries.id })
            .from(runSheetEntries)
            .innerJoin(runs, eq(runs.id, runSheetEntries.runId))
            .where(and(eq(runSheetEntries.shipmentId, locked.entityId), eq(runs.status, 'ACTIVE')))
            .limit(1);
          if (active) isLocked = true;
        }
        if (isLocked) {
          const touchesLocked = payload ? LOCKED_FIELDS.some((f) => f in payload) : false;
          if (touchesLocked) {
            logger.warn(
              { code: 'SHIPMENT_LOCKED', deviceId, userId: ctx.userId, opId: locked.opId, seq: locked.seq, action: locked.action, entityId: locked.entityId },
              'sync.op-rejected',
            );
            return reject(tx, row.id, 'SHIPMENT_LOCKED');
          }
        }
      }

      await tx.update(syncLedger).set({ status: 'APPLIED' }).where(eq(syncLedger.id, row.id));
      logger.info(
        { deviceId, userId: ctx.userId, opId: locked.opId, seq: locked.seq, action: locked.action, entityId: locked.entityId },
        'sync.op-applied',
      );
      return { status: 'APPLIED' };
      });
    } catch (err) {
      logger.error({ err, deviceId, userId: ctx.userId, opId: row.opId, seq: row.seq, entityId: row.entityId }, 'sync.op-failed');
      throw err;
    }
    if (outcome.status === 'APPLIED' && outcome.liveEvent) {
      syncEmitter.emit('shipment:status', outcome.liveEvent);
    }
    results.push({ seq: row.seq, opId: row.opId, status: outcome.status });
  }

  await db.update(devices).set({ lastSyncedAt: new Date() }).where(eq(devices.id, deviceId));
  await writeAudit(db, ctx, { action: 'sync.push', entityType: 'device', entityId: deviceId, payload: { count: ops.length } });
  const appliedCount = results.filter((r) => r.status === 'APPLIED').length;
  const skippedCount = results.filter((r) => r.status === 'SKIPPED').length;
  const rejected = results.filter((r) => r.status.startsWith('REJECTED:'));
  const rejectedCodes: Record<string, number> = {};
  for (const r of rejected) rejectedCodes[r.status] = (rejectedCodes[r.status] ?? 0) + 1;
  logger.info(
    {
      deviceId,
      userId: ctx.userId,
      receivedCount: ops.length,
      appliedCount,
      rejectedCount: rejected.length,
      rejectedCodes,
      dedupedCount: deduped.length,
      skippedCount,
    },
    'sync.push-completed',
  );
  return results;
}

export async function getPending(db: Db, ctx: AuthContext, deviceId: string, sinceSeq: number, limit = 50) {
  const [device] = await db.select().from(devices).where(and(eq(devices.id, deviceId), eq(devices.userId, ctx.userId)));
  if (!device) {
    logger.warn({ deviceId, userId: ctx.userId, sinceSeq }, 'sync.device-mismatch');
    throw badRequest('DEVICE_MISMATCH', 'Device not owned');
  }
  const rows = await db
    .select()
    .from(syncLedger)
    .where(and(eq(syncLedger.deviceId, deviceId), sql`${syncLedger.seq} > ${sinceSeq}`))
    .orderBy(syncLedger.seq)
    .limit(limit);
  return rows;
}

export async function getStaticRefs(db: Db) {
  const { hubs, zones, pricingRules, deliveryOptions } = await import('@logistics/db');
  const [hubRows, zoneRows, pricingRows, deliveryRows] = await Promise.all([
    db.select().from(hubs),
    db.select().from(zones),
    db.select().from(pricingRules),
    db.select().from(deliveryOptions),
  ]);
  const [versionRow] = await db.select({ max: sql<string>`max(${shipmentEvents.occurredAt})` }).from(shipmentEvents);
  return { hubs: hubRows, zones: zoneRows, pricingRules: pricingRows, deliveryOptions: deliveryRows, version: versionRow?.max ?? null };
}
