import { pgEnum } from 'drizzle-orm/pg-core';

export const currencyEnum = pgEnum('currency', ['USD', 'EUR', 'GBP']);

export const roleEnum = pgEnum('role', [
  'ADMIN',
  'DISPATCHER',
  'BRANCH_OPERATOR',
  'DRIVER',
  'MERCHANT',
  'CUSTOMER',
]);

export const shipmentStatusEnum = pgEnum('shipment_status', [
  'DRAFT',
  'BOOKED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED_ATTEMPT',
  'RETURNING',
  'RETURNED',
  'CANCELLED',
]);

export const sizeClassEnum = pgEnum('size_class', [
  'SMALL',
  'MEDIUM',
  'LARGE',
  'EXTRA_LARGE',
]);

export const weightClassEnum = pgEnum('weight_class', [
  'LIGHT',
  'MEDIUM',
  'HEAVY',
  'EXTRA_HEAVY',
]);

export const deliveryOptionEnum = pgEnum('delivery_option', [
  'STANDARD',
  'EXPRESS',
  'SAME_DAY',
  'SCHEDULED',
  'PICKUP_AT_LOCATION',
  'DROP_OFF_AT_LOCATION',
]);