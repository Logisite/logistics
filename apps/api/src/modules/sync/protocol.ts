import { z } from 'zod';

import { SHIPMENT_STATUSES } from '../shipments/index.js';

// The sync protocol currently implements exactly one entity/action pair. Keeping
// these as literal enums rather than free strings means a client cannot enqueue an
// op the server would silently accept and ignore.
export const SYNC_ENTITIES = ['shipment'] as const;
export const SYNC_ACTIONS = ['shipment.transition'] as const;

export const SYNC_OP_STATUSES = ['PENDING', 'APPLIED', 'SKIPPED', 'REJECTED'] as const;

export const SYNC_REJECTION_CODES = [
  'BAD_OCCURRED_AT',
  'STALE_OCCURRED_AT',
  'NOT_FOUND',
  'INVALID_TRANSITION',
  'SHIPMENT_LOCKED',
] as const;

export type SyncEntity = (typeof SYNC_ENTITIES)[number];
export type SyncAction = (typeof SYNC_ACTIONS)[number];
export type SyncOpStatus = (typeof SYNC_OP_STATUSES)[number];
export type SyncRejectionCode = (typeof SYNC_REJECTION_CODES)[number];

export const SyncRejectionCodeSchema = z.enum(SYNC_REJECTION_CODES);
export const SyncOpStatusSchema = z.enum(SYNC_OP_STATUSES);

const RejectedPrefix = 'REJECTED:';

/**
 * The ledger stores a rejection as the single string `REJECTED:<CODE>`, which a client
 * cannot switch on without string surgery. The wire splits it into a stable status and
 * a separate code so the offline queue can branch on either field.
 */
export function splitOpStatus(stored: string): { status: SyncOpStatus; rejectionCode?: SyncRejectionCode } {
  if (!stored.startsWith(RejectedPrefix)) {
    return { status: stored as SyncOpStatus };
  }
  const rejectionCode = stored.slice(RejectedPrefix.length) as SyncRejectionCode;
  return { status: 'REJECTED', rejectionCode };
}

const ShipmentTransitionPayload = z
  .object({
    toStatus: z.enum(SHIPMENT_STATUSES),
    locationLabel: z.string().max(200).optional(),
    occurredAt: z.string().datetime().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('ShipmentTransitionPayload');

export const ShipmentTransitionPayloadSchema = ShipmentTransitionPayload;

export const SyncOpRequest = z
  .object({
    seq: z.number().int().min(0),
    opId: z.string().uuid(),
    entity: z.enum(SYNC_ENTITIES),
    entityId: z.string().uuid().optional(),
    action: z.enum(SYNC_ACTIONS),
    payload: ShipmentTransitionPayload,
  })
  .openapi('SyncOpRequest');

export const SyncOpResult = z
  .object({
    seq: z.number().int(),
    opId: z.string().uuid(),
    status: SyncOpStatusSchema,
    rejectionCode: SyncRejectionCodeSchema.optional(),
  })
  .openapi('SyncOpResult');