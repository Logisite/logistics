import { and, eq } from 'drizzle-orm';

import { shipments, shipmentEvents } from '@logistics/db';

import { writeAudit } from '../../auth/audit.js';
import type { AuthContext } from '../../auth/middleware.js';
import type { Db } from '../../db.js';
import { conflict, forbidden, notFound } from '../../errors.js';

import { canTransition } from './transitions.js';
import type { ShipmentStatus } from './transitions.js';

// Roles allowed to transition/cancel any shipment regardless of ownership.
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

/**
 * The ONLY writer of shipments.status: locks the row, validates against the
 * transition table, then updates status and appends the event in one
 * transaction. Same-state calls are idempotent no-ops (no new event);
 * invalid attempts are audited and rejected with 409.
 */
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
      await writeAudit(db, ctx, {
        action: 'shipment.transition',
        entityType: 'shipment',
        entityId: shipmentId,
        payload: { from: outcome.from, to },
      });
      return { shipment: outcome.shipment, event: outcome.event };
    }
    case 'noop':
      return { shipment: outcome.shipment, event: null };
  }
}

/**
 * Cancel is a transition gated by ownership: staff may cancel anything,
 * senders only their own shipments.
 */
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
      throw forbidden('NOT_SHIPMENT_OWNER', 'You can only cancel your own shipments');
    }
  }
  return transition(db, ctx, shipmentId, 'CANCELLED', input);
}

/** Timeline read: current shipment plus its immutable event trail, oldest first. */
export async function getShipmentWithEvents(db: Db, shipmentId: string) {
  const shipment = await db.query.shipments.findFirst({
    where: (t, { eq: eql }) => eql(t.id, shipmentId),
  });
  if (!shipment) throw notFound('NOT_FOUND', 'Shipment not found');

  const events = await db.query.shipmentEvents.findMany({
    where: (t, { eq: eql }) => eql(t.shipmentId, shipmentId),
    orderBy: (t, { asc }) => [asc(t.occurredAt)],
  });

  return { shipment, events };
}
