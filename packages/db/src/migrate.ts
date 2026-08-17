import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import * as schema from './schema/index.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}

const client = postgres(databaseUrl);
const db = drizzle(client, { schema });

async function runMigrations() {
  try {
    console.log('Running migrations...');
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('Migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await client.end();
  }
}

runMigrations();