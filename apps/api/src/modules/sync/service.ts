import { and, eq, inArray, sql } from 'drizzle-orm';

import { devices, runSheetEntries, runs, shipments, syncLedger } from '@logistics/db';

import { writeAudit } from '../../auth/audit.js';
import type { AuthContext } from '../../auth/middleware.js';
import type { Db } from '../../db.js';
import { badRequest } from '../../errors.js';

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
  }

  const pending = await db
    .select()
    .from(syncLedger)
    .where(and(eq(syncLedger.deviceId, deviceId), eq(syncLedger.status, 'PENDING')))
    .orderBy(syncLedger.seq);

  const results: Array<{ seq: number; opId: string; status: string }> = [];
  for (const row of pending) {
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(syncLedger)
        .where(and(eq(syncLedger.id, row.id), eq(syncLedger.status, 'PENDING')))
        .for('update');
      if (!locked) return { status: 'SKIPPED' };

      if (locked.entity === 'shipment' && locked.entityId) {
        const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, locked.entityId)).for('update');
        // also check active run membership if fieldLock is desynced
        let isLocked = !!shipment?.fieldLock;
        if (!isLocked && locked.entityId) {
          const [active] = await tx
            .select({ id: runSheetEntries.id })
            .from(runSheetEntries)
            .innerJoin(runs, eq(runs.id, runSheetEntries.runId))
            .where(and(eq(runSheetEntries.shipmentId, locked.entityId), sql`${runs.status} IN ('PLANNED','ACTIVE')`))
            .limit(1);
          if (active) isLocked = true;
        }
        if (isLocked) {
          const payload = locked.payload as Record<string, unknown> | null;
          const lockedFields = ['destinationZoneId', 'recipientName', 'recipientEmail', 'recipientPhone', 'deliveryOptionId', 'pickupLocationId'];
          const touchesLocked = payload ? lockedFields.some((f) => f in payload) : false;
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

export async function getPending(db: Db, ctx: AuthContext, deviceId: string, sinceSeq: number) {
  const [device] = await db.select().from(devices).where(and(eq(devices.id, deviceId), eq(devices.userId, ctx.userId)));
  if (!device) throw badRequest('DEVICE_MISMATCH', 'Device not owned');
  return db.select().from(syncLedger).where(and(eq(syncLedger.deviceId, deviceId), sql`${syncLedger.seq} > ${sinceSeq}`)).orderBy(syncLedger.seq);
}

export async function getStaticRefs(db: Db) {
  const { hubs, zones } = await import('@logistics/db');
  const [hubRows, zoneRows] = await Promise.all([db.select().from(hubs), db.select().from(zones)]);
  return { hubs: hubRows, zones: zoneRows };
}
