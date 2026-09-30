import { and, eq, inArray, sql } from 'drizzle-orm';

import { gpsPositions, hubs, runs, runSheetEntries, shipments } from '@logistics/db';

import { writeAudit } from '../auth/audit.js';
import type { AuthContext } from '../auth/middleware.js';
import { syncEmitter } from '../sync/events.js';
import type { Db } from '../../shared/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

import { canTransitionRun } from './transitions.js';
import type { RunStatus } from './transitions.js';

const ELIGIBLE_STATUSES: ReadonlySet<string> = new Set(['BOOKED', 'PICKED_UP']);

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function audit(tx: Tx, ctx: AuthContext, entry: Parameters<typeof writeAudit>[2]) {
  await writeAudit(tx as unknown as Db, ctx, entry);
}

async function assertHubExists(db: Db, hubId: string) {
  const [hub] = await db.select().from(hubs).where(eq(hubs.id, hubId));
  if (!hub) throw notFound('NOT_FOUND', 'Hub not found');
}

async function assertDriverExists(db: Db, driverUserId: string) {
  const { users } = await import('@logistics/db');
  const [u] = await db.select().from(users).where(eq(users.id, driverUserId));
  if (!u) throw notFound('NOT_FOUND', 'Driver not found');
}

export async function createRun(
  db: Db,
  ctx: AuthContext,
  input: { hubId?: string; driverUserId: string; scheduledDate?: string; shipments: Array<{ shipmentId: string; sequence: number }> },
) {
  if (ctx.roleName === 'DRIVER' && input.driverUserId !== ctx.userId) {
    logger.warn({ actorUserId: ctx.userId, actorRole: ctx.roleName, requestedDriverUserId: input.driverUserId, shipmentCount: input.shipments.length, hubId: input.hubId ?? null }, 'operations.run-create-denied');
    throw forbidden('FORBIDDEN', 'Drivers can only create runs for themselves');
  }
  if (input.hubId) {
    try {
      await assertHubExists(db, input.hubId);
    } catch (err) {
      logger.warn({ reason: 'hub-not-found', actorUserId: ctx.userId, actorRole: ctx.roleName, hubId: input.hubId, driverUserId: input.driverUserId, shipmentCount: input.shipments.length }, 'operations.run-create-rejected');
      throw err;
    }
  }
  try {
    await assertDriverExists(db, input.driverUserId);
  } catch (err) {
    logger.warn({ reason: 'driver-not-found', actorUserId: ctx.userId, actorRole: ctx.roleName, requestedDriverUserId: input.driverUserId, hubId: input.hubId ?? null }, 'operations.run-create-rejected');
    throw err;
  }

  const shipmentIds = input.shipments.map((s) => s.shipmentId);
  if (new Set(shipmentIds).size !== shipmentIds.length) {
    logger.warn({ reason: 'duplicate-shipments', actorUserId: ctx.userId, actorRole: ctx.roleName, driverUserId: input.driverUserId, shipmentCount: shipmentIds.length }, 'operations.run-create-rejected');
    throw badRequest('VALIDATION', 'Duplicate shipment ids');
  }

  return db.transaction(async (tx) => {
    const lockedShipments = await tx.select().from(shipments).where(inArray(shipments.id, shipmentIds)).for('update');
    if (lockedShipments.length !== shipmentIds.length) {
      const found = new Set(lockedShipments.map((s) => s.id));
      const missing = shipmentIds.find((id) => !found.has(id));
      logger.warn({ reason: 'shipment-not-found', actorUserId: ctx.userId, actorRole: ctx.roleName, missingShipmentId: missing, requestedCount: shipmentIds.length, foundCount: lockedShipments.length, driverUserId: input.driverUserId }, 'operations.run-create-rejected');
      throw notFound('NOT_FOUND', `Shipment ${missing} not found`);
    }
    for (const s of lockedShipments) {
      if (!ELIGIBLE_STATUSES.has(s.status)) {
        logger.warn({ reason: 'ineligible-status', actorUserId: ctx.userId, actorRole: ctx.roleName, shipmentId: s.id, shipmentStatus: s.status, driverUserId: input.driverUserId, hubId: input.hubId ?? null }, 'operations.run-create-rejected');
        throw conflict('INELIGIBLE_STATUS', `Shipment ${s.id} status ${s.status} not eligible for runs`);
      }
    }

    const blocking = await tx
      .select({ shipmentId: runSheetEntries.shipmentId })
      .from(runSheetEntries)
      .innerJoin(runs, eq(runs.id, runSheetEntries.runId))
      .where(and(inArray(runSheetEntries.shipmentId, shipmentIds), sql`${runs.status} IN ('PLANNED','ACTIVE')`))
      .for('update');
    if (blocking.length > 0) {
      logger.warn({ reason: 'shipment-on-active-run', actorUserId: ctx.userId, actorRole: ctx.roleName, blockingCount: blocking.length, blockingShipmentIds: blocking.map((b) => b.shipmentId), driverUserId: input.driverUserId }, 'operations.run-create-rejected');
      throw conflict('SHIPMENT_ON_ACTIVE_RUN', 'Shipment already on an active run');
    }

    const [run] = await tx
      .insert(runs)
      .values({
        hubId: input.hubId ?? null,
        driverUserId: input.driverUserId,
        status: 'PLANNED',
        scheduledDate: input.scheduledDate ? new Date(input.scheduledDate) : null,
      })
      .returning();

    for (const entry of input.shipments) {
      await tx.insert(runSheetEntries).values({ runId: run!.id, shipmentId: entry.shipmentId, sequence: entry.sequence });
    }

    await audit(tx, ctx, { action: 'run.create', entityType: 'run', entityId: run!.id });
    logger.info({ runId: run!.id, driverUserId: input.driverUserId, hubId: input.hubId ?? null, shipmentCount: shipmentIds.length, actorUserId: ctx.userId, actorRole: ctx.roleName }, 'operations.run-created');
    return run!;
  });
}

async function transitionRun(db: Db, ctx: AuthContext, runId: string, to: RunStatus, clockField: 'startedAt' | 'endedAt') {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update');
    if (!run) {
      logger.warn({ reason: 'run-not-found', runId, attemptedTo: to, actorUserId: ctx.userId, actorRole: ctx.roleName }, 'operations.run-transition-rejected');
      throw notFound('NOT_FOUND', 'Run not found');
    }
    if (ctx.roleName === 'DRIVER' && run.driverUserId !== ctx.userId) {
      logger.warn({ runId, attemptedTo: to, actorUserId: ctx.userId, actorRole: ctx.roleName, ownerDriverUserId: run.driverUserId }, 'operations.run-transition-denied');
      throw forbidden('NOT_RUN_OWNER', 'Drivers can only transition own runs');
    }
    if (!canTransitionRun(run.status as RunStatus, to)) {
      logger.warn({ reason: 'invalid-transition', runId, fromStatus: run.status, toStatus: to, actorUserId: ctx.userId, actorRole: ctx.roleName }, 'operations.run-transition-rejected');
      throw conflict('INVALID_TRANSITION', `Cannot transition run from ${run.status} to ${to}`);
    }
    const patch: Record<string, unknown> = { status: to, [clockField]: new Date() };
    const [updated] = await tx.update(runs).set(patch).where(eq(runs.id, runId)).returning();
    if (to === 'ACTIVE') {
      const entries = await tx.select().from(runSheetEntries).where(eq(runSheetEntries.runId, runId));
      if (entries.length > 0) await tx.update(shipments).set({ fieldLock: true, updatedAt: new Date() }).where(inArray(shipments.id, entries.map((e) => e.shipmentId)));
    } else if (to === 'COMPLETED' || (to === 'CANCELLED' && run.status === 'ACTIVE')) {
      const entries = await tx.select().from(runSheetEntries).where(eq(runSheetEntries.runId, runId));
      if (entries.length > 0) await tx.update(shipments).set({ fieldLock: false, updatedAt: new Date() }).where(inArray(shipments.id, entries.map((e) => e.shipmentId)));
    }
    await audit(tx, ctx, { action: `run.${to.toLowerCase()}`, entityType: 'run', entityId: runId });
    logger.info({ runId, driverUserId: run.driverUserId, fromStatus: run.status, toStatus: to, actorUserId: ctx.userId, actorRole: ctx.roleName }, 'operations.run-transitioned');
    return updated!;
  });
}

export async function startRun(db: Db, ctx: AuthContext, runId: string) {
  return transitionRun(db, ctx, runId, 'ACTIVE', 'startedAt');
}

export async function completeRun(db: Db, ctx: AuthContext, runId: string) {
  return transitionRun(db, ctx, runId, 'COMPLETED', 'endedAt');
}

export async function cancelRun(db: Db, ctx: AuthContext, runId: string) {
  return transitionRun(db, ctx, runId, 'CANCELLED', 'endedAt');
}

export async function pushGps(db: Db, ctx: AuthContext, runId: string, positions: Array<{ latitude: number; longitude: number; recordedAt?: string }>) {
  const count = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${runId}::text))`);
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update');
    if (!run) {
      logger.warn({ reason: 'run-not-found', runId, positionCount: positions.length, actorUserId: ctx.userId, actorRole: ctx.roleName }, 'operations.gps-rejected');
      throw notFound('NOT_FOUND', 'Run not found');
    }
    if (run.status !== 'ACTIVE') {
      logger.warn({ reason: 'run-not-active', runId, runStatus: run.status, positionCount: positions.length, actorUserId: ctx.userId, actorRole: ctx.roleName, ownerDriverUserId: run.driverUserId }, 'operations.gps-rejected');
      throw conflict('RUN_NOT_ACTIVE', 'GPS only while run is active');
    }
    const isOwner = run.driverUserId === ctx.userId;
    const isStaff = ctx.roleName === 'ADMIN' || ctx.roleName === 'DISPATCHER';
    if (!isOwner && !isStaff) {
      logger.warn({ runId, actorUserId: ctx.userId, actorRole: ctx.roleName, ownerDriverUserId: run.driverUserId, positionCount: positions.length }, 'operations.gps-denied');
      throw forbidden('NOT_RUN_OWNER', 'Not authorized for this run');
    }
    const rows = positions.map((p) => ({ runId, driverUserId: ctx.userId, latitude: p.latitude, longitude: p.longitude, recordedAt: p.recordedAt ? new Date(p.recordedAt) : new Date() }));
    await tx.insert(gpsPositions).values(rows);
    logger.info({ runId, driverUserId: run.driverUserId, actorUserId: ctx.userId, positionCount: rows.length }, 'operations.gps-accepted');
    return rows.length;
  });
  for (const p of positions) {
    syncEmitter.emit('gps:position', {
      runId,
      driverUserId: ctx.userId,
      latitude: p.latitude,
      longitude: p.longitude,
      recordedAt: p.recordedAt ? new Date(p.recordedAt) : new Date(),
    });
  }
  return count;
}

export async function getRunSheet(db: Db, ctx: AuthContext, runId: string) {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) {
    logger.warn({ reason: 'run-not-found', runId, actorUserId: ctx.userId, actorRole: ctx.roleName }, 'operations.runsheet-rejected');
    throw notFound('NOT_FOUND', 'Run not found');
  }
  const isOwner = run.driverUserId === ctx.userId;
  const isStaff = ctx.roleName === 'ADMIN' || ctx.roleName === 'DISPATCHER';
  if (!isOwner && !isStaff) {
    logger.warn({ runId, actorUserId: ctx.userId, actorRole: ctx.roleName }, 'operations.runsheet-denied');
    throw forbidden('NOT_RUN_OWNER', 'Not authorized for this run');
  }
  const entries = await db.select().from(runSheetEntries).where(eq(runSheetEntries.runId, runId)).orderBy(runSheetEntries.sequence);
  const shipmentIds = entries.map((e) => e.shipmentId);
  const ships = shipmentIds.length ? await db.select().from(shipments).where(inArray(shipments.id, shipmentIds)) : [];
  const byId = new Map(ships.map((s) => [s.id, s]));
  const ordered = entries.map((e) => ({ entry: e, shipment: byId.get(e.shipmentId) ?? null }));
  return { run, entries: ordered };
}

export async function getMyRuns(db: Db, ctx: AuthContext) {
  return db.select().from(runs).where(eq(runs.driverUserId, ctx.userId)).orderBy(sql`${runs.createdAt} desc`);
}
