import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '@logistics/db';

import { createApp } from './app.js';
import { ResendMailer } from './auth/emails.js';
import { ensureOwner, seedAuthData } from './auth/seed.js';

const isProd = (process.env.NODE_ENV ?? 'development') === 'production';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  if (isProd) throw new Error('DATABASE_URL must be set when NODE_ENV=production');
  console.warn('DATABASE_URL unset, falling back to localhost postgres');
}
const client = postgres(databaseUrl ?? 'postgres://localhost:5432/logistics');
const db = drizzlePostgres(client, { schema });

await seedAuthData(db);
await ensureOwner(db);

const app = createApp({ db, mailer: new ResendMailer() });
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`api listening on :${port}`);
});