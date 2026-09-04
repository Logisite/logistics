import { createServer } from 'node:http';

import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { WebSocketServer } from 'ws';

import * as schema from '@logistics/db';

import { createApp } from './app.js';
import { ResendMailer, ensureOwner, seedAuthData } from './modules/auth/index.js';
import { setupWs } from './modules/sync/index.js';
import { logger } from './shared/logger.js';

const isProd = (process.env.NODE_ENV ?? 'development') === 'production';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  if (isProd) throw new Error('DATABASE_URL must be set when NODE_ENV=production');
  logger.warn('DATABASE_URL unset, falling back to localhost postgres');
}
const client = postgres(databaseUrl ?? 'postgres://localhost:5432/logistics');
const db = drizzlePostgres(client, { schema });

await seedAuthData(db);
await ensureOwner(db);

const app = createApp({ db, mailer: new ResendMailer() });
const port = Number(process.env.PORT ?? 3000);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
setupWs(wss, db);
server.listen(port, () => {
  logger.info({ port }, 'api listening');
});