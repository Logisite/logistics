export const ROLE_NAMES = [
  'ADMIN',
  'DISPATCHER',
  'BRANCH_OPERATOR',
  'DRIVER',
  'MERCHANT',
  'CUSTOMER',
] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

export const PERMISSIONS = {
  AUTH_INVITE: 'auth:invite',
  AUTH_MANAGE_BUNDLES: 'auth:manage-bundles',
  AUTH_REVOKE_ANY_SESSION: 'auth:revoke-any-session',
  AUDIT_READ: 'audit:read',
  RUNS_MANAGE: 'runs:manage',
  SYNC_PUSH: 'sync:push',
  SHIPMENTS_MANAGE: 'shipments:manage',
  SHIPMENT_TRANSITION: 'shipments:transition',
  PROFILE_MANAGE: 'profile:manage',
  LOCATIONS_MANAGE: 'locations:manage',
  PRICING_MANAGE: 'pricing:manage',
  QUOTE_CREATE: 'quote:create',
  BOOKING_CREATE: 'booking:create',
  COD_RECORD: 'cod:record',
  COD_MANAGE: 'cod:manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ROLE_PERMISSIONS: Record<RoleName, readonly Permission[]> = {
  ADMIN: [
    PERMISSIONS.AUTH_INVITE,
    PERMISSIONS.AUTH_MANAGE_BUNDLES,
    PERMISSIONS.AUTH_REVOKE_ANY_SESSION,
    PERMISSIONS.AUDIT_READ,
    PERMISSIONS.RUNS_MANAGE,
    PERMISSIONS.SYNC_PUSH,
    PERMISSIONS.SHIPMENTS_MANAGE,
    PERMISSIONS.SHIPMENT_TRANSITION,
    PERMISSIONS.PROFILE_MANAGE,
    PERMISSIONS.LOCATIONS_MANAGE,
    PERMISSIONS.PRICING_MANAGE,
    PERMISSIONS.QUOTE_CREATE,
    PERMISSIONS.BOOKING_CREATE,
    PERMISSIONS.COD_RECORD,
    PERMISSIONS.COD_MANAGE,
  ],
  DISPATCHER: [PERMISSIONS.AUDIT_READ, PERMISSIONS.RUNS_MANAGE, PERMISSIONS.SHIPMENT_TRANSITION],
  BRANCH_OPERATOR: [PERMISSIONS.RUNS_MANAGE, PERMISSIONS.COD_RECORD],
  DRIVER: [PERMISSIONS.SYNC_PUSH, PERMISSIONS.RUNS_MANAGE, PERMISSIONS.SHIPMENT_TRANSITION],
  MERCHANT: [
    PERMISSIONS.SHIPMENTS_MANAGE,
    PERMISSIONS.QUOTE_CREATE,
    PERMISSIONS.BOOKING_CREATE,
  ],
  CUSTOMER: [PERMISSIONS.PROFILE_MANAGE, PERMISSIONS.QUOTE_CREATE, PERMISSIONS.BOOKING_CREATE],
};

export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  ADMIN: 'Full control of the platform, including location and pricing management.',
  DISPATCHER: 'Plans and manages runs; moves shipments through the delivery state machine.',
  BRANCH_OPERATOR: 'Operates a branch and its runs.',
  DRIVER: 'Delivers shipments and syncs mobile updates.',
  MERCHANT: 'Books and manages their own shipments.',
  CUSTOMER: 'Books and tracks their own shipments.',
};

export const ROLE_PRIORITY: readonly RoleName[] = [
  'ADMIN',
  'DISPATCHER',
  'BRANCH_OPERATOR',
  'MERCHANT',
  'DRIVER',
  'CUSTOMER',
];