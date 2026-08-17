import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import postgres from 'postgres';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';

import * as schema from '../src/schema/index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const PGDATA_DIR = './test-pgdata';

let db: ReturnType<typeof drizzlePglite>;
let cleanup: () => Promise<void>;

if (DATABASE_URL) {
  const client = postgres(DATABASE_URL);
  db = drizzlePostgres(client, { schema });
  await migratePostgres(db, { migrationsFolder: './drizzle' });
  cleanup = () => client.end();
} else {
  const client = new PGlite(PGDATA_DIR);
  db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: './drizzle' });
  cleanup = () => client.close();
}

export { db, cleanup };