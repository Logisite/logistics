import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import postgres from 'postgres';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';

import * as schema from '@logistics/db';

const DATABASE_URL = process.env.DATABASE_URL;
const PGDATA_DIR = './test-pgdata';
const MIGRATIONS = new URL('../../../packages/db/drizzle', import.meta.url).pathname;

export interface TestDbOptions {
  memory?: boolean;
}

export async function createTestDb(options: TestDbOptions = {}) {
  if (DATABASE_URL) {
    const client = postgres(DATABASE_URL);
    const db = drizzlePostgres(client, { schema });
    await migratePostgres(db, { migrationsFolder: MIGRATIONS });
    return { db, cleanup: () => client.end() };
  }

  const client = new PGlite(options.memory ? undefined : PGDATA_DIR);
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: MIGRATIONS });
  return { db, cleanup: () => client.close() };
}