import { shipmentStatusEnum } from '@logistics/db';

export type ShipmentStatus = (typeof shipmentStatusEnum.enumValues)[number];

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
