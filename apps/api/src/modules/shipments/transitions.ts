import { z } from 'zod';

import { shipmentStatusEnum } from '@logistics/db';

export type ShipmentStatus = (typeof shipmentStatusEnum.enumValues)[number];

export const SHIPMENT_STATUSES = shipmentStatusEnum.enumValues;

export const ShipmentStatusSchema = z.enum(SHIPMENT_STATUSES);

export const TERMINAL_STATUSES: readonly ShipmentStatus[] = [
  'DELIVERED',
  'RETURNED',
  'CANCELLED',
];

// source of truth, every shipments.status write goes through transition()
export const TRANSITIONS: Readonly<Record<ShipmentStatus, readonly ShipmentStatus[]>> = {
  DRAFT: ['BOOKED', 'CANCELLED'],
  BOOKED: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: ['IN_TRANSIT'],
  IN_TRANSIT: ['OUT_FOR_DELIVERY', 'RETURNING'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'FAILED_ATTEMPT'],
  FAILED_ATTEMPT: ['OUT_FOR_DELIVERY', 'RETURNING'],
  RETURNING: ['RETURNED'],
  DELIVERED: [],
  RETURNED: [],
  CANCELLED: [],
};

export function isTerminal(status: ShipmentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTransitionTarget(value: unknown): value is ShipmentStatus {
  return (
    typeof value === 'string' &&
    (shipmentStatusEnum.enumValues as readonly string[]).includes(value)
  );
}

/**
 * The state machine, generated from TRANSITIONS rather than retyped, so the
 * published contract cannot drift from the code that enforces it. A client reads
 * this to decide which actions to offer instead of hardcoding its own copy of the
 * matrix and letting it rot.
 */
export const TransitionMatrix = z
  .object(
    Object.fromEntries(
      SHIPMENT_STATUSES.map((status) => [
        status,
        z.array(ShipmentStatusSchema).describe(`Legal targets from ${status}`),
      ]),
    ) as Record<ShipmentStatus, z.ZodArray<typeof ShipmentStatusSchema>>,
  )
  .describe('Shipment state machine: legal target statuses keyed by current status');

export const TransitionMatrixResponse = z
  .object({
    transitions: TransitionMatrix,
    terminalStatuses: z.array(ShipmentStatusSchema),
  })
  .openapi('ShipmentTransitionMatrixResponse');

export function transitionMatrix(): z.infer<typeof TransitionMatrixResponse> {
  const transitions = Object.fromEntries(
    SHIPMENT_STATUSES.map((status) => [status, [...TRANSITIONS[status]]]),
  ) as Record<ShipmentStatus, ShipmentStatus[]>;
  return { transitions, terminalStatuses: [...TERMINAL_STATUSES] };
}
