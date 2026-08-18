import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '@logistics/db';

import { createApp } from './app.js';
import { ResendMailer } from './auth/emails.js';
import { ensureOwner, seedAuthData } from './auth/seed.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://localhost:5432/logistics';
const client = postgres(databaseUrl);
const db = drizzlePostgres(client, { schema });

await seedAuthData(db);
await ensureOwner(db);

const app = createApp({ db, mailer: new ResendMailer() });
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`api listening on :${port}`);
});