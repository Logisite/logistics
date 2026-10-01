export interface AppConfig {
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessTtl: string;
  jwtRefreshTtl: string;
  /** Origin of the frontend. Used for CORS and for links in transactional email. */
  appUrl: string;
  /** Base URL this API is reachable at. Used as the OpenAPI server URL. */
  apiPublicUrl: string;
  /** Explicit CORS origins beyond appUrl, comma separated. Empty means appUrl only. */
  corsAllowedOrigins: readonly string[];
  mailFrom: string;
  resendApiKey: string;
  functionalCurrency: 'USD' | 'EUR' | 'GBP';
  mapTilesUrl: string;
  syncSkewMs: number;
  bootstrapOwnerEmail?: string;
  bootstrapOwnerPassword?: string;
  mapboxAccessToken: string;
  capabilityLinkSecret: string;
  shadowAccountTtlDays: number;
  smsAccountSid?: string;
  smsAuthToken?: string;
  smsFromNumber?: string;
}

const FUNCTIONAL_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;
const MIN_SECRET_LENGTH = 32;

export const isProd = (process.env.NODE_ENV ?? 'development') === 'production';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

export function getConfig(): AppConfig {
  const jwtAccessSecret = process.env.JWT_ACCESS_SECRET;
  const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;
  const appUrl = process.env.APP_URL;
  const apiPublicUrl = process.env.API_PUBLIC_URL;
  const corsRaw = process.env.CORS_ALLOWED_ORIGINS;
  const mailFrom = process.env.MAIL_FROM;
  const resendApiKey = process.env.RESEND_API_KEY;
  const capabilityLinkSecret = process.env.CAPABILITY_LINK_SECRET;
  const mapboxAccessToken = process.env.MAPBOX_ACCESS_TOKEN;

  if (isProd) {
    const missing = [
      !jwtAccessSecret && 'JWT_ACCESS_SECRET',
      !jwtRefreshSecret && 'JWT_REFRESH_SECRET',
      !appUrl && 'APP_URL',
      !mailFrom && 'MAIL_FROM',
      !resendApiKey && 'RESEND_API_KEY',
      !capabilityLinkSecret && 'CAPABILITY_LINK_SECRET',
      !mapboxAccessToken && 'MAPBOX_ACCESS_TOKEN',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`Missing required env vars when NODE_ENV=production: ${missing.join(', ')}`);
    }
    const weak = [
      [jwtAccessSecret, 'JWT_ACCESS_SECRET'],
      [jwtRefreshSecret, 'JWT_REFRESH_SECRET'],
      [capabilityLinkSecret, 'CAPABILITY_LINK_SECRET'],
    ]
      .filter(([value]) => (value as string).length < MIN_SECRET_LENGTH)
      .map(([, name]) => name as string);
    if (weak.length > 0) {
      throw new Error(`These secrets must be at least ${MIN_SECRET_LENGTH} characters: ${weak.join(', ')}`);
    }
  }

  const functionalCurrency = process.env.FUNCTIONAL_CURRENCY;
  if (functionalCurrency && !FUNCTIONAL_CURRENCIES.includes(functionalCurrency as 'USD')) {
    throw new Error(`FUNCTIONAL_CURRENCY must be one of ${FUNCTIONAL_CURRENCIES.join(', ')}`);
  }

  return {
    jwtAccessSecret: jwtAccessSecret ?? 'dev-access-secret',
    jwtRefreshSecret: jwtRefreshSecret ?? 'dev-refresh-secret',
    jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    jwtRefreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
    appUrl: appUrl ?? 'http://localhost:5173',
    apiPublicUrl: apiPublicUrl ?? appUrl ?? 'http://localhost:3000',
    corsAllowedOrigins: corsRaw
      ? corsRaw.split(',').map((o) => o.trim()).filter(Boolean)
      : [],
    mailFrom: mailFrom ?? 'Logistics <no-reply@localhost>',
    resendApiKey: resendApiKey ?? 'dev-resend-key',
    functionalCurrency: (functionalCurrency ?? 'GBP') as 'USD' | 'EUR' | 'GBP',
    mapTilesUrl:
      process.env.MAP_TILES_URL ?? 'https://tiles.openfreemap.org/styles/liberty',
    syncSkewMs: intFromEnv('SYNC_SKEW_MS', 300_000),
    bootstrapOwnerEmail: process.env.BOOTSTRAP_OWNER_EMAIL,
    bootstrapOwnerPassword: process.env.BOOTSTRAP_OWNER_PASSWORD,
    mapboxAccessToken: mapboxAccessToken ?? '',
    capabilityLinkSecret: capabilityLinkSecret ?? '',
    shadowAccountTtlDays: intFromEnv('SHADOW_ACCOUNT_TTL_DAYS', 90),
    smsAccountSid: process.env.SMS_ACCOUNT_SID,
    smsAuthToken: process.env.SMS_AUTH_TOKEN,
    smsFromNumber: process.env.SMS_FROM_NUMBER,
  };
}
