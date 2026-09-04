import { and, eq } from 'drizzle-orm';

import { runs, runSheetEntries, shipments, shipmentEvents } from '@logistics/db';

import { writeAudit } from '../auth/audit.js';
import type { AuthContext } from '../auth/middleware.js';
import { syncEmitter } from '../sync/events.js';
import type { Db } from '../../shared/db.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

import { canTransition } from './transitions.js';
import type { ShipmentStatus } from './transitions.js';

const STAFF_ROLES: ReadonlySet<string> = new Set(['ADMIN', 'DISPATCHER']);

export interface TransitionInput {
  locationLabel?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface TransitionResult {
  shipment: typeof shipments.$inferSelect;
  event: typeof shipmentEvents.$inferSelect | null;
}

type Outcome =
  | { kind: 'missing' }
  | { kind: 'noop'; shipment: typeof shipments.$inferSelect }
  | { kind: 'rejected'; from: ShipmentStatus }
  | {
      kind: 'applied';
      from: ShipmentStatus;
      shipment: typeof shipments.$inferSelect;
      event: typeof shipmentEvents.$inferSelect;
    };

function buildMetadata(input: TransitionInput): Record<string, unknown> | null {
  const meta: Record<string, unknown> = { ...(input.metadata ?? {}) };
  if (input.reason) meta.reason = input.reason;
  return Object.keys(meta).length > 0 ? meta : null;
}

export type TxHandle = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function applyTransitionTx(
  tx: TxHandle,
  ctx: AuthContext,
  shipmentId: string,
  to: ShipmentStatus,
  input: TransitionInput & { occurredAt?: Date; deviceId?: string; opId?: string; operatorId?: string },
): Promise<Outcome> {
  const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for('update');
  if (!shipment) return { kind: 'missing' };
  if (shipment.status === to) return { kind: 'noop', shipment };
  if (!canTransition(shipment.status, to)) {
    logger.warn({ shipmentId, from: shipment.status, to, actorUserId: ctx.userId }, 'shipments.transition-rejected');
    return { kind: 'rejected', from: shipment.status };
  }
  const occurredAt = input.occurredAt ?? new Date();
  const [updated] = await tx.update(shipments).set({ status: to, updatedAt: occurredAt }).where(eq(shipments.id, shipmentId)).returning();
  const [event] = await tx
    .insert(shipmentEvents)
    .values({
      shipmentId,
      fromStatus: shipment.status,
      toStatus: to,
      actorUserId: ctx.userId,
      locationLabel: input.locationLabel ?? null,
      occurredAt,
      metadata: buildMetadata(input),
      deviceId: input.deviceId ?? null,
      opId: input.opId ?? null,
      operatorId: input.operatorId ?? null,
    })
    .returning();
  // Live-tracking hint for WS subscribers. Emitted pre-commit alongside the
  // applied outcome; subscribers treat it as a hint and pull authoritative state.
  const activeRun = await tx
    .select({ runId: runSheetEntries.runId })
    .from(runSheetEntries)
    .innerJoin(runs, eq(runs.id, runSheetEntries.runId))
    .where(and(eq(runSheetEntries.shipmentId, shipmentId), eq(runs.status, 'ACTIVE')))
    .limit(1);
  syncEmitter.emit('shipment:status', {
    shipmentId,
    runId: activeRun[0]?.runId ?? null,
    from: shipment.status,
    to,
    actorUserId: ctx.userId,
    locationLabel: input.locationLabel,
    occurredAt,
  });
  return { kind: 'applied', from: shipment.status, shipment: updated!, event: event! };
}

/** same state is an idempotent no-op, invalid attempts are audited then rejected */
export async function transition(
  db: Db,
  ctx: AuthContext,
  shipmentId: string,
  to: ShipmentStatus,
  input: TransitionInput = {},
): Promise<TransitionResult> {
  const occurredAt = new Date();
  const metadata = buildMetadata(input);

  const outcome = await db.transaction(async (tx): Promise<Outcome> => {
    const [shipment] = await tx
      .select()
      .from(shipments)
      .where(eq(shipments.id, shipmentId))
      .for('update');

    if (!shipment) return { kind: 'missing' };

    if (shipment.status === to) return { kind: 'noop', shipment };

    if (!canTransition(shipment.status, to)) {
      return { kind: 'rejected', from: shipment.status };
    }

    const [updated] = await tx
      .update(shipments)
      .set({ status: to, updatedAt: occurredAt })
      .where(eq(shipments.id, shipmentId))
      .returning();

    const [event] = await tx
      .insert(shipmentEvents)
      .values({
        shipmentId,
        fromStatus: shipment.status,
        toStatus: to,
        actorUserId: ctx.userId,
        locationLabel: input.locationLabel ?? null,
        occurredAt,
        metadata,
      })
      .returning();

    return {
      kind: 'applied',
      from: shipment.status,
      shipment: updated!,
      event: event!,
    };
  });

  switch (outcome.kind) {
    case 'missing':
      throw notFound('NOT_FOUND', 'Shipment not found');
    case 'rejected': {
      logger.warn(
        { shipmentId, from: outcome.from, to, actorUserId: ctx.userId, roleName: ctx.roleName },
        'shipments.transition-rejected',
      );
      await writeAudit(db, ctx, {
        action: 'shipment.transition.rejected',
        entityType: 'shipment',
        entityId: shipmentId,
        payload: { from: outcome.from, to },
      });
      throw conflict(
        'INVALID_TRANSITION',
        `Cannot transition shipment from ${outcome.from} to ${to}`,
      );
    }
    case 'applied': {
      logger.info(
        { shipmentId, from: outcome.from, to, actorUserId: ctx.userId, roleName: ctx.roleName, eventId: outcome.event.id },
        'shipments.transition-applied',
      );
      await writeAudit(db, ctx, {
        action: 'shipment.transition',
        entityType: 'shipment',
        entityId: shipmentId,
        payload: { from: outcome.from, to },
      });
      const activeRun = await db
        .select({ runId: runSheetEntries.runId })
        .from(runSheetEntries)
        .innerJoin(runs, eq(runs.id, runSheetEntries.runId))
        .where(and(eq(runSheetEntries.shipmentId, shipmentId), eq(runs.status, 'ACTIVE')))
        .limit(1);
      syncEmitter.emit('shipment:status', {
        shipmentId,
        runId: activeRun[0]?.runId ?? null,
        from: outcome.from,
        to,
        actorUserId: ctx.userId,
        locationLabel: input.locationLabel,
        occurredAt,
      });
      return { shipment: outcome.shipment, event: outcome.event };
    }
    case 'noop': {
      logger.info({ shipmentId, to, actorUserId: ctx.userId }, 'shipments.transition-noop');
      return { shipment: outcome.shipment, event: null };
    }
  }
}

export async function cancelShipment(
  db: Db,
  ctx: AuthContext,
  shipmentId: string,
  input: TransitionInput = {},
): Promise<TransitionResult> {
  if (!STAFF_ROLES.has(ctx.roleName)) {
    const [owned] = await db
      .select({ id: shipments.id })
      .from(shipments)
      .where(and(eq(shipments.id, shipmentId), eq(shipments.senderUserId, ctx.userId)));
    if (!owned) {
      logger.warn({ shipmentId, actorUserId: ctx.userId, roleName: ctx.roleName }, 'shipments.cancel-denied');
      throw forbidden('NOT_SHIPMENT_OWNER', 'You can only cancel your own shipments');
    }
  }
  return transition(db, ctx, shipmentId, 'CANCELLED', input);
}

export async function patchShipment(
  db: Db,
  ctx: AuthContext,
  shipmentId: string,
  input: {
    specialInstructions?: string | null;
    category?: string | null;
    destinationZoneId?: string;
    recipientName?: string;
    recipientEmail?: string | null;
    recipientPhone?: string | null;
    deliveryOptionId?: string;
    pickupLocationId?: string;
  },
) {
  return db.transaction(async (tx) => {
    const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for('update');
    if (!shipment) throw notFound('NOT_FOUND', 'Shipment not found');
    const isAdmin = ctx.roleName === 'ADMIN';
    const isStaff = STAFF_ROLES.has(ctx.roleName);
    const isOwner = shipment.senderUserId === ctx.userId;
    if (!isStaff && !isOwner) {
      logger.warn({ shipmentId, actorUserId: ctx.userId, roleName: ctx.roleName }, 'shipments.patch-denied');
      throw forbidden('NOT_SHIPMENT_OWNER', 'Not authorized for this shipment');
    }
    const lockedFields: (keyof typeof input)[] = [
      'destinationZoneId',
      'recipientName',
      'recipientEmail',
      'recipientPhone',
      'deliveryOptionId',
      'pickupLocationId',
    ];
    if (shipment.fieldLock && !isAdmin) {
      for (const f of lockedFields) {
        if (input[f] !== undefined) {
          logger.warn({ shipmentId, actorUserId: ctx.userId, roleName: ctx.roleName, lockedField: f }, 'shipments.field-lock-violation');
          throw conflict('SHIPMENT_LOCKED', `Field ${f} locked while on active run`);
        }
      }
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.specialInstructions !== undefined) patch.specialInstructions = input.specialInstructions;
    if (input.category !== undefined) patch.category = input.category;
    if (isAdmin || !shipment.fieldLock) {
      if (input.destinationZoneId !== undefined) patch.destinationZoneId = input.destinationZoneId;
      if (input.recipientName !== undefined) patch.recipientName = input.recipientName;
      if (input.recipientEmail !== undefined) patch.recipientEmail = input.recipientEmail;
      if (input.recipientPhone !== undefined) patch.recipientPhone = input.recipientPhone;
      if (input.deliveryOptionId !== undefined) patch.deliveryOptionId = input.deliveryOptionId;
      if (input.pickupLocationId !== undefined) patch.pickupLocationId = input.pickupLocationId;
    }
    const [updated] = await tx.update(shipments).set(patch).where(eq(shipments.id, shipmentId)).returning();
    const patchedFields = Object.keys(patch).filter((k) => k !== 'updatedAt');
    logger.info({ shipmentId, actorUserId: ctx.userId, roleName: ctx.roleName, patchedFields }, 'shipments.patched');
    await writeAudit(tx as unknown as Db, ctx, { action: 'shipment.patch', entityType: 'shipment', entityId: shipmentId, payload: input as Record<string, unknown> });
    return updated!;
  });
}

/** Timeline read: staff see everything; everyone else only their own shipments. */
export async function getShipmentWithEvents(db: Db, ctx: AuthContext, shipmentId: string) {
  const shipment = await db.query.shipments.findFirst({
    where: (t, { eq: eql }) => eql(t.id, shipmentId),
  });
  if (!shipment) throw notFound('NOT_FOUND', 'Shipment not found');

  if (!STAFF_ROLES.has(ctx.roleName)) {
    const email = ctx.email.toLowerCase();
    const visible =
      shipment.senderUserId === ctx.userId ||
      shipment.senderEmail?.toLowerCase() === email ||
      shipment.recipientEmail?.toLowerCase() === email;
    // 404 rather than 403 so strangers cannot probe ids.
    if (!visible) {
      logger.warn({ shipmentId, actorUserId: ctx.userId, roleName: ctx.roleName }, 'shipments.timeline-probe');
      throw notFound('NOT_FOUND', 'Shipment not found');
    }
  }

  const events = await db.query.shipmentEvents.findMany({
    where: (t, { eq: eql }) => eql(t.shipmentId, shipmentId),
    orderBy: (t, { asc }) => [asc(t.occurredAt)],
  });

  return { shipment, events };
}
