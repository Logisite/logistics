export interface AppConfig {
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessTtl: string;
  jwtRefreshTtl: string;
  appUrl: string;
  bootstrapOwnerEmail?: string;
  bootstrapOwnerPassword?: string;
}

export function getConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const jwtAccessSecret = process.env.JWT_ACCESS_SECRET;
  const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;

  if (nodeEnv === 'production' && (!jwtAccessSecret || !jwtRefreshSecret)) {
    throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set when NODE_ENV=production');
  }

  return {
    jwtAccessSecret: jwtAccessSecret ?? 'dev-access-secret',
    jwtRefreshSecret: jwtRefreshSecret ?? 'dev-refresh-secret',
    jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    jwtRefreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
    appUrl: process.env.APP_URL ?? 'http://localhost:3000',
    bootstrapOwnerEmail: process.env.BOOTSTRAP_OWNER_EMAIL,
    bootstrapOwnerPassword: process.env.BOOTSTRAP_OWNER_PASSWORD,
  };
}