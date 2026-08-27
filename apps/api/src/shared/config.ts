export interface AppConfig {
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessTtl: string;
  jwtRefreshTtl: string;
  appUrl: string;
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

export function getConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isProd = nodeEnv === 'production';

  const jwtAccessSecret = process.env.JWT_ACCESS_SECRET;
  const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;
  const appUrl = process.env.APP_URL;
  const mailFrom = process.env.MAIL_FROM;
  const resendApiKey = process.env.RESEND_API_KEY;
  const capabilityLinkSecret = process.env.CAPABILITY_LINK_SECRET;

  if (isProd) {
    const missing = [
      !jwtAccessSecret && 'JWT_ACCESS_SECRET',
      !jwtRefreshSecret && 'JWT_REFRESH_SECRET',
      !appUrl && 'APP_URL',
      !mailFrom && 'MAIL_FROM',
      !resendApiKey && 'RESEND_API_KEY',
      !capabilityLinkSecret && 'CAPABILITY_LINK_SECRET',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`Missing required env vars when NODE_ENV=production: ${missing.join(', ')}`);
    }
  }

  const functionalCurrency = process.env.FUNCTIONAL_CURRENCY;
  if (functionalCurrency && !['USD', 'EUR', 'GBP'].includes(functionalCurrency)) {
    throw new Error('FUNCTIONAL_CURRENCY must be one of USD, EUR, GBP');
  }

  const syncSkewMs = Number(process.env.SYNC_SKEW_MS ?? 300000);
  return {
    jwtAccessSecret: jwtAccessSecret ?? 'dev-access-secret',
    jwtRefreshSecret: jwtRefreshSecret ?? 'dev-refresh-secret',
    jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    jwtRefreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
    appUrl: appUrl ?? 'http://localhost:3000',
    mailFrom: mailFrom ?? 'Logistics <no-reply@localhost>',
    resendApiKey: resendApiKey ?? 'dev-resend-key',
    functionalCurrency: (functionalCurrency ?? 'GBP') as 'USD' | 'EUR' | 'GBP',
    mapTilesUrl:
      process.env.MAP_TILES_URL ?? 'https://tiles.openfreemap.org/styles/liberty',
    syncSkewMs,
    bootstrapOwnerEmail: process.env.BOOTSTRAP_OWNER_EMAIL,
    bootstrapOwnerPassword: process.env.BOOTSTRAP_OWNER_PASSWORD,
    mapboxAccessToken: process.env.MAPBOX_ACCESS_TOKEN ?? '',
    capabilityLinkSecret: process.env.CAPABILITY_LINK_SECRET ?? '',
    shadowAccountTtlDays: Number(process.env.SHADOW_ACCOUNT_TTL_DAYS ?? 90),
    smsAccountSid: process.env.SMS_ACCOUNT_SID,
    smsAuthToken: process.env.SMS_AUTH_TOKEN,
    smsFromNumber: process.env.SMS_FROM_NUMBER,
  };
}
