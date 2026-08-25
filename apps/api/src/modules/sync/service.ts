import { and, eq, gte, inArray, sql } from 'drizzle-orm';

import { devices, runSheetEntries, runs, shipmentEvents, shipments, syncLedger } from '@logistics/db';

import { writeAudit } from '../../auth/audit.js';
import type { AuthContext } from '../../auth/middleware.js';
import type { Db } from '../../db.js';
import { badRequest, conflict } from '../../errors.js';

import { canTransition } from '../shipments/transitions.js';
import type { ShipmentStatus } from '../shipments/transitions.js';

const SKEW_MS = 5 * 60 * 1000;
const LOCKED_FIELDS = ['destinationZoneId', 'recipientName', 'recipientEmail', 'recipientPhone', 'deliveryOptionId', 'pickupLocationId'] as const;

export async function ensureDevice(db: Db, userId: string, deviceId?: string) {
  if (deviceId) {
    const [d] = await db.select().from(devices).where(eq(devices.id, deviceId));
    if (d) return d;
  }
  const [d] = await db.insert(devices).values({ userId, name: 'driver-device' }).returning();
  return d!;
}

export async function pushLedger(
  db: Db,
  ctx: AuthContext,
  deviceId: string,
  ops: Array<{ seq: number; opId: string; action: string; entity: string; entityId?: string; payload?: unknown }>,
) {
  const [device] = await db.select().from(devices).where(and(eq(devices.id, deviceId), eq(devices.userId, ctx.userId)));
  if (!device) throw badRequest('DEVICE_MISMATCH', 'Device not owned by user');

  const opIds = ops.map((o) => o.opId);
  const existing = opIds.length
    ? await db.select({ opId: syncLedger.opId }).from(syncLedger).where(and(eq(syncLedger.deviceId, deviceId), inArray(syncLedger.opId, opIds)))
    : [];
  const seen = new Set(existing.map((r) => r.opId));

  const toInsert = ops.filter((o) => !seen.has(o.opId));
  if (toInsert.length > 0) {
    try {
      await db.insert(syncLedger).values(
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
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('sync_ledger_device_seq_unique') || msg.includes('sync_ledger_device_op_unique')) {
        throw conflict('SEQ_CONFLICT', 'Duplicate seq or opId for device');
      }
      throw err;
    }
  }

  const pending = await db
    .select()
    .from(syncLedger)
    .where(and(eq(syncLedger.deviceId, deviceId), eq(syncLedger.status, 'PENDING')))
    .orderBy(syncLedger.seq);

  const results: Array<{ seq: number; opId: string; status: string }> = [];
  for (const row of pending) {
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${deviceId}::text))`);
      const [locked] = await tx
        .select()
        .from(syncLedger)
        .where(and(eq(syncLedger.id, row.id), eq(syncLedger.status, 'PENDING')))
        .for('update');
      if (!locked) return { status: 'SKIPPED' };

      if (locked.entity === 'shipment' && locked.entityId) {
        const payload = locked.payload as Record<string, unknown> | null;

        if (payload && locked.action === 'shipment.transition' && payload.toStatus) {
          const toStatus = payload.toStatus as string;
          const occurredAtRaw = payload.occurredAt as string | undefined;
          if (occurredAtRaw) {
            const occurredAt = new Date(occurredAtRaw);
            const now = Date.now();
            if (Number.isNaN(occurredAt.getTime()) || Math.abs(now - occurredAt.getTime()) > SKEW_MS) {
              await tx.update(syncLedger).set({ status: 'REJECTED' }).where(eq(syncLedger.id, row.id));
              return { status: 'REJECTED:BAD_OCCURRED_AT' };
            }
            const last = await tx
              .select({ occurredAt: shipmentEvents.occurredAt })
              .from(shipmentEvents)
              .where(eq(shipmentEvents.shipmentId, locked.entityId))
              .orderBy(sql`${shipmentEvents.occurredAt} desc`)
              .limit(1);
            if (last[0] && occurredAt.getTime() < last[0].occurredAt.getTime()) {
              await tx.update(syncLedger).set({ status: 'REJECTED' }).where(eq(syncLedger.id, row.id));
              return { status: 'REJECTED:STALE_OCCURRED_AT' };
            }
          }

          const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, locked.entityId)).for('update');
          if (!shipment) {
            await tx.update(syncLedger).set({ status: 'REJECTED' }).where(eq(syncLedger.id, row.id));
            return { status: 'REJECTED:NOT_FOUND' };
          }
          if (!canTransition(shipment.status as ShipmentStatus, toStatus as ShipmentStatus)) {
            await tx.update(syncLedger).set({ status: 'REJECTED' }).where(eq(syncLedger.id, row.id));
            return { status: 'REJECTED:INVALID_TRANSITION' };
          }
          const [existingEvent] = await tx
            .select({ id: shipmentEvents.id })
            .from(shipmentEvents)
            .where(and(eq(shipmentEvents.deviceId, deviceId), eq(shipmentEvents.opId, locked.opId)))
            .limit(1);
          if (existingEvent) {
            await tx.update(syncLedger).set({ status: 'APPLIED' }).where(eq(syncLedger.id, row.id));
            return { status: 'APPLIED' };
          }
          const occurredAt = payload.occurredAt ? new Date(payload.occurredAt as string) : new Date();
          const [updated] = await tx.update(shipments).set({ status: toStatus as ShipmentStatus, updatedAt: occurredAt }).where(eq(shipments.id, locked.entityId)).returning();
          await tx.insert(shipmentEvents).values({
            shipmentId: locked.entityId,
            fromStatus: shipment.status as ShipmentStatus,
            toStatus: toStatus as ShipmentStatus,
            actorUserId: ctx.userId,
            locationLabel: (payload.locationLabel as string) ?? null,
            occurredAt,
            metadata: payload.metadata as Record<string, unknown> | null,
            deviceId,
            opId: locked.opId,
          });

          await tx.update(syncLedger).set({ status: 'APPLIED' }).where(eq(syncLedger.id, row.id));
          void updated;
          return { status: 'APPLIED' };
        }

        const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, locked.entityId)).for('update');
        let isLocked = !!shipment?.fieldLock;
        if (!isLocked) {
          const [active] = await tx
            .select({ id: runSheetEntries.id })
            .from(runSheetEntries)
            .innerJoin(runs, eq(runs.id, runSheetEntries.runId))
            .where(and(eq(runSheetEntries.shipmentId, locked.entityId), sql`${runs.status} IN ('PLANNED','ACTIVE')`))
            .limit(1);
          if (active) isLocked = true;
        }
        if (isLocked) {
          const touchesLocked = payload ? LOCKED_FIELDS.some((f) => f in payload) : false;
          if (touchesLocked && ctx.roleName !== 'ADMIN') {
            await tx.update(syncLedger).set({ status: 'REJECTED' }).where(eq(syncLedger.id, row.id));
            return { status: 'REJECTED:SHIPMENT_LOCKED' };
          }
        }
      }

      await tx.update(syncLedger).set({ status: 'APPLIED' }).where(eq(syncLedger.id, row.id));
      return { status: 'APPLIED' };
    });
    results.push({ seq: row.seq, opId: row.opId, status: outcome.status });
  }

  await db.update(devices).set({ lastSyncedAt: new Date() }).where(eq(devices.id, deviceId));
  await writeAudit(db, ctx, { action: 'sync.push', entityType: 'device', entityId: deviceId, payload: { count: ops.length } });
  return results;
}

export async function getPending(db: Db, ctx: AuthContext, deviceId: string, sinceSeq: number, limit = 50) {
  const [device] = await db.select().from(devices).where(and(eq(devices.id, deviceId), eq(devices.userId, ctx.userId)));
  if (!device) throw badRequest('DEVICE_MISMATCH', 'Device not owned');
  const rows = await db
    .select()
    .from(syncLedger)
    .where(and(eq(syncLedger.deviceId, deviceId), sql`${syncLedger.seq} > ${sinceSeq}`))
    .orderBy(syncLedger.seq)
    .limit(limit);
  return rows;
}

export async function getStaticRefs(db: Db) {
  const { hubs, zones } = await import('@logistics/db');
  const [hubRows, zoneRows] = await Promise.all([db.select().from(hubs), db.select().from(zones)]);
  const [events] = await db.select({ max: sql<string>`max(${shipmentEvents.occurredAt})` }).from(shipmentEvents);
  return { hubs: hubRows, zones: zoneRows, version: events?.max ?? null };
}

export async function getDeltas(db: Db, ctx: AuthContext, deviceId: string, sinceSeq: number) {
  const pending = await getPending(db, ctx, deviceId, sinceSeq, 100);
  const deltas = await db
    .select()
    .from(shipmentEvents)
    .where(gte(shipmentEvents.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)))
    .orderBy(shipmentEvents.createdAt)
    .limit(50);
  return { pending, deltas };
}
