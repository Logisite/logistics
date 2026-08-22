#!/usr/bin/env tsx
// Reset the integration-test database to a blank state.
// Drops the public + drizzle schemas so the next migrate replays from zero.
import postgres from 'postgres';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';

const sql = postgres(DATABASE_URL, { max: 1 });

await sql`DROP SCHEMA IF EXISTS public CASCADE`;
await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
await sql`CREATE SCHEMA public`;

await sql.end();
console.log(`reset-db ok (${DATABASE_URL})`);
