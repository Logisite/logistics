#!/usr/bin/env tsx
// Minimal PGlite socket server with reduced memory footprint.
// Boots once, stays in background, serves test suites over TCP.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { postgis } from '@electric-sql/pglite-postgis';

const PORT = Number(process.env.PGLITE_PORT ?? 5432);
const DB_DIR = process.env.PGLITE_DB ?? './test-pgdata-pglite';

const pg = await PGlite.create({
  dataDir: DB_DIR,
  initialMemory: 128 * 1024 * 1024,
  extensions: { postgis },
  postgresqlconf: [
    'shared_buffers=16MB',
    'work_mem=4MB',
    'maintenance_work_mem=32MB',
    'effective_cache_size=64MB',
  ],
});

const server = new PGLiteSocketServer({
  db: pg,
  port: PORT,
  host: '127.0.0.1',
});

await server.start();

const connStr = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
console.log(`pglite-ready:${connStr}`);

const shutdown = async () => {
  await server.stop();
  await pg.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
